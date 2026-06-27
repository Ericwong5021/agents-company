<h1 align="center">
  <br>
  Agent Company
  <br>
</h1>

<p align="center">
  <strong>The AI Company Operating System</strong><br>
  <em>Give yourself a company of AI employees — not a chatbot, an organization.</em>
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="README.zh.md">中文</a> ·
  <a href="docs/product-design/00-overview.md">Design Docs</a> ·
  <a href="docs/Agent%20Company%20产品%20PRD.md">PRD</a>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-blue" alt="License">
  <img src="https://img.shields.io/badge/language-TypeScript-blue" alt="TypeScript">
  <img src="https://img.shields.io/badge/terminal-TUI-green" alt="TUI">
</p>

---

## What is Agent Company?

You're not "using a chatbot." You're **running a virtual company**.

Agent Company is a multi-agent operating system where AI agents form a real organization — with a boardroom, departments, project squads, and execution teams. You tell the company what you want. It decomposes the goal, delegates down through the org chart, executes, reviews, and brings key decisions back to you.

> **You set the direction. The company drives it forward. When it's your call, it comes back.**

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

### 🏛️ Boardroom Interface
Your entry point is a meeting with the board — CEO, CTO, CFO, CMO. Discuss goals, set priorities, review progress. No prompt engineering required.

### 🔄 Recursive Delegation
Tasks decompose naturally through the org chart: Boardroom → Departments → Project Squads → Execution → Tool Layer. Each layer does exactly one thing well.

### 🎯 Bidding Scheduler
Agents bid to speak based on relevance, expertise, and turn rights. No agent dominates; no voice is lost. The scheduler ensures productive, balanced multi-agent conversations.

### 🧠 Persistent Identity
Each agent is more than a prompt — they're a bundle of persistent files: **soul** (who they are), **memory** (what they've learned), **skills** (what they can do), and **relationships** (who they work with).

### 📋 Task & Artifact Management
Track work through the org. Artifacts flow upward through **gates** — approved or escalated. Every decision is traceable.

### 🔒 Governance by Design
Approval checkpoints at every level. Trust scales with performance. The system records everything — because an untraceable system is an ungovernable one.

### 🖥️ Terminal UI
Beautiful TUI built with SolidJS + Ink. Not a web app, not a desktop wrapper — a **native terminal experience** for developers who live in the command line.

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
1. Setting up your AI company (name, industry, team size)
2. Creating your founding team (CEO, CTO, CFO, CMO)
3. Entering the boardroom

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
- **Recursive delegation** — every non-leaf node decomposes → delegates → gates results
- **Identity ≠ Execution** — Agent files are "who"; Model is "how they run"
- **Information as files** — policies, strategy, memory are all documents, governed by scope × clearance
- **Attention as cost** — four modes (idle/reactive/divergent/focused) select model tier and context depth
- **Governance through records** — every cross-agent action is an audit event

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

- **Runtime**: [Bun](https://bun.sh) + TypeScript
- **TUI**: SolidJS + Ink (terminal rendering)
- **State**: Effect-TS (functional effect system)
- **Storage**: Drizzle ORM + SQLite
- **Build**: Turborepo (monorepo)
- **Models**: Any LLM provider (OpenAI, Anthropic, Google, local models...)

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
- [Issues](https://github.com/Ericwong5021/agents-company/issues) — Report bugs, request features

---

## License

Source code is licensed under the [MIT License](./LICENSE). Use of Agent Company is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).
