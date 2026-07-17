# @agents-company/desktop

The Electron shell for Agent Company. It embeds the shared UI from `packages/app` and starts the local server/runtime from `packages/control-plane`.

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

The shell already provides a sandboxed renderer, an authenticated loopback sidecar, native notifications, update wiring, window-state persistence, and the shared WebUI.

The Pre-Public target still requires Agent Company branding and data migration, tray/status-bar lifecycle, close-window-without-quitting behavior, reliable window recreation, and product-level task/worktree recovery. Do not describe those target behaviors as shipped until the corresponding acceptance tests pass.

See the [implementation plan](../../docs/product-design/implementation-plan.md), especially W1.
