# @agents-company/control-plane and local runtime

This package contains Agent Company's Bun/Effect runtime, local Hono server, SQLite services, Git/worktree support, workflow engine, and non-interactive CLI. It provides the backend used by `packages/app`.

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

This package is the current foundation of the local Control Plane, but existing modules are not automatically public product features. Browser and automation clients should consume common service and event semantics; WebUI clients must not write SQLite or Agent identity files directly.

The terminal UI has been removed. The primary Pre-Public information architecture is the shared WebUI in `packages/app`; the remaining CLI is headless and non-interactive.

See the [Product Constitution](../../docs/product-design/PRODUCT-CONSTITUTION.md), [PRD](../../docs/Agent%20Company%20产品%20PRD.md), and [implementation plan](../../docs/product-design/implementation-plan.md).
