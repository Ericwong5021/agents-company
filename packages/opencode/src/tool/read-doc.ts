import * as Tool from "./tool"
import DESCRIPTION from "./read-doc.txt"
import z from "zod"
import { Effect } from "effect"
import { readDoc } from "@/workspace/read-doc"
import type { OrgStructure } from "@/workspace/clearance"
import { Config } from "@/config"

const id = "read_doc"

const parameters = z.strictObject({
  path: z.string().min(1).describe("Workspace-relative path to a .md file to read."),
})

type ReadDocInput = z.infer<typeof parameters>

type Metadata = {
  path?: string
  classification?: string
  scope?: string
}

export const ReadDocTool = Tool.define(
  id,
  Effect.gen(function* () {
    const config = yield* Config.Service

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: ReadDocInput, ctx: Tool.Context<Metadata>) =>
        Effect.gen(function* () {
          const cfg = yield* config.get()
          const result = yield* readDoc({
            agentId: ctx.agent,
            docPath: args.path,
            org: cfg.org as OrgStructure | undefined,
          })
          const classification = result.frontMatter.classification ?? "public"
          const scope = result.frontMatter.scope ?? "public"

          return {
            title: `Read: ${args.path}`,
            output: result.content,
            metadata: { path: args.path, classification, scope } as Metadata,
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
