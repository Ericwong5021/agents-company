#!/usr/bin/env bun

import fs from "fs"
import path from "path"
import semver from "semver"
import { $ } from "bun"

const dir = path.resolve(import.meta.dir, "..")
process.chdir(dir)

const args = process.argv.slice(2)
const arg = (name: string) => {
  const index = args.indexOf(name)
  return index === -1 ? undefined : args[index + 1]
}
const version = arg("--version")
const distDir = path.resolve(dir, arg("--dist") ?? "dist")
const outputDir = path.resolve(dir, arg("--output") ?? "dist/cli")

if (!version || !semver.valid(version)) {
  throw new Error("--version must be a valid semver version")
}

const platformNames = fs
  .readdirSync(distDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name.startsWith("agentcompany-"))
  .map((entry) => entry.name)
  .sort()

if (!platformNames.length) {
  throw new Error(`No platform packages found in ${distDir}/agentcompany-*`)
}

fs.rmSync(outputDir, { recursive: true, force: true })
fs.mkdirSync(path.join(outputDir, "bin"), { recursive: true })
fs.copyFileSync(path.join(dir, "bin", "agents"), path.join(outputDir, "bin", "agents.cjs"))
fs.chmodSync(path.join(outputDir, "bin", "agents.cjs"), 0o755)
fs.copyFileSync(path.join(dir, "postinstall.cjs"), path.join(outputDir, "postinstall.cjs"))
fs.copyFileSync(path.resolve(dir, "../../README_npm.md"), path.join(outputDir, "README.md"))
fs.copyFileSync(path.resolve(dir, "../../LICENSE"), path.join(outputDir, "LICENSE"))

await Bun.write(
  path.join(outputDir, "package.json"),
  JSON.stringify(
    {
      name: "@agents-company/control-plane",
      version,
      description: "Agent Company CLI - run an AI company from your terminal",
      type: "commonjs",
      license: "Apache-2.0",
      author: "Agents Company Team",
      homepage: "https://github.com/Ericwong5021/agents-company#readme",
      repository: {
        type: "git",
        url: "git+https://github.com/Ericwong5021/agents-company.git",
        directory: "packages/control-plane",
      },
      bugs: {
        url: "https://github.com/Ericwong5021/agents-company/issues",
      },
      keywords: ["ai", "agent", "agents", "agents-company", "cli", "coding", "developer-tools"],
      bin: {
        agents: "./bin/agents.cjs",
      },
      scripts: {
        postinstall: "node postinstall.cjs",
      },
      files: ["bin", "postinstall.cjs", "README.md", "LICENSE"],
      optionalDependencies: Object.fromEntries(platformNames.map((name) => [`@agents-company/${name}`, version])),
      publishConfig: {
        access: "public",
      },
    },
    null,
    2,
  ),
)

const parsePack = (raw: string) => {
  const isRecord = (value: unknown): value is Record<string, unknown> => {
    return !!value && typeof value === "object"
  }
  const pack: unknown = JSON.parse(raw)
  if (!Array.isArray(pack)) throw new Error("npm pack output must be an array")
  const entry = pack[0]
  if (!isRecord(entry) || !Array.isArray(entry.files)) {
    throw new Error("npm pack output must include files")
  }
  return entry.files
    .filter((file: unknown): file is { path: string } => {
      return isRecord(file) && typeof file.path === "string"
    })
    .map((file) => file.path)
}

const pkg = await Bun.file(path.join(outputDir, "package.json")).json()
const readme = await Bun.file(path.join(outputDir, "README.md")).text()
const license = await Bun.file(path.join(outputDir, "LICENSE")).text()
const files = new Set(parsePack(await $`npm pack --dry-run --json`.cwd(outputDir).text()))

const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(message)
}

assert(readme.length > 5000, "README.md must be larger than 5KB")
assert(!/Bun init|bun init/i.test(readme), "README.md still looks like a Bun init template")
assert(license.includes("Apache License") && license.includes("Version 2.0"), "LICENSE must be Apache License 2.0")
assert(pkg.name === "@agents-company/control-plane", "package name must be @agents-company/control-plane")
assert(pkg.version === version, "package version must match the release version")
assert(pkg.description === "Agent Company CLI - run an AI company from your terminal", "description is not release-ready")
assert(pkg.license === "Apache-2.0", "license field must be Apache-2.0")
assert(pkg.repository?.url && pkg.repository?.directory, "repository metadata must include url and directory")
assert(pkg.homepage, "homepage is required")
assert(pkg.bugs?.url, "bugs.url is required")
assert(Array.isArray(pkg.keywords) && pkg.keywords.length >= 5, "keywords are required")
assert(pkg.bin?.agents === "./bin/agents.cjs", "bin.agents must point to ./bin/agents.cjs")
assert(pkg.scripts?.postinstall === "node postinstall.cjs", "postinstall script is required")
assert(
  JSON.stringify(Object.keys(pkg.optionalDependencies ?? {}).sort()) ===
    JSON.stringify(platformNames.map((name) => `@agents-company/${name}`).sort()),
  "optionalDependencies must match built platform packages",
)
assert(
  Object.values(pkg.optionalDependencies ?? {}).every((dependencyVersion) => dependencyVersion === version),
  "optionalDependencies versions must match the release version",
)
assert(files.has("README.md"), "README.md missing from npm pack")
assert(files.has("LICENSE"), "LICENSE missing from npm pack")
assert(files.has("bin/agents.cjs"), "bin/agents.cjs missing from npm pack")
assert(files.has("postinstall.cjs"), "postinstall.cjs missing from npm pack")

console.log(`Prepared ${pkg.name}@${version} in ${path.relative(dir, outputDir).replaceAll("\\", "/")}`)
