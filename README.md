<div align="center">

# Agent Company

**A local-first company of AI agents that can organize, govern, and improve itself around your goals.**

You set the direction. The company forms the right team, delivers verifiable results, and brings back only the decisions that need you.

[中文](README.zh.md) · [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md) · [PRD](docs/Agent%20Company%20产品%20PRD.md) · [Docs](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company is an in-development **Pre-Public** product, currently in stage R0 of an [experience refactor](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md) that rebuilds the user-facing product layer on top of the existing Control Plane. The local Control Plane, agent runtime, governance and delivery foundations, Electron shell, and shared WebUI exist. The group-chat workspace, artifact and delivery experience, desktop background lifecycle, strict private spaces, and the Agent life layer are **not** built yet — several are deliberately frozen until the delivery loop is verified.
>
> Everything below describes **target behavior** defined by the product documents, not shipped capability. For what actually exists today, read the [implementation plan](docs/product-design/implementation-plan.md); for what is being built now, read the experience refactor plan.

## What it is

Agent Company lets one person operate a persistent AI organization on their own computer. It is not a fixed group of specialist bots and is not limited to programming. Agents interpret a goal, form temporary responsibilities and capability combinations, coordinate in group conversations, govern risky actions, and produce evidence-backed results across domains.

The product has three inseparable layers:

| Layer | Responsibility | Status |
|---|---|---|
| Work | Goals, group collaboration, execution, artifacts, validation, and delivery | Being rebuilt (R0–R3) |
| Governance | Charter, delegation, approval policy, gates, reputation, recovery, and audit | Foundations in place |
| Life | Persistent identity, relationships, private space, reflection, ambient activity, and Dreaming | Frozen until the delivery loop is verified |

## Product principles

- **Dynamic self-organization.** Users state goals; the company decides what responsibilities, agents, tools, and validators are needed. Capability packs do not become permanent specialist teams.
- **Self-governance with human authority.** Internal work can proceed autonomously within policy, while consequential external actions, privacy boundaries, and unresolved product choices remain governed.
- **Group-chat first.** The main conversation carries conclusions, decisions, risks, approvals, and deliveries. Threads reveal work logs, artifacts, previews, attempts, and nested tool details.
- **Visible failures.** Failed attempts, their causes, changed strategy, and recovery state remain traceable instead of disappearing behind a polished final answer.
- **Visual quality is product capability.** Marvis is an important UI reference for office atmosphere, legible characters, activity states, and layered results. Agent Company adapts those strengths to a multi-agent group workspace.
- **Real employee presence.** Employee cards read one activity projection derived from real runs, never a decorative animation. Today that projection covers working, waiting, recovering, and failure states; roaming, socializing, reflection, and the relationships and personality growth they feed belong to the frozen Life layer. Future 2D/3D office views must reuse the same state contract rather than inventing activity.
- **Local-first.** Browser and desktop consume one local Control Plane through the same shared WebUI. Electron provides the persistent local product experience.
- **Domain-neutral core, deep adapters.** Research, documents, local applications, and software delivery share one company model. Software adds strict repository, Worktree, review, merge, and verification rules without defining the whole product.

## Architecture

```text
Electron / Browser
          │ local API + event stream
          ▼
Local Control Plane
  ├─ Company / Conversation services
  ├─ Agent Execution Kernel / Workflow runtime
  ├─ Governance / Approval / Audit
  ├─ Delivery / Domain adapters / Managed resources
  ├─ Context Resolver / Privacy boundaries
  ├─ SQLite
  └─ Versioned agent identity files
```

| Package | Role |
|---|---|
| `packages/app` | Shared Eve/Nuxt WebUI |
| `packages/desktop` | Electron shell, local server host, and packaging |
| `packages/control-plane` | Bun/Effect/Hono Control Plane, runtime, SQLite, Git, workflows, and internal CLI tooling |
| `packages/sdk` | Generated and hand-written client SDKs |
| `packages/ui` | Shared UI primitives |

Clients do not write SQLite, identity files, or managed resources directly. The Control Plane owns authoritative writes, event ordering, permissions, and recovery.

## Current delivery path

Current work is stage **R0 — Truthful Product Shell** of the experience refactor: real product identity, real connection state, and a user-facing state projection layer, so that what the interface claims is always backed by a fact from the Control Plane. R0 is not yet passed; its remaining blockers are human acceptance studies that automation is not allowed to substitute for.

Underneath, the Control Plane carries a company bootstrap, persistent channels and threads, an agent execution kernel with explicit skills, charter and approval governance, and worktree-based software delivery through merge and main-branch verification. The board conversation UI was removed with the Solid-to-Nuxt WebUI migration and is scheduled for rebuild in R2.

Later stages: Goal → Start (R1), controllable execution and attention (R2), verified delivery (R3), dynamic organization (R4). Desktop background lifecycle, private spaces, the Agent life layer, and release hardening follow.

- [Experience refactor plan](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md): what is being built now, in what order, and the release gates.
- [Implementation plan](docs/product-design/implementation-plan.md): current code facts, per-milestone exit criteria, and remaining gaps.

## Development

Requirements: Bun 1.3.x and the platform dependencies needed by Electron and node-pty.

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
```

```bash
bun run dev:web      # shared WebUI
bun run dev:desktop  # Electron shell
```

Run tests and type checks from the package you changed, never from the repository root:

```bash
cd packages/control-plane
bun typecheck
bun test
```

Repository conventions are in [AGENTS.md](AGENTS.md). Contribution workflow is in [CONTRIBUTING.md](CONTRIBUTING.md).

## Documentation

- [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md): durable principles and hard boundaries
- [Product PRD](docs/Agent%20Company%20产品%20PRD.md): Pre-Public requirements and acceptance
- [Product Design Overview](docs/product-design/00-overview.md): system model and topic map
- [Experience Refactor Plan](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md): current execution order (R0–R4), tasks, and release gates
- [Implementation Plan](docs/product-design/implementation-plan.md): current facts, gaps, milestone exit criteria
- [Documentation Index](docs/README.md): authority order and maintenance rules

## License

The source code is licensed under the [Apache License 2.0](LICENSE). Use is also subject to the [Use Restrictions](USE_RESTRICTIONS.md).
