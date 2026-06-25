# Implementation Plan: Agent Company Product Phases

> Based on: `docs/product-design/00-overview.md` through `08-product-phases.md`
> Current state: P0 (Execution Foundation) completed
> Target: R1 first-ship (P0-P5 complete, Local/Web open-source)

---

## Current Codebase Inventory

### Already Built (can be leveraged)

| System | Location | Coverage |
|--------|----------|----------|
| Agent model (native + configurable) | `src/agent/`, `src/company-agent/` | CRUD, templates, permissions, modes |
| Session model | `src/session/` | CRUD, parent/child, context inheritance |
| Actor system | `src/actor/` | spawn/subagent, lifecycle, context modes, completion gate |
| Group Session (multi-agent chat) | `src/group-session/` | Round-based fan-out, context injection |
| Inbox (inter-actor messaging) | `src/inbox/` | send/drain, wake-on-delivery, 7-day GC |
| Task system | `src/task/` | CRUD, status transitions, completion gate |
| Workflow runtime | `src/workflow/` | QuickJS sandbox, concurrency, nested workflows |
| Database (16+ tables) | `src/*/sql.ts` | Drizzle SQLite, full schema |
| Config system | `src/config/` | Hierarchical JSONC, agent/model/permission |
| Workspace / Control Plane | `src/control-plane/` | Adaptor pattern, worktree, SSE sync |
| TUI | `src/cli/cmd/tui/` | 130+ files, SolidJS, shell/routes/dialogs/i18n |
| Server API | `src/server/` | Hono, 20+ route groups |
| Memory (FTS5) | `src/memory/` | File-based search, reconcile |
| Team schema (skeleton) | `src/team/` | Types only, no service/persistence |

### Not Yet Built

- ContextResolver (scope x classification x clearance)
- Attention modes (idle/reactive/divergent/focused)
- Thread model (concurrent execution units per agent)
- Organizational file tree (public/groups/agents three-layer)
- Delegate/Reply/Propose primitives as named APIs
- Recursive delegation with depth limits
- Failure protocol (approach attempts + fix iterations + escalation)
- Admission grading (task-rating-aware review standards)
- Reputation/honor score system
- Bottom-up proposal system
- DRI decision rules
- Trust dial
- Token full-chain statistics
- Non-coding work type adapters

---

## Phase Plan

### P1 — Execution Model + Multi-Agent

**Goal**: Agent = persistent file bundle, Model = transient engine, Thread = concurrency unit. Multiple agents run concurrently with per-thread state tracking.

**Depends on**: P0 (done)

#### P1.1 — Agent File Bundle

Transform `CompanyAgent` from DB-only to filesystem-backed persistent identity.

| Task | Detail |
|------|--------|
| Agent filesystem layout | `workspace/agents/<agent-id>/` with `soul.md`, `instruct.md`, `memory/`, `skills/`, `relationships.md`, `kanban.md` |
| soul.md schema | Name, role, responsibilities, org belonging, work style — stable identity |
| instruct.md schema | Evolvable instructions: how to judge, communicate, when to escalate |
| Memory directory | Private memories: work records, lessons, reflections (leverage existing FTS5 memory) |
| Skills directory | Private skills: reusable capabilities crystallized from experience |
| relationships.md | Colleague relationships: collaboration preferences, communication style, trust level |
| kanban.md | Personal task view: current projects, todos, progress |
| CompanyAgent ↔ file sync | On create: generate file bundle from template. On update: sync DB ↔ files. On read: prefer files for prompt injection |
| Idle cost design | File-bundle agents cost near-zero tokens when idle (no active thread) |

#### P1.2 — Thread Model

Introduce the concept of concurrent execution threads per agent identity.

| Task | Detail |
|------|--------|
| Thread schema (DB) | `thread` table: id, agent_id, kind (primary/reactive/ambient), status, started_at, budget |
| Primary thread | Focused/divergent mode, exclusive isolated workspace, max 1 per agent |
| Reactive thread | Response mode, independent scratch, short run, light budget, multiple per agent (rate-limited) |
| Ambient thread | Idle mode, read-only exploration, very low frequency, scheduler rate-limited |
| Per-agent activity registry | Current threads + what they're doing + status. Check before assigning work |
| AgentStatus upgrade | From single enum → per-thread status + agent-level rollup |
| File bundle write serialization | Concurrent threads communicate via persistent files at startup only; primary has exclusive workspace; reactive reads-only or writes to scratch; memory/kanban writes serialized |

