<div align="center">

# Agent Company

**A local-first operating system for your own AI software company.**

You set the direction. The company turns it into an accountable, testable delivery—and brings back only the decisions that are truly yours.

[中文](README.zh.md) · [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md) · [PRD](docs/Agent%20Company%20产品%20PRD.md) · [Docs Index](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company is converging toward its **Pre-Public** release. The repository already contains substantial agent-runtime, governance, TUI, WebUI, and Electron foundations, but the complete IM-first desktop journey, tray lifecycle, strict private spaces, and persona-level Dreaming are target work—not yet a finished public product. The documents above define the target; the code and implementation plan record current gaps.

## What Agent Company Is

Agent Company lets one person run a persistent AI organization on their own computer.

Instead of manually orchestrating a set of disposable agents, you speak with a small board. The board turns broad goals into an acceptably scoped Project Charter, forms a temporary project team, delegates work, reviews evidence, and escalates only material decisions.

The product has three inseparable layers:

| Layer | Responsibility |
|---|---|
| Work | IM collaboration, software projects, code, tests, review, and delivery |
| Governance | Organization, delegation, approval policy, gates, reputation, and audit |
| Life | Persistent identity, private space, social relationships, reflection, and Dreaming |

## Product Direction

The intended product formula is:

> Multica-level visual finish + Bloome-style IM-first interaction + Agent Company autonomous governance and agent personhood.

That means:

- **IM-first, not Kanban-first.** Conversation is the primary surface; tasks and boards are derived views.
- **High signal by default.** The main conversation shows conclusions, decisions, risks, approvals, and deliveries. Full collaboration expands in Threads; tool logs nest one level deeper.
- **A minimal fixed board, then a dynamic organization.** A new company starts with a CEO, CTO, and Product Lead. Departments and project roles appear only when real work requires them.
- **Autonomy with configurable approval.** Internal decomposition, delegation, implementation, tests, and agent review normally run automatically. Users choose autonomous, balanced, or strict approval levels.
- **Local-first and always available.** Desktop and browser share one WebUI backed by a local Control Plane. The desktop target stays in the system tray/status bar and keeps authorized work running after the window closes.
- **Software development first.** The first public release optimizes one project around one primary Git repository. Other domains come later.

## What Makes It Different

### The board must make goals executable

Passing a vague, untestable goal directly to an execution agent is a board failure. Before work begins, the board must produce a Project Charter with value, deliverables, acceptance criteria, scope, constraints, risks, milestones, a DRI, and unresolved user decisions.

### Temporary agents are candidates, not throwaways

Project agents return to a candidate pool. Selection reasons, quality, reputation, cost, speed, and specialties accumulate across projects. Repeated high-value work can justify promotion to a permanent position.

### Permanent agents have lives as well as jobs

A permanent agent has separate spaces:

```text
agents/<id>/
  private/       # SOUL, dreams, journal, interests, private memory
  professional/  # ROLE, instructions, career, skills, work memory
  public/        # PROFILE, contributions, shared skills
```

The agent can write its private space. The user can read it but cannot edit it. No other agent—including managers and board members—can read it. PROFILE is an agent-curated card with system-signed employment facts beside it.

Dreaming is distinct from task reflection: it is a private, low-frequency synthesis of real experiences that can produce a versioned SOUL change, but can never change the agent's formal role, permissions, company constitution, or project code.

## Software Delivery Contract

The first public release follows one strict delivery loop:

```text
Goal
→ Project Charter
→ Project room and dynamic team
→ Worktree
→ Implementation and tests
→ Agent Review
→ Policy-driven approval
→ Merge
→ Verify main branch
→ Destroy Worktree
→ Reflection and agent lifecycle updates
```

Worktrees are configurable and on by default. When enabled, they cannot be destroyed before merge and main-branch verification. Conflicts return to review; failed and cancelled worktrees remain available for explicit disposition.

## Architecture

```text
Electron / Browser / TUI
          │ local API + event stream
          ▼
Local Control Plane
  ├─ Agent / Thread / Workflow runtime
  ├─ Governance / Approval / Audit
  ├─ Context Resolver / Privacy boundaries
  ├─ Project / Admission / Worktree delivery
  ├─ SQLite
  ├─ Versioned agent identity files
  └─ Git repositories and worktrees
```

The current codebase evolves in place:

| Package | Role |
|---|---|
| `packages/app` | Shared SolidJS + Vite WebUI |
| `packages/desktop` | Electron desktop shell and local server host |
| `packages/opencode` | Bun/Effect/Hono runtime, Control Plane services, SQLite, Git, workflows, and TUI |

The renderer clients must not mutate SQLite or identity files directly. The Control Plane owns authenticated writes, recovery, and event ordering.

## Existing Foundation

The repository already includes reusable implementations for sessions, actors, group sessions, autonomous bidding, threads, company projects, delegation, admission, organization, reputation, trust levels, audit events, token governance, workflows, Control Plane workspaces, and Git worktrees.

The active work is product integration and hardening: the shared IM workbench, desktop lifecycle, policy inheritance, strict worktree governance, candidate careers, three-space privacy, Direct messages, and persona-level Dreaming. See the [implementation plan](docs/product-design/implementation-plan.md) for the verified inventory and sequence.

## Development

Requirements: Bun 1.3.x and the platform dependencies needed by Electron/node-pty.

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
```

Run the current TUI/runtime development entry:

```bash
bun run dev
```

Run the shared WebUI or Electron shell:

```bash
bun run dev:web
bun run dev:desktop
```

Typecheck and test from package directories, never from the repository root:

```bash
cd packages/opencode
bun typecheck
bun test
```

Repository conventions are in [AGENTS.md](AGENTS.md).

## Current Release Path

1. Product and terminology baseline
2. Local Control Plane and tray/status-bar lifecycle
3. IM-first company, project rooms, and Threads
4. Board Charter, approval policy, and software delivery closure
5. Candidate careers, Agent Home, privacy, Direct, and Dreaming
6. Windows/macOS Pre-Public hardening and first public release

The first release intentionally excludes multi-user cloud hosting, mobile apps, multi-repository projects, general-industry delivery, Kanban-first project management, and pixel-office simulation.

## Documentation

- [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md)—non-negotiable product principles and boundaries
- [Product PRD](docs/Agent%20Company%20产品%20PRD.md)—public-release requirements and acceptance
- [Product Design Overview](docs/product-design/00-overview.md)—system model and document map
- [Implementation Plan](docs/product-design/implementation-plan.md)—current foundation, gaps, and delivery workstreams
- [Documentation Index](docs/README.md)—authority order and historical-document status

## License

The source code is licensed under the [Apache License 2.0](LICENSE). Use is also subject to the [Use Restrictions](USE_RESTRICTIONS.md).
