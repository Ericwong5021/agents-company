#!/usr/bin/env bun

import path from "node:path"
import fs from "node:fs/promises"
import { Script } from "@agents-company/script"
import { createEmbeddedWebUIBundle, createExtensionManifest, loadMigrations } from "./build-support"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)
await import("./generate.ts")

const embedded = process.argv.includes("--skip-embed-web-ui")
  ? "export default {};"
  : await createEmbeddedWebUIBundle(root)
const cleanExtensions = createExtensionManifest(root)
await fs.rm(path.join(root, "dist", "node"), { recursive: true, force: true })
const result = await Bun.build({
  target: "node",
  conditions: ["node"],
  tsconfig: "./tsconfig.json",
  entrypoints: ["node.ts", "agent-company-web-ui.gen.ts"],
  outdir: "./dist/node",
  format: "esm",
  splitting: true,
  sourcemap: "external",
  external: ["jsonc-parser", "@lydell/node-pty", "node-gyp"],
  files: {
    "node.ts": "export * from './src/node'",
    "agent-company-web-ui.gen.ts": embedded,
  },
  define: {
    AGENTCOMPANY_VERSION: JSON.stringify(Script.version),
    AGENTCOMPANY_CHANNEL: JSON.stringify(Script.channel),
    CONTROL_PLANE_MIGRATIONS: JSON.stringify(await loadMigrations(root)),
  },
})
cleanExtensions()
if (!result.success) throw new AggregateError(result.logs, "Node build failed")
