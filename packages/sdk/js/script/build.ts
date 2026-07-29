#!/usr/bin/env bun
import { fileURLToPath } from "url"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

const requiredBunVersion = (await Bun.file(path.resolve(dir, "../../../package.json")).json()).packageManager?.match(
  /^bun@(.+)$/,
)?.[1]
if (!requiredBunVersion) throw new Error("Root package.json must declare packageManager as bun@<version>")
if (process.versions.bun !== requiredBunVersion) {
  throw new Error(`SDK generation requires bun@${requiredBunVersion}, received bun@${process.versions.bun}`)
}

const generationHome = await mkdtemp(path.join(os.tmpdir(), "agent-company-sdk-"))
try {
  await $`bun dev generate > ${dir}/openapi.json`
    .cwd(path.resolve(dir, "../../control-plane"))
    .env({
      ...process.env,
      AGENTCOMPANY_HOME: generationHome,
      AGENTCOMPANY_DB: ":memory:",
      XDG_DATA_HOME: path.join(generationHome, "xdg-data"),
      XDG_CONFIG_HOME: path.join(generationHome, "xdg-config"),
    })
} finally {
  await rm(generationHome, { recursive: true, force: true })
}

const openapiPath = path.join(dir, "openapi.json")
const openapi = await Bun.file(openapiPath).json()

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function rewriteRefs(value: unknown) {
  if (!isRecord(value)) return
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/$defs/")) {
    value.$ref = value.$ref.replace("#/$defs/", "#/components/schemas/")
  }
  Object.values(value).map(rewriteRefs)
}

function promoteLocalDefs(value: unknown) {
  if (!isRecord(value)) return

  const components = isRecord(openapi.components) ? openapi.components : {}
  openapi.components = components
  const schemas = isRecord(components.schemas) ? components.schemas : {}
  components.schemas = schemas

  if (isRecord(value.$defs)) {
    Object.entries(value.$defs).map(([key, schema]) => {
      if (schemas[key] === undefined) schemas[key] = schema
    })
    delete value.$defs
  }

  Object.values(value).map(promoteLocalDefs)
}

promoteLocalDefs(openapi)
rewriteRefs(openapi)
const serialized = JSON.stringify(openapi, null, 2)
await Bun.write(openapiPath, serialized)
await Bun.write(path.resolve(dir, "../openapi.json"), serialized)

async function generate(output: string) {
  await createClient({
    input: "./openapi.json",
    output: {
      path: output,
      tsConfigPath: path.join(dir, "tsconfig.json"),
      clean: true,
    },
    plugins: [
      {
        name: "@hey-api/typescript",
        exportFromIndex: false,
      },
      {
        name: "@hey-api/sdk",
        instance: "ControlPlaneClient",
        exportFromIndex: false,
        auth: false,
        paramsStructure: "flat",
      },
      {
        name: "@hey-api/client-fetch",
        exportFromIndex: false,
        baseUrl: "http://localhost:4096",
      },
    ],
  })
}

async function requireRequestParameters(
  file: string,
  className: string,
  methods: readonly (readonly [string, readonly string[]])[],
) {
  let source = await Bun.file(file).text()
  const classStart = source.indexOf(`export class ${className} extends HeyApiClient`)
  if (classStart < 0) throw new Error(`Missing generated ${className} client`)
  for (const [method, fields] of methods) {
    const start = source.indexOf(`  public ${method}<`, classStart)
    const end = source.indexOf("\n    options?:", start)
    if (start < 0 || end < 0) throw new Error(`Missing generated ${className}.${method} signature`)
    let signature = source.slice(start, end)
    signature = signature.replace("\n    parameters?: {", "\n    parameters: {")
    for (const field of fields) signature = signature.replace(`\n      ${field}?:`, `\n      ${field}:`)
    if (!signature.includes("\n    parameters: {")) throw new Error(`${className}.${method} parameters are optional`)
    for (const field of fields)
      if (!signature.includes(`\n      ${field}:`)) throw new Error(`${className}.${method}.${field} is optional`)
    source = `${source.slice(0, start)}${signature}${source.slice(end)}`
  }
  await Bun.write(file, source)
}

await generate("./src/v2/gen")

for (const file of await Array.fromAsync(new Bun.Glob("src/v2/**/*.ts").scan())) {
  await $`bun prettier --write ${file}`
}
await requireRequestParameters("./src/v2/gen/sdk.gen.ts", "GoalBrief", [
  ["create", ["source", "brief"]],
  ["generate", ["requestId", "goal"]],
  ["append", ["expectedVersion", "source", "brief"]],
])
await requireRequestParameters("./src/v2/gen/sdk.gen.ts", "Rollout", [
  ["transition", ["idempotencyKey", "to", "reason"]],
  ["action", ["body"]],
])
await $`bun prettier --write ./src/v2/gen/sdk.gen.ts`
await $`rm -rf dist`
await $`bun typecheck`
await $`rm openapi.json`
