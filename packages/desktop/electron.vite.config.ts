import { defineConfig } from "electron-vite"
import * as fs from "node:fs/promises"
import path from "node:path"

const channel = (() => {
  const raw = process.env.AGENTCOMPANY_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const CONTROL_PLANE_DIST = "../control-plane/dist/node"

const nodePtyPkg = `@lydell/node-pty-${process.platform}-${process.arch}`

export default defineConfig({
  main: {
    define: {
      "import.meta.env.AGENTCOMPANY_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: { index: "src/main/index.ts" },
      },
      externalizeDeps: { include: [nodePtyPkg] },
    },
    plugins: [
      {
        name: "agent-company:node-pty-narrower",
        enforce: "pre",
        resolveId(s) {
          if (s === "@lydell/node-pty") return nodePtyPkg
        },
      },
      {
        name: "agent-company:virtual-server-module",
        enforce: "pre",
        resolveId(id) {
          if (id === "virtual:control-plane-server") return { id: "./chunks/node.js", external: true }
        },
      },
      {
        name: "agent-company:copy-control-plane-assets",
        async writeBundle() {
          await fs.mkdir("./out/main/chunks", { recursive: true })
          for (const l of await fs.readdir(CONTROL_PLANE_DIST)) {
            if (l.endsWith(".map")) continue
            await fs.copyFile(path.join(CONTROL_PLANE_DIST, l), path.join("./out/main/chunks", l))
          }
        },
      },
    ],
  },
  preload: {
    build: {
      rollupOptions: {
        input: { index: "src/preload/index.ts" },
        output: {
          format: "cjs",
          entryFileNames: "[name].js",
        },
      },
    },
  },
  renderer: {
    root: "src/renderer",
    define: {
      "import.meta.env.VITE_AGENTCOMPANY_CHANNEL": JSON.stringify(channel),
    },
    build: {
      rollupOptions: {
        input: {
          main: "src/renderer/index.html",
          loading: "src/renderer/loading.html",
        },
      },
    },
  },
})
