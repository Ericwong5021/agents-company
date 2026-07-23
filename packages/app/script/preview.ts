const port = Bun.env.PORT || "3210"
const host = Bun.env.HOST || "127.0.0.1"
const baseURL = Bun.env.BETTER_AUTH_URL || `http://${host}:${port}`
const server = Bun.spawn(["node", "./.output/server/index.mjs"], {
  cwd: import.meta.dir.replace(/[\\/]script$/, ""),
  env: {
    ...process.env,
    BETTER_AUTH_URL: baseURL,
    HOST: host,
    PORT: port,
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
})

console.log(`Eve preview: ${baseURL}`)
process.exit(await server.exited)
