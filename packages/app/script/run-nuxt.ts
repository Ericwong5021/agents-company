import { fileURLToPath } from "node:url"

const command = Bun.argv[2]
if (command !== "build" && command !== "prepare" && command !== "typecheck") {
  throw new Error("run-nuxt.ts accepts only build, prepare, or typecheck.")
}

const child = Bun.spawn([
  "node",
  "./node_modules/nuxt/bin/nuxt.mjs",
  command,
], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  env: {
    ...Bun.env,
    BETTER_AUTH_SECRET: Bun.env.BETTER_AUTH_SECRET || `${crypto.randomUUID()}${crypto.randomUUID()}`,
    BETTER_AUTH_URL: Bun.env.BETTER_AUTH_URL || "http://127.0.0.1:3210",
    INTERNAL_API_SECRET: Bun.env.INTERNAL_API_SECRET || `${crypto.randomUUID()}${crypto.randomUUID()}`,
    NODE_OPTIONS: "--max-old-space-size=8192",
  },
  stdout: "inherit",
  stderr: "inherit",
})

process.exit(await child.exited)
