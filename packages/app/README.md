# Agent Company WebUI

Agent Company's sole WebUI is a Nuxt 4 application using Eve. It connects to the local Control Plane and exposes the Company, board, employees and Company settings surfaces.

## Development

```sh
bun run dev:web
```

This starts the Eve worker and Nuxt application on `http://127.0.0.1:3210`. Start the Control Plane separately, or use `bun run dev:all` to start both.

The application derives from the Eve Personal Agent Template; see [`UPSTREAM.md`](UPSTREAM.md) and [`LICENSE`](LICENSE) for provenance and licensing.