#### P1.3 — Concurrency & Workstation

| Task | Detail |
|------|--------|
| Multi-agent CRUD in TUI | Create, start, stop, configure multiple agents from TUI |
| Workstation status view | Show all agents, their threads, status, current task |
| Agent spawn integration | `actor.spawn` gains thread-awareness (which thread kind, which agent identity) |
| Session ↔ Thread binding | Session gains `thread_id` foreign key; thread owns one or more sessions |

**Acceptance**: 3+ agents run concurrently. One agent can respond to a colleague (reactive thread) while focused on main task (primary thread).

---

### P2 — Organizational Context Foundation

**Goal**: Context injection upgraded to org information architecture × classification × access intersection. Agents see what they're authorized to see based on their position in the org tree.

**Depends on**: P1

**Key insight from design doc**: P2 MUST come before P3 — without directory/roles/clearance, agents cannot meaningfully collaborate.

#### P2.1 — Three-Layer File Tree

| Task | Detail |
|------|--------|
| Workspace directory structure | `workspace/public/` (org-level), `workspace/groups/<project-id>/` (team-level), `workspace/agents/<agent-id>/` (individual-level) |
| Public directory | `org/profiles/`, `org/structure.md`, `policy/safety-redlines.md`, `policy/collaboration.md`, `facilities/skills.md`, `board/strategy.md`, `board/projects.md`, `minutes/` |
| Groups directory | Dynamically created on team formation; contains project shared context, squad minutes, project resources |
| Front-matter schema | Every document has `scope` (public/group/private), `classification` (public/internal/confidential/restricted), `owner`, `updatedBy` |
| Bootstrap | On first run, scaffold the directory tree from templates. On agent creation, scaffold agent file bundle |

#### P2.2 — Clearance & Access Control

| Task | Detail |
|------|--------|
| Clearance derivation | Base clearance from position in org tree (department + rank). Relationship edges add/remove local access |
| Org structure definition | Config-driven org tree: departments, roles, reporting lines. Stored in `workspace/public/org/structure.md` |
| Access gate | `Agent can see doc <==> doc.scope covers Agent AND Agent.clearance >= doc.classification` |
| Relationship edges | Private channels grant +1 level. External collaborators get -1 level. Delegation channels grant delegate access |
| Audit on access | Every cross-agent document access fires an audit event |

#### P2.3 — ContextResolver

The single context gateway. All memory, skills, messages, and modes pass through it.

| Task | Detail |
|------|--------|
| Resolution flow | (1) Scan three-layer doc tree → (2) Filter by scope × clearance (hard boundary) → (3) Soft focus by mode-profile → (4) Aggregate inbox + memory → (5) Truncate by relevance + token budget → (6) Expose authorized tools |
| Token tiers | Standing summary (directory one-liner, safety red line, current project — injected every time) vs. on-demand pull (deep doc content via `read_doc`) |
| Inject vs explore | `visible = access-filter(scope ∩ clearance ± relationships)` is hard boundary. `injected = visible ∩ mode-profile(attention)` is soft focus. Mode never expands access |
| read_doc primitive | Agent calls `read_doc(path)` to pull authorized documents on demand. Fires audit event |
| Directory summary in instruct | Agent's `instruct.md` auto-includes a directory summary of what's visible to them |

#### P2.4 — Minimal Interaction Primitives

| Task | Detail |
|------|--------|
| AgentMessage schema | ID, FromAgentID, ToAgentID, Kind (fyi/request/reply/proposal), Body, Classification, ThreadID, RootNeedID, IssueID, InReplyTo, Depth |
| message_agent (FYI) | Inform, no task created. Creates message + fires event. Addressing by name/role |
| delegate (Request) | Delegate task. Creates message + child task. Depth +1 per delegate. Addressing by name/role |
| reply | Task completion flow-back. Auto-creates message to original requester. Fires event + marks unread |
| Inbox integration | Leverage existing inbox system; extend with AgentMessage fields (RootNeedID, Depth, Kind) |
| Unread injection | On agent startup, drain inbox + inject unread messages into context (reactive mode) |

**Acceptance**: Different clearance yields different visibility. Instruct contains directory summary. Delegate resolves target by name. Inbox delivers FYI/reply across agents.

