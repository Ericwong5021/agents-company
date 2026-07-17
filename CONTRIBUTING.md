# Contributing to Agent Company

Thank you for helping build Agent Company. The project is currently converging on its local-first Pre-Public release, so contributions should strengthen that product path rather than reopen settled product direction.

## Start with the right source

Before changing product behavior, read:

1. [Product Constitution](docs/product-design/PRODUCT-CONSTITUTION.md)
2. [Product PRD](docs/Agent%20Company%20产品%20PRD.md)
3. [Implementation Plan](docs/product-design/implementation-plan.md)
4. [Repository instructions](AGENTS.md)

The authority order for all documentation is in [docs/README.md](docs/README.md). If code and target design differ, describe and test the gap; do not quietly change the constitution to match current implementation.

Core product or UI changes should begin with an issue or design discussion. Small fixes, tests, provider support, performance improvements, and documentation corrections can usually proceed directly when their scope is clear.

## Development setup

Requirements: Bun 1.3.x and any platform dependencies needed by Electron and node-pty.

```bash
git clone https://github.com/Ericwong5021/agents-company.git
cd agents-company
bun install
```

Run the current CLI/TUI development entry:

```bash
bun run dev
```

Run the shared WebUI or Electron desktop shell:

```bash
bun run dev:web
bun run dev:desktop
```

The standalone WebUI expects a local backend, normally on port 4096. The Electron app builds and hosts the backend from `packages/control-plane` itself.

## Repository map

| Path | Responsibility |
|---|---|
| `packages/app` | Shared SolidJS + Vite WebUI for browser and Electron |
| `packages/desktop` | Electron main/preload/renderer shell and packaging |
| `packages/control-plane` | Bun/Effect runtime, server, SQLite, Git, workflows, TUI, and Control Plane services |
| `packages/ui` | Shared UI primitives |
| `packages/sdk` | Generated and hand-written client SDKs |
| `docs/product-design` | Canonical product design and implementation plan |
| `docs/compose` | Historical implementation plans and reports |

The TUI is a supported secondary client. New product information architecture should be designed in the shared WebUI and exposed through common Control Plane semantics, not implemented as a TUI-only product model.

## Checks

Do not run tests from the repository root; a guard intentionally rejects that. Run checks from the package you changed.

```bash
cd packages/control-plane
bun typecheck
bun test
```

```bash
cd packages/app
bun typecheck
bun run test:unit
```

```bash
cd packages/desktop
bun typecheck
bun run build
```

Use focused tests during development and record the exact commands and results in the pull request. UI changes should include screenshots or a short recording for relevant states and platforms.

To regenerate the JavaScript SDK after API changes:

```bash
./packages/sdk/js/script/build.ts
```

## Building local artifacts

Build a single CLI/runtime artifact:

```bash
bun run packages/control-plane/script/build.ts --single
```

Build or package the Electron app from `packages/desktop`:

```bash
bun run build
bun run package
```

Use `package:win`, `package:mac`, or `package:linux` for a specific target.

## Pull requests

- Keep changes focused and preserve unrelated work in the repository.
- Link an issue for user-visible features or behavior changes.
- Explain the problem, why the change is correct, and how it was verified.
- Separate current implementation facts from future target behavior.
- Include migration and recovery behavior for schema, identity-file, and Worktree changes.
- Include negative permission tests for private, Direct, approval, or external-action changes.
- Do not claim a product workflow is complete merely because a backend module exists.
- Use conventional commit prefixes such as `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, or `chore:`.

Large AI-generated issue or PR descriptions without concrete understanding, evidence, and a focused change are not useful. Concise, authored explanations are preferred.

## Product guardrails

Without an explicit product decision, do not expand the active Pre-Public scope to:

- multi-user or cloud-hosted companies;
- mobile clients;
- one Project writing multiple repositories;
- Kanban-first project management;
- general-industry delivery claims;
- pixel-office simulation;
- weaker private-space, approval, audit, or Worktree boundaries.

Agent Company is rebuilt from AgentCompany foundations and does not preserve legacy filesystem, config, or API compatibility unless a migration bridge is explicitly requested and documented.
