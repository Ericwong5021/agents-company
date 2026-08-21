<div align="center">

# Agent Company

**A local-first company of AI agents that can organize, govern, and improve itself around your goals.**

You set the direction. The company forms the right team, delivers verifiable results, and brings back only the decisions that need you.

[中文](README.zh.md) · [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md) · [PRD](docs/Agent%20Company%20产品%20PRD.md) · [Docs](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company is an in-development **Pre-Public** product. The [experience refactor](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md) still controls the R0–R4 release order. The local Control Plane, agent runtime, shared WebUI, dynamic-organization foundations, and Founder OS v1 are implemented; release acceptance, strict private spaces, and the Agent life layer remain separate work or deliberately frozen.
>
> Implemented does not mean enabled or publicly released. Founder Twin and Company Commons default to `off`, and machine Gate success does not substitute for human authorization or real-sample acceptance. See the [current Founder OS contract](docs/product-design/Founder-OS-v1.md) and [documentation index](docs/README.md).

## What it is

Agent Company lets one person operate a persistent AI organization on their own computer. It is not a fixed group of specialist bots and is not limited to programming. Agents interpret a goal, form temporary responsibilities and capability combinations, coordinate in group conversations, govern risky actions, and produce evidence-backed results across domains.

The product has three inseparable layers:

| Layer | Responsibility | Status |
|---|---|---|
| Work | Goals, group collaboration, execution, artifacts, validation, and delivery | Implemented foundations; release acceptance follows R0–R3 |
| Governance | Charter, delegation, approval policy, gates, Founder OS, recovery, and audit | Founder OS v1 implemented; higher modes remain authorization-gated |
| Life | Persistent identity, relationships, private space, reflection, ambient activity, and Dreaming | Frozen until the delivery loop is verified |

## Product principles

- **Dynamic self-organization.** Users state goals; the company decides what responsibilities, agents, tools, and validators are needed. Capability packs do not become permanent specialist teams.
- **Self-governance with human authority.** Internal work can proceed autonomously within policy, while consequential external actions, privacy boundaries, and unresolved product choices remain governed.
- **Group-chat first.** The main conversation carries conclusions, decisions, risks, approvals, and deliveries. Threads reveal work logs, artifacts, previews, attempts, and nested tool details.
- **Visible failures.** Failed attempts, their causes, changed strategy, and recovery state remain traceable instead of disappearing behind a polished final answer.
- **Visual quality is product capability.** Marvis is an important UI reference for office atmosphere, legible characters, activity states, and layered results. Agent Company adapts those strengths to a multi-agent group workspace.
- **Real employee presence.** Employee cards read one activity projection derived from real runs, never a decorative animation. Today that projection covers working, waiting, recovering, and failure states; roaming, socializing, reflection, and the relationships and personality growth they feed belong to the frozen Life layer. Future 2D/3D office views must reuse the same state contract rather than inventing activity.
- **Local-first.** The WebUI consumes one loopback-only local Control Plane and is the sole product access surface.
- **Domain-neutral core, deep adapters.** Research, documents, local applications, and software delivery share one company model. Software adds strict repository, Worktree, review, merge, and verification rules without defining the whole product.

## Architecture

```text
WebUI
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
| `packages/app` | Shared Nuxt WebUI |
| `packages/control-plane` | Bun/Effect/Hono Control Plane, runtime, SQLite, Git, workflows, and internal CLI tooling |
| `packages/sdk` | Generated and hand-written client SDKs |
| `packages/ui` | Shared UI primitives |

Clients do not write SQLite, identity files, or managed resources directly. The Control Plane owns authoritative writes, event ordering, permissions, and recovery.

## Current delivery path

The experience refactor still controls release sequencing from **R0 — Truthful Product Shell** through R4. Its machine evidence and human/public-release evidence remain distinct; consult the plan for the current release decision rather than inferring it from an implemented module.

The current product includes company bootstrap, persistent channels and threads, the Agent execution kernel, charter and approval governance, worktree-based software delivery, a real Board governance surface, Decision Center, Founder Studio and Control Center, Company Commons, Interpretations, Beliefs, and Learning Patches. These surfaces read Control Plane facts and fail closed when their service or mode is unavailable.

Founder OS v1 passed W0–W7, E0, and K0–K2 machine Gates twice on candidate `b7aca6b87ecc7722a3a3fff8b5d027cf66463fa8`. Human authorization and real-sample acceptance remain advisory and unconfirmed; no runtime mode elevation follows from that result.

- [Experience refactor plan](docs/product-design/Agent-Company-Experience-Refactor-Plan-v1.0.md): what is being built now, in what order, and the release gates.
- [Implementation plan](docs/product-design/implementation-plan.md): current code facts, per-milestone exit criteria, and remaining gaps.
- [Founder OS v1](docs/product-design/Founder-OS-v1.md): implemented architecture, surfaces, modes, and validation boundaries.

## Development

Requirements: Bun 1.3.x and the platform dependencies needed by node-pty.

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
```

```bash
bun run dev:all      # Control Plane + WebUI
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
- [Founder OS v1](docs/product-design/Founder-OS-v1.md): implemented governance and organizational-learning contract
- [Documentation Index](docs/README.md): authority order and maintenance rules

## License

The source code is licensed under the [Apache License 2.0](LICENSE). Use is also subject to the [Use Restrictions](USE_RESTRICTIONS.md).
