<h1 align="center">Agent Company</h1>

<p align="center"><strong>The first AI Company Operating System — so anyone can run their own first AI company.</strong></p>

---

Agent Company is a governable virtual company made of AI Agents.

You're not "using a chatbot" — you're running an organization of digital employees that divides work, collaborates, reports status, seeks approval, and accumulates experience over time. A request flows through the organization: it gets understood, decomposed, delegated, executed, and reviewed, then comes back to you for the key decisions.

> You state the goal; the company drives it forward. When a call is yours to make, it comes back for approval.

---

## Quick Start

```bash
npm install -g @agents-company/cli
agents
```

---

## Organization

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

**Strictly no level-skipping**: every layer is traversed regardless of task size; delegation depth is ~4–5 levels.

---

## License

Source code is licensed under the [MIT License](./LICENSE). Use of Agent Company is also subject to the [Use Restrictions](./USE_RESTRICTIONS.md).
