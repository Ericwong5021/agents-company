# @agents-company/desktop

The Electron shell for Agent Company. It starts the local Control Plane from `packages/control-plane` and loads the canonical Eve/Nuxt WebUI from `packages/app`.

## Commands

Run from this package directory:

```bash
bun dev
bun typecheck
bun run build
bun run package
```

Platform packaging:

```bash
bun run package:win
bun run package:mac
bun run package:linux
```

## Current foundation

The shell already provides a sandboxed preflight renderer, an authenticated loopback sidecar, native notifications, update wiring, and window-state persistence. Packaging the Nuxt server with Electron remains part of the active WebUI migration.

The Pre-Public target still requires Agent Company branding and data migration, tray/status-bar lifecycle, close-window-without-quitting behavior, reliable window recreation, and product-level task/worktree recovery. Do not describe those target behaviors as shipped until the corresponding acceptance tests pass.

See the [implementation plan](../../docs/product-design/implementation-plan.md), especially W1.
