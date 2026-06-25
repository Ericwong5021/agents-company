<h1 align="center">Agent Company</h1>

<p align="center"><strong>The first Agent company operating system — so anyone can run their own first Agent company.</strong></p>

<p align="center">
  <a href="README.zh.md">中文</a> | English
</p>

---

Agent Company is a governable virtual company made of AI Agents.

You're not "using a chatbot" — you're running an organization of digital employees that divides work, collaborates, reports status, seeks approval, and accumulates experience over time. A request flows through the organization: it gets understood, decomposed, delegated, executed, and reviewed, then comes back to you for the key decisions.

The repo's current focus is the **TUI (Terminal UI)**, implemented in [packages/opencode/src/cli/cmd/tui](packages/opencode/src/cli/cmd/tui). Web and App are not the current mainline and are not a default support target.

## Product Positioning

Agent Company is not about "making one model answer more questions" — it's about organizing AI into a company:

- Agents with distinct roles
- An org structure, responsibility boundaries, and reporting lines
- Meetings, discussions, tasks, artifacts, and approvals
- Observability over activity, status, risk, and blockers
- Governance: pause, resume, retry, escalate, retrospect
- Memory, reputation, and long-term accumulation — not one-shot sessions

The ideal experience:

> You state the goal; the company drives it forward. When a call is yours to make, it comes back for approval.

## Core Ideas

> See the [Product Design Overview](docs/product-design/00-overview.md)

The whole system is a recursive **decompose → delegate → admit/escalate** tree. The user discusses with the boardroom; the need is decomposed and delegated downward layer by layer. **Only leaf nodes (the tool layer) produce artifacts** (code, docs, data, designs). Non-leaf nodes turn decisions into plans into specs into orchestration, and results flow back up to be admitted (success) or escalated (failure).

- **Recursive delegation** — a fixed-depth delegation tree; every non-leaf node does the same job: decompose the goal, recruit/delegate, gate admission, escalate on failure.
- **Identity decoupled from execution** — an Agent is a bundle of persistent files (who); a Model is the engine that runs them (what's being done). The unit of concurrency is the Thread, not the Agent.
- **Information as files** — policies, strategy, projects, memory, relationships are all documents in the file system; access is governed by scope × classification × clearance.
- **Attention as cost** — four attention modes (idle / reactive / divergent / focused) jointly decide what context is injected and which model tier runs; idle uses a cheap model, focused uses a strong one.
- **Governance through records** — an emergent system isn't reproducible; every cross-Agent access, message, admission, and escalation is an audit event. The trace is the "source code" of each run.
- **Bottom-up proposals** — ideas can bubble up; the board shifts from generating tasks to filtering proposals.

## Organization

```
User ←→ Boardroom (CEO/CTO/CFO/CMO)     ← system entry = a meeting
        ↓
     Departments (business + infrastructure)   ← split goals + set acceptance criteria + form squads
        ↓
     Project squads (Leader)                   ← decompose into executable specs + recruit + gate admission
        ↓
     Execution layer                           ← match a predefined workflow + refine spec + drive tools
        ↓
     Tool layer                                ← the only layer that produces artifacts (code/search/writing/design/analysis)
```

**Strictly no level-skipping**: every layer is traversed regardless of task size; delegation depth is ~4–5 levels.

## What This Repo Is Building

Based on the PRD, the core product objects include:

| Object | Description |
|--------|-------------|
| `Workspace` | The company space — organization, tasks, meetings, artifacts, rules, and history |
| `Agent` | A digital employee with a persistent identity (soul/instruct/memory/skills/relationships/kanban), not a prompt template |
| `Thread` | The unit of concurrency — primary (focused/divergent), reactive (fragments), ambient (idle exploration) |
| `Group / Meeting` | A governable collaboration room, not just a group chat |
| `Task` | A trackable, acceptable, reviewable unit of work |
| `Artifact` | Artifacts produced by the tool layer (code/docs/data/designs), flowing up through Gates |
| `Decision` | A traceable organizational decision with rationale (DRI decides, no voting) |
| `Proposal` | A bottom-up suggestion or improvement from an Agent |

The repo's home page, interactions, and development direction will converge around these objects.

## Development Boundaries

This is not an AgentCompany compatibility release. Agent Company is rebuilt from AgentCompany foundations as a new product direction — legacy filesystem, config, and API compatibility are not preserved unless a migration bridge is explicitly requested.

- Design and implement features with a **TUI-first** workflow
- Prioritize organization, task execution, approval governance, and observability
- Don't wrap a multi-Agent system as a single opaque supervisor output
- Don't describe the design vision as a finished present state

## Repository Layout

- [packages/opencode](packages/opencode) — the current CLI and TUI
- [packages/opencode/src/cli/cmd/tui](packages/opencode/src/cli/cmd/tui) — the main TUI implementation
- [docs/product-design](docs/product-design) — product design docs (ideas, organization, modules)
- [packages/sdk/js](packages/sdk/js) — the JavaScript SDK

## Local Development

Requirements: [Bun](https://bun.sh), Node.js (used by parts of the toolchain).

```bash
bun install              # install dependencies
bun run dev              # start the main dev entry from the repo root
bun run dev:desktop      # desktop dev
bun run dev:console      # console dev
```

The CLI entry is still `mimo` — branding and command names will converge later.

### Typecheck & Test

Do not run tests or typechecks from the repo root. Run them inside a package directory:

```bash
cd packages/opencode
bun typecheck
bun test
```

### SDK

If you change the JavaScript SDK, regenerate it:

```bash
./packages/sdk/js/script/build.ts
```

## Design Principles

- An Agent should behave like a digital employee, not a one-shot model call
- A Workspace should feel like a company runtime, not a plain chat project
- Async by default; synchronous confirmation at key checkpoints
- Observability over blind automation
- Governance over surface-level efficiency

These make the TUI emphasize: who is working, what they're doing, why, where they're stuck, who's next, and when you should step in.

## Reference

- [Product Design Overview](docs/product-design/00-overview.md) (ideas, organization, module index)
- [Agent Company Product PRD](docs/Agent%20Company%20产品%20PRD.md)
- [packages/opencode/README.md](packages/opencode/README.md)

## License

Source code is licensed under the [MIT License](./LICENSE). Use of Agent Company is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).