---

### P3 — Interaction + Recursive Delegation

**Goal**: Requirements flow through the organization via recursive decompose → delegate → admit/escalate. Full end-to-end from board roundtable to tool-layer delivery.

**Depends on**: P2

#### P3.1 — Organizational Layers

| Task | Detail |
|------|--------|
| Layer definitions | Board roundtable → Department heads → Project team (Leader) → Execution layer → Tool layer |
| Role assignment | Each agent gets a layer role via `soul.md` (org belonging + rank). Determines delegation authority and context scope |
| Task rating | Company-level (board roundtable), Project-level (board member → department), Individual-level (department → project team). Entry point varies, pipeline is the same |
| No-skip-level enforcement | Delegate depth increments per hop. Validate target is exactly one level down from sender |
| MAX_DELEGATION_DEPTH | Default 5 (org tree depth). Over-limit rejected with error feedback |
| Self-delegation guard | `to == from` rejected |

#### P3.2 — Recursive Decompose-Delegate-Admit

| Task | Detail |
|------|--------|
| Decompose | Non-leaf nodes decompose goals into sub-tasks. Uses divergent attention mode |
| Recruit/Delegate | Leader recruits team members from available agents, delegates tasks. Uses `delegate` primitive |
| Admission check | On child task completion, leader evaluates against acceptance criteria. Uses focused attention mode |
| Escalation | Two approaches both fail → carry results + findings to superior. Superior can: accept with known limitations, relax standards, supply context, assign stronger personnel |
| Bounded retries | Max 2 approach attempts per level (fundamentally different strategies). Fix iterations bounded by convergence budget |
| Failure bubbling | Only when it bubbles to the board and still can't solve is it a failed project. Board only sees what bubbles up |
| Full-chain report | Failed projects get complete flow log + all-level approaches for board retrospective |

#### P3.3 — Admission Grading

| Task | Detail |
|------|--------|
| Task-rating-aware standards | Company-level = strong model + cross-vendor + simulation. Project-level = medium. Individual-level = lightweight |
| Actionable findings | Review must give "reject: these 3 items + how to verify", not just "no good" |
| Shift-left self-check | Execution layer runs self-check before submission. Greatly reduces rejection rate |
| Approval flow | Submits artifact → reviewer evaluates → approve (gate passed) or reject (with findings for fix iteration) |

#### P3.4 — Work Type Abstraction

| Task | Detail |
|------|--------|
| Universal contract | `spec + workflow → tool output → admission`. Isomorphic across all work types |
| Coding adapter | Already exists (P0). Isolated workspace + PR + test/build/lint |
| **Decision/Planning adapter (优先)** | Diverge + evaluate tools → plan/recommendation. Verification = multi-plan comparison. 验证董事会圆桌流程 |
| Research adapter | Search/browse/crawl tools → report artifact. Verification = source tracing + cross-validation |
| Writing adapter | Writing tools → manuscript artifact. Verification = rubric review + fact-check |
| Design adapter | Design tools → design assets. Verification = rendering + visual review |
| Analysis adapter | Data/spreadsheet tools → model/analysis. Verification = recalculation + assumption audit |

**Acceptance**: One requirement runs end-to-end from roundtable through delegation to tool-layer delivery and admission. At least one non-coding work type can deliver + admit.

---

### P4 — Governance + Learning

**Goal**: Organization self-evaluates, self-evolves, proactively proposes. Reputation drives routing. Token consumption is visible.

**Depends on**: P3

#### P4.1 — Reputation System

| Task | Detail |
|------|--------|
| Reputation schema | Per-agent score with history. Also rolls up to org level (departments/project teams) |
| Automatic scoring | Admission pass/fail, fix iteration count, approaches used, red line violations, token efficiency vs estimate |
| Superior rubric | Subjective scoring against fixed criteria (minority of cases) |
| Difficulty weighting | Partial success on hard tasks shouldn't penalize more than easy tasks |
| Reviewer accountability | Work that passes review but is later found bad penalizes the reviewer |
| Decay/recency | Reflects recent performance, recoverable, not a life sentence |
| Score in public profile | Written into `workspace/public/org/profiles/<agent-id>.md` for routing/recruitment visibility |
| Reputation → routing | High score → important work, low score → minor work or increased supervision |

