<h1 align="center">Agent Company</h1>

<p align="center"><strong>The first Agent company operating system — so anyone can run their own first Agent company.</strong></p>

---

Agent Company is a governable virtual company made of AI Agents.

You're not "using a chatbot" — you're running an organization of digital employees that divides work, collaborates, reports status, seeks approval, and accumulates experience over time. A request flows through the organization: it gets understood, decomposed, delegated, executed, and reviewed, then comes back to you for the key decisions.

> You state the goal; the company drives it forward. When a call is yours to make, it comes back for approval.

---

## Core Ideas

The whole system is a recursive **decompose → delegate → admit/escalate** tree. The user discusses with the boardroom; the need is decomposed and delegated downward layer by layer. **Only leaf nodes (the tool layer) produce artifacts** (code, docs, data, designs). Non-leaf nodes turn decisions into plans into specs into orchestration, and results flow back up to be admitted (success) or escalated (failure).

- **Recursive delegation** — a fixed-depth delegation tree; every non-leaf node does the same job: decompose the goal, recruit/delegate, gate admission, escalate on failure.
- **Identity decoupled from execution** — an Agent is a bundle of persistent files (who); a Model is the engine that runs them (what's being done). The unit of concurrency is the Thread, not the Agent.
- **Information as files** — policies, strategy, projects, memory, relationships are all documents in the file system; access is governed by scope × classification × clearance.
- **Attention as cost** — four attention modes (idle / reactive / divergent / focused) jointly decide what context is injected and which model tier runs; idle uses a cheap model, focused uses a strong one.
- **Governance through records** — an emergent system isn't reproducible; every cross-Agent access, message, admission, and escalation is an audit event. The trace is the "source code" of each run.
- **Bottom-up proposals** — ideas can bubble up; the board shifts from generating tasks to filtering proposals.

See the [Product Design Overview](docs/product-design/00-overview.md).

---

## Organization

```
User ←→ Boardroom (CEO/CTO/CFO/CMO)     ← system entry = a meeting
        ↓
     Departments (business + infrastructure)
        ↓
     Project squads (Leader)
        ↓
     Execution layer                      ← match a predefined workflow + refine spec + drive tools
        ↓
     Tool layer                           ← the only layer that produces artifacts
```

**Strictly no level-skipping**: every layer is traversed regardless of task size; delegation depth is ~4–5 levels.

---

## Quick Start

```bash
bun install      # install dependencies
bun run dev      # start the main dev entry from the repo root
```

> The repo's current focus is the **TUI (Terminal UI)** in [packages/opencode/src/cli/cmd/tui](packages/opencode/src/cli/cmd/tui). Web and App are not the current mainline. The CLI entry is still `mimo`; branding and command names will converge later.

Run typechecks and tests from a package directory (not the repo root):

```bash
cd packages/opencode
bun typecheck
bun test
```

---

## Note

This is not an AgentCompany compatibility release. Agent Company is rebuilt from AgentCompany foundations as a new product direction; legacy filesystem, config, and API compatibility are not preserved unless a migration bridge is explicitly requested.

---

## License

Source code is licensed under the [MIT License](./LICENSE). Use of Agent Company is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).
