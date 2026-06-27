<div align="center">

# Agent Company

**The AI Company Operating System**

*Give yourself a company of AI employees — not a chatbot, an organization.*

[![npm version](https://img.shields.io/npm/v/@agents-company/cli?color=cb3837&label=npm)](https://www.npmjs.com/package/@agents-company/cli)
[![npm downloads](https://img.shields.io/npm/dm/@agents-company/cli?color=cb3837)](https://www.npmjs.com/package/@agents-company/cli)
[![license](https://img.shields.io/badge/license-MIT-blue)](./LICENSE)
[![runtime](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&logoColor=000)](https://bun.sh)
[![language](https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&logoColor=fff)](https://www.typescriptlang.org)
[![TUI](https://img.shields.io/badge/interface-TUI-00d111)](#quick-start)

[Quick Start](#quick-start) · [English](README.md) · [中文](README.zh.md) · [Design Docs](docs/product-design/00-overview.md) · [PRD](docs/Agent%20Company%20产品%20PRD.md) · [Roadmap](#roadmap)

</div>

---

## The Pitch

> **You set the direction. The company drives it forward. When it's your call, it comes back.**

You're not "using a chatbot." You're **running a virtual company**.

Agent Company is a multi-agent operating system where AI agents form a real organization — with a boardroom, departments, project squads, and execution teams. You tell the company what you want. It decomposes the goal, delegates down through the org chart, executes, reviews, and brings key decisions back to you.

```
You ←→ 🏢 Boardroom (CEO / CTO / CFO / CMO)
           ↓
        📋 Departments — split goals, set acceptance criteria
           ↓
        👥 Project Squads — decompose into executable specs
           ↓
        ⚙️ Execution Layer — drive tools, produce artifacts
```

**No shortcuts, no skip-levels.** Every request flows through the full org chart, 4-5 layers deep. Only the tool layer produces artifacts (code, docs, data, designs). Everything else is planning, orchestration, and governance.

---

## Why a "Company" and Not a "Framework"?

| | Multi-Agent Framework | Agent Company |
|---|---|---|
| Metaphor | "Prompt templates in a trenchcoat" | A virtual org with real hierarchy |
| Collaboration | Agents talk to each other | Agents have **roles, reports, and accountability** |
| Governance | None or manual | **Built-in approval gates, escalation, audit trails** |
| Identity | Stateless prompts | **Persistent agent files**: soul, memory, skills, relationships |
| User Experience | Write code to orchestrate | **Just tell the company what you want** |

---

## Features

<table>
<tr>
<td width="50%" valign="top">

### 🏛️ Boardroom Interface

Your entry point is a meeting with the board — CEO, CTO, CFO, CMO. Discuss goals, set priorities, review progress. No prompt engineering required.

</td>
<td width="50%" valign="top">

### 🔄 Recursive Delegation

Tasks decompose naturally through the org chart: Boardroom → Departments → Project Squads → Execution → Tool Layer. Each layer does exactly one thing well.

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🎯 Bidding Scheduler

Agents bid to speak based on relevance, expertise, and turn rights. No central host, no agent dominates, no voice is lost. A decentralized alternative to LLM-moderated turn-taking.

</td>
<td width="50%" valign="top">

### 🧠 Persistent Identity

Each agent is more than a prompt — they're a bundle of persistent files: **soul** (who they are), **memory** (what they've learned), **skills** (what they can do), and **relationships** (who they work with).

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📋 Task & Artifact Management

Track work through the org. Artifacts flow upward through **gates** — approved or escalated. Every decision is traceable.

</td>
<td width="50%" valign="top">

### 🔒 Governance by Design

Approval checkpoints at every level. Trust scales with performance. The system records everything — because an untraceable system is an ungovernable one.

</td>
</tr>
<tr>
<td colspan="2" align="center">

### 🖥️ Terminal-Native UI

Beautiful TUI built with SolidJS + OpenTUI. Not a web app, not a desktop wrapper — a **native terminal experience** for developers who live in the command line.

</td>
</tr>
</table>

---

## Quick Start

### Install

```bash
# Via npm
npm install -g @agents-company/cli

# Or via Bun (recommended)
bun install -g @agents-company/cli
```

### Run

```bash
agents
```

That's it. The onboarding flow walks you through:

1. **Set up your AI company** — name, industry, team size
2. **Create your founding team** — CEO, CTO, CFO, CMO
3. **Enter the boardroom** — start giving directions

### Development

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
bun run dev
```

> **Current focus is the TUI** in `packages/opencode/src/cli/cmd/tui/`. Web and App are not the current mainline.

---

## Architecture

```
User ←→ Boardroom (CEO/CTO/CFO/CMO)     ← system entry = a meeting
        ↓
     Departments (business + infrastructure)
        ↓
     Project squads (Leader)
        ↓
     Execution layer
        ↓
     Tool layer                           ← the only layer that produces artifacts
```

**Key principles:**

| Principle | What it means |
|-----------|---------------|
| **Recursive delegation** | Every non-leaf node decomposes → delegates → gates results |
| **Identity ≠ Execution** | Agent files are "who"; Model is "how they run" |
| **Information as files** | Policies, strategy, memory are all documents, governed by scope × clearance |
| **Attention as cost** | Four modes (idle/reactive/divergent/focused) select model tier and context depth |
| **Governance through records** | Every cross-agent action is an audit event |

See the [Product Design Overview](docs/product-design/00-overview.md) for the full architecture.

---

## Core Objects

| Object | Description |
|--------|-------------|
| **Workspace** | The company space — organization, tasks, meetings, artifacts, rules, history |
| **Agent** | A digital employee with persistent identity (soul/instruct/memory/skills/relationships/kanban) |
| **Thread** | The unit of concurrency — focused, divergent, reactive, ambient |
| **Group / Meeting** | A governable collaboration room, not just a group chat |
| **Task** | A trackable, reviewable, accept-able unit of work |
| **Artifact** | Produced by the tool layer, flowing upward through gates |
| **Gate** | Review checkpoint — pass to escalate, fail to retry |
| **Decision** | Traceable organizational decision with rationale (DRI decides, no voting) |
| **Proposal** | Bottom-up suggestions from agents to the board |

---

## Built-in Agents

| Agent | Role | Description |
|-------|------|-------------|
| `build` | 🔨 Engineer | Executes tools based on configured permissions |
| `plan` | 📐 Planner | Read-only planning mode — suggests, doesn't change |
| `compose` | 🎼 Orchestrator | Manages workflows with built-in compose skills |
| `explore` | 🔍 Researcher | Fast codebase exploration and analysis |
| `general` | 🤖 Generalist | Multi-purpose agent for complex research tasks |

Custom agents can be defined via config or `.agentcompany/agent/` files.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | [Bun](https://bun.sh) + TypeScript |
| TUI | SolidJS + OpenTUI (terminal rendering) |
| State | [Effect-TS](https://effect.website) (functional effect system) |
| Storage | Drizzle ORM + SQLite |
| Build | Turborepo (monorepo) |
| Models | Any LLM provider (OpenAI, Anthropic, Google, local models...) |

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **P0** — Execution Foundation | ✅ Done | Single-task chain, structured activity contracts, real delivery, approval, cancel |
| **P1** — Execution Model + Multi-Agent | 🔨 In Progress | Agent=file-bundle, model=engine, concurrency=thread, presence registry |
| **P2** — Org Context Foundation | 📋 Planned | Context resolver, scope × clearance, role-based visibility, delegate/message primitives |
| **P3** — Interaction + Recursive Delegation | 📋 Planned | A2A alignment, recursive delegation, failure protocols, admission grading |
| **P4** — Governance + Learning | 📋 Planned | Reputation, org changes, proposal loop, experience→skill crystallization |
| **P5** — Experience & Spatial Loop | 📋 Planned | Differentiated rendering, living office, org tree + thread visualization |

---

## Contributing

We welcome contributions! Please read our [AGENTS.md](AGENTS.md) for coding conventions and style guidelines.

```bash
# Run typechecks from package directories (not repo root)
cd packages/opencode
bun typecheck
bun test
```

---

## Community

- [GitHub Discussions](https://github.com/Ericwong5021/agents-company/discussions) — Ask questions, share ideas
- [GitHub Issues](https://github.com/Ericwong5021/agents-company/issues) — Report bugs, request features

---

## License

Source code is licensed under the [MIT License](./LICENSE). Use of Agent Company is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).

---

<div align="center">

<sub>Built with the philosophy that AI should work <strong>like an organization</strong>, not like a chatbot.</sub>

</div>