#### P4.2 — Decision Rules & Org Changes

| Task | Detail |
|------|--------|
| DRI system | Every decision domain has one Directly Responsible Individual. Decides after hearing input, no voting |
| Advisory voting | Voting is advisory only. Higher reputation carries more weight |
| Bounded debate | Limited rounds; at deadline the DRI decides |
| Cross-level appeal | Can appeal one level up; top is final. Allows real pushback |
| Minutes | Decisions + dissent recorded in `workspace/public/minutes/` |
| Recruitment | Forming temporary group from existing agents. Leader proposes, superior approves |
| Staffing | Detect skill gap → trigger "hiring" proposal → superior approval → onboard (instantiate file bundle) |
| Layoff | Archive, not delete. Preserves work records, allows rehire |

#### P4.3 — Bottom-Up Proposals

| Task | Detail |
|------|--------|
| Propose primitive | Mirror of delegate. Creates message flowing upward. Superior adopts/shelves/rejects |
| Gate 1 (experiment) | Self-service within authority in isolated workspace |
| Gate 2 (production) | Superior approval for anything affecting production or product direction |
| Trigger sources | Rhythm (weekly meetings), milestones (project phase transitions), environment scanning (idle agent exploration) |
| Learning loop | Environment scan → proposal → authorized experiment → results → superior approval → crystallize into skill |
| Experience → skill crystallization | Deep state run ends → reflection writes memory → repeated tasks → crystallize into skill → written to public facility |

#### P4.4 — Token Governance & Observability

| Task | Detail |
|------|--------|
| Full-chain token stats | Visible from roundtable through all levels to execution. Each level shows token consumption per project |
| Emergency stop | Manual project block when token consumption is out of control |
| Audit trail | Every cross-agent access, message, admission, escalation is an audit event threaded by RootNeedID |
| Trust dial | New users start with more approval gates (low auto-admission threshold). As trust builds, autonomy increases |

**Acceptance**: Subordinates can proactively propose and adopted proposals become tasks. Reputation affects agent selection. Projects can be blocked. Token full-chain visible.

---

### P5 — Experience and Space Closure

**Goal**: Organization, collaboration, reputation, and information flow rendered in the TUI. Users can watch agents collaborate, request approval, and deliver.

**Depends on**: P0 activity contract + P3/P4 events
**Special**: Backend-independent UI items can run parallel with P1-P4

#### P5.1 — Office Layout & Presence

| Task | Detail |
|------|--------|
| Office layout engine | Grid/space-based layout for agent workstations. Editable, persistent across restarts |
| Agent presence rendering | Each agent shown at their workstation with status (idle/thinking/speaking/working/error) |
| Layout editor | User can rearrange workstations, add decoration, define zones (departments) |
| Map view | Zoomable view of the entire org with departments, teams, agents |

#### P5.2 — Collaboration Visualization

| Task | Detail |
|------|--------|
| Delegation tree view | Recursive layer tree showing delegation chain from board to leaf |
| Thread connections | Visual lines showing active threads between agents |
| Meeting visualization | Fan-in view of multi-agent meetings converging into one thread |
| Real-time updates | Office view updates as agents work (via SSE/WebSocket events) |

#### P5.3 — Board Roundtable UX

| Task | Detail |
|------|--------|
| Roundtable entry | User enters as board chair. Sees C-suite agents around the table |
| Speaking interaction | User speaks, agents respond. Board discussion flows naturally |
| Task dispatch | User can dispatch tasks from roundtable. Watch delegation cascade through org |
| Approval prompts | When agents need approval, prompt appears in roundtable. User approves/rejects |

#### P5.4 — Onboarding & Fixtures

| Task | Detail |
|------|--------|
| Onboarding flow | Welcome → provider setup → interview → founding team creation (enhanced from existing) |
| Org template | Pre-built org structures (startup, enterprise, etc.) with agent templates |
| Replay fixtures | Sample scenarios showing org collaboration end-to-end |
| Demo mode | Pre-populated office with agents doing visible work |

**Acceptance**: Dispatch task → watch characters collaborate/request approval → see delivery. Org structure and information flow readable in office view.

---

## Implementation Order & Dependencies

