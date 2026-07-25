const packageRoot = import.meta.dir.replace(/[\\/]script$/, "")
const build = Bun.spawn(["bun", "run", "build"], {
  cwd: packageRoot,
  env: Bun.env,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})
const buildCode = await build.exited
if (buildCode) process.exit(buildCode)

const nativePackage = {
  "darwin-arm64": "@libsql/darwin-arm64",
  "darwin-x64": "@libsql/darwin-x64",
  "linux-x64": "@libsql/linux-x64-gnu",
  "win32-x64": "@libsql/win32-x64-msvc",
}[`${process.platform}-${process.arch}`]
if (!nativePackage || !await Bun.file(
  `${packageRoot}/.output/server/node_modules/${nativePackage}/package.json`,
).exists()) {
  console.error(`Production output is missing the libsql native package for ${process.platform}-${process.arch}`)
  process.exit(1)
}

const preview = Bun.spawn(["bun", "run", "preview"], {
  cwd: packageRoot,
  env: Bun.env,
  stdin: "ignore",
  stdout: "inherit",
  stderr: "inherit",
})
const stop = () => preview.kill()
process.once("SIGINT", stop)
process.once("SIGTERM", stop)
process.exit(await preview.exited)
