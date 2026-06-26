import * as Tool from "./tool"
import DESCRIPTION from "./read-doc.txt"
import z from "zod"
import { Effect } from "effect"
import { parseFrontMatter } from "@/workspace/front-matter"
import { canSeeDocEnhanced, type OrgStructure } from "@/workspace/clearance"
import { makeDelegationChecker, isGroupMember, listEdges } from "@/workspace/relationships"
import { workspaceRoot } from "@/workspace/workspace"
import { ReadDocAudit } from "@/workspace/read-doc"
import { GlobalBus } from "@/bus/global"
import { Config } from "@/config"
import path from "path"

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
          const agentId = ctx.agent
          const docPath = args.path

          // 1. Resolve file path
          const fullPath = path.isAbsolute(docPath)
            ? docPath
            : path.join(workspaceRoot(), docPath)

          // 2. Read file
          const file = Bun.file(fullPath)
          const exists = yield* Effect.promise(() => file.exists())
          if (!exists) {
            yield* Effect.sync(() =>
              GlobalBus.emit("event", {
                directory: "global",
                payload: {
                  type: ReadDocAudit.type,
                  properties: { agentId, docPath, granted: false },
                },
              }),
            )
            return yield* Effect.fail(new Error(`read_doc: file not found: ${docPath}`))
          }

          const raw = yield* Effect.promise(() => file.text())
          const { frontMatter, body } = parseFrontMatter(raw)
          const classification = frontMatter.classification ?? "public"
          const scope = frontMatter.scope ?? "public"

          // 3. Load org structure from config
          const cfg = yield* config.get()
          const org = cfg.org as OrgStructure | undefined

          // 4. Check access using canSeeDocEnhanced (with relationship + group support)
          let granted = true
          if (org) {
            // Compute the relationship modifier (sum of incoming edge modifiers)
            const incomingEdges = listEdges(agentId).filter((e) => e.toAgentId === agentId)
            const relationshipModifier = incomingEdges.reduce((sum, e) => sum + e.clearanceModifier, 0)

            const delegationChecker = makeDelegationChecker(agentId)
            const groupMemberCheck = (groupId: string) => isGroupMember(groupId, agentId)

            granted = canSeeDocEnhanced(
              agentId,
              frontMatter,
              org,
              relationshipModifier,
              groupMemberCheck,
              delegationChecker,
            )
          }

          // 5. Fire audit event
          yield* Effect.sync(() =>
            GlobalBus.emit("event", {
              directory: "global",
              payload: {
                type: ReadDocAudit.type,
                properties: { agentId, docPath, granted, classification },
              },
            }),
          )

          // 6. Return error if unauthorized
          if (!granted) {
            return yield* Effect.fail(
              new Error("access denied: document classification exceeds your clearance"),
            )
          }

          // 7. Return authorized document content
          return {
            title: `Read: ${docPath}`,
            output: body,
            metadata: { path: docPath, classification, scope } as Metadata,
          }
        }).pipe(Effect.orDie),
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