```
P0 (DONE)
  │
  ├─ P1.1 Agent File Bundle
  ├─ P1.2 Thread Model
  └─ P1.3 Concurrency & Workstation
       │
       ├─ P2.1 Three-Layer File Tree
       ├─ P2.2 Clearance & Access Control
       ├─ P2.3 ContextResolver
       └─ P2.4 Minimal Interaction Primitives
            │
            ├─ P3.1 Organizational Layers
            ├─ P3.2 Recursive Decompose-Delegate-Admit
            ├─ P3.3 Admission Grading
            └─ P3.4 Work Type Abstraction (Decision/Planning 优先)
                 │
                 ├─ P4.1 Reputation System
                 ├─ P4.2 Decision Rules & Org Changes
                 ├─ P4.3 Bottom-Up Proposals
                 └─ P4.4 Token Governance & Observability
                      │
                      └─ P5.1-P5.3 (Office Layout, Collaboration Viz, Roundtable UX)

═══════════════════════════════════════════════════════
P5.4 — 引导流程 + 组织模板（与 P1-P4 并行开发，后端无关）
═══════════════════════════════════════════════════════
```

## Cross-Cutting Concerns

### Leverage Existing Systems

| Existing System | Reuse For |
|----------------|-----------|
| `CompanyAgent` | Extend to full Agent file bundle (P1.1) |
| `Actor.spawn` | Extend with thread-awareness (P1.2) |
| `Inbox` | Extend with AgentMessage fields — RootNeedID, Depth, Kind (P2.4) |
| `GroupSession` | Evolve into board roundtable + meeting primitive (P3.1, P5.3) |
| `Task` | Add parent chain for delegation depth tracking (P3.2) |
| `Memory (FTS5)` | Agent private memory + experience sedimentation (P1.1, P4.3) |
| `Workflow` | Work type adapters wrap workflow execution (P3.4) |
| `Config` | Org structure, clearance, role definitions (P2.2) |
| `TUI` | Office layout, presence, roundtable UX (P5) |

### New DB Tables Needed

| Phase | Table | Purpose |
|-------|-------|---------|
| P1 | `thread` | Concurrent execution units per agent |
| P1 | `agent_bundle` | Agent file bundle metadata (links DB agent to filesystem) |
| P2 | `clearance` | Per-agent clearance level + relationship edges |
| P2 | `agent_message` | Inter-agent messages (extends inbox concept) |
| P3 | `admission` | Admission records with grading criteria and results |
| P4 | `reputation_score` | Per-agent reputation with history |
| P4 | `proposal` | Bottom-up proposals with adopt/shelve/reject outcome |
| P4 | `audit_event` | Full audit trail threaded by RootNeedID |

> 注：组织架构（部门、角色、汇报关系）存储在 `agent-company.jsonc` 配置文件中，不需要独立 DB 表。

### Design Decisions (Confirmed)

1. **Org structure source of truth** → **仅配置文件**: 扩展 `agent-company.jsonc` 增加组织树配置（部门、角色、汇报关系），单一数据源
2. **Thread ↔ Session relationship** → **Thread 1:N Session**: Thread 是长期存在的执行上下文（工位），Session 是其中的一次次对话（工作会话）。符合"身份 vs 执行"解耦的设计哲学
3. **ContextResolver location** → **独立模块** `src/context-resolver/`: 横切关注点，被 `session/prompt.ts`、`group-session/`、`actor/spawn.ts` 等多处调用，职责清晰
4. **Reputation storage** → **独立表** `reputation_score`: 支持历史追踪、复杂查询（分数趋势、排序），与 `company_agent` 解耦，未来可扩展到团队/部门评分
5. **Non-coding work types** → **决策/规划优先**: 验证董事会圆桌流程，其次研究调查
6. **P5 parallelism** → **引导流程 + 组织模板**: 增强引导流程、预置组织模板、演示模式，可在 P1-P4 期间并行开发

---

## R1 First-Ship Acceptance Criteria (from design doc)

1. **Multi-Agent**: Create and run multiple agents concurrently, distinguishable in office
2. **Workspace**: Each agent has independent workspace and instruct; task strategy configurable
3. **Flow**: At least one cross-agent orchestration end-to-end
4. **Organization**: Basic org structure and agent belonging configurable, reflected in office view
5. **Space**: Office layout editable, persistent, survives restart
6. **Experience**: Rendering and presence interaction cover dispatch, approval, delivery main path
7. **Delivery**: PR or local diff review merge loop; tasks cancellable
