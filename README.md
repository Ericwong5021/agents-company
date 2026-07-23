<div align="center">

# Agent Company

**A local-first company of AI agents that can organize, govern, and improve itself around your goals.**

You set the direction. The company forms the right team, delivers verifiable results, and brings back only the decisions that need you.

[中文](README.zh.md) · [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md) · [PRD](docs/Agent%20Company%20产品%20PRD.md) · [Docs](docs/README.md)

</div>

> [!IMPORTANT]
> Agent Company is an in-development **Pre-Public** product. The local Control Plane, real board conversation, shared WebUI, Electron shell, agent runtime, and governance foundations exist. Domain-neutral delivery, desktop background lifecycle, strict private spaces, and the complete Agent life layer are still being implemented. Target behavior is defined by the product documents; current gaps are recorded in the implementation plan.

## What it is

Agent Company lets one person operate a persistent AI organization on their own computer. It is not a fixed group of specialist bots and is not limited to programming. Agents interpret a goal, form temporary responsibilities and capability combinations, coordinate in group conversations, govern risky actions, and produce evidence-backed results across domains.

The product has three inseparable layers:

| Layer | Responsibility |
|---|---|
| Work | Goals, group collaboration, execution, artifacts, validation, and delivery |
| Governance | Charter, delegation, approval policy, gates, reputation, recovery, and audit |
| Life | Persistent identity, relationships, private space, reflection, ambient activity, and Dreaming |

## Product principles

- **Dynamic self-organization.** Users state goals; the company decides what responsibilities, agents, tools, and validators are needed. Capability packs do not become permanent specialist teams.
- **Self-governance with human authority.** Internal work can proceed autonomously within policy, while consequential external actions, privacy boundaries, and unresolved product choices remain governed.
- **Group-chat first.** The main conversation carries conclusions, decisions, risks, approvals, and deliveries. Threads reveal work logs, artifacts, previews, attempts, and nested tool details.
- **Visible failures.** Failed attempts, their causes, changed strategy, and recovery state remain traceable instead of disappearing behind a polished final answer.
- **Visual quality is product capability.** Marvis is an important UI reference for office atmosphere, legible characters, activity states, and layered results. Agent Company adapts those strengths to a multi-agent group workspace.
- **Real employee presence.** Employee cards project actual work, waiting, review, collaboration, roaming, socializing, reflection, and recovery events. Ambient activity can create relationships, cultural understanding, proposals, and personality growth. Future 2D/3D office views reuse the same state contract.
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

The codebase has completed the shared app shell, local company bootstrap, and a real persistent board conversation with source Threads. Current work focuses on the Agent Execution Kernel and a governed, domain-neutral delivery loop. Desktop background lifecycle, Agent Home/private spaces, richer ambient life, and release hardening follow in later milestones.

See the [implementation plan](docs/product-design/implementation-plan.md) for the current evidence, gaps, milestones, and release gates.

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
- [Implementation Plan](docs/product-design/implementation-plan.md): current facts, gaps, milestones, and gates
- [Documentation Index](docs/README.md): authority order and maintenance rules

## License

The source code is licensed under the [Apache License 2.0](LICENSE). Use is also subject to the [Use Restrictions](USE_RESTRICTIONS.md).
