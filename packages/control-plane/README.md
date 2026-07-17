# @agents-company/control-plane and local runtime

This package contains Agent Company's Bun/Effect runtime, local Hono server, SQLite services, Git/worktree support, workflow engine, CLI, and TUI. It also provides the backend bundled by `packages/desktop` and used by `packages/app`.

## Commands

Run from this package directory:

```bash
bun dev
bun typecheck
bun test
bun run build
```

Run focused tests by passing their paths to `bun test`. Do not run repository tests from the monorepo root.

## Product role

This package is the current foundation of the local Control Plane, but existing modules are not automatically public product features. Browser, desktop, and TUI clients should consume common service and event semantics; renderer clients must not write SQLite or Agent identity files directly.

The TUI under `src/cli/cmd/tui` remains a supported secondary product entry point. The primary Pre-Public information architecture is the shared WebUI in `packages/app`.

See the [Product Constitution](../../docs/product-design/PRODUCT-CONSTITUTION.md), [PRD](../../docs/Agent%20Company%20产品%20PRD.md), and [implementation plan](../../docs/product-design/implementation-plan.md).
