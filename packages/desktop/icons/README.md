# Agent Company icons

`agent-company/` is the only icon source used by Electron development and release builds. Regenerate it from the canonical WebUI mark with:

```sh
bun script/generate-agent-company-brand.ts --desktop
```

The historical `dev/`, `beta/`, and `prod/` folders are intentionally not copied into `resources/`.
