#!/usr/bin/env bun
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

import { $ } from "bun"
import path from "path"

import { createClient } from "@hey-api/openapi-ts"

await $`bun dev generate > ${dir}/openapi.json`.cwd(path.resolve(dir, "../../opencode"))

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
await Bun.write(openapiPath, JSON.stringify(openapi, null, 2))

await createClient({
  input: "./openapi.json",
  output: {
    path: "./src/v2/gen",
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
      instance: "OpencodeClient",
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

await $`bun prettier --write src/gen`
await $`bun prettier --write src/v2`
await $`rm -rf dist`
await $`bun tsc`
await $`rm openapi.json`
