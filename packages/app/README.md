# @agents-company/app

The shared SolidJS + Vite WebUI used by both the browser development surface and `packages/desktop`.

## Commands

Run from this package directory:

```bash
bun dev
bun typecheck
bun run test:unit
bun run test:e2e:local
bun run build
```

The standalone development server defaults to `http://localhost:3000` and expects a local Agent Company backend at `http://localhost:4096` unless overridden with:

- `PLAYWRIGHT_SERVER_HOST`
- `PLAYWRIGHT_SERVER_PORT`
- `PLAYWRIGHT_PORT`
- `PLAYWRIGHT_BASE_URL`

## Product role

This package is the primary product UI. Electron embeds it rather than maintaining a separate desktop frontend. The non-interactive CLI and other clients share Control Plane semantics with this app, while product information architecture remains here.

Current product direction and target behavior are defined in [`docs/product-design/PRODUCT-CONSTITUTION.md`](../../docs/product-design/PRODUCT-CONSTITUTION.md) and the [implementation plan](../../docs/product-design/implementation-plan.md).
