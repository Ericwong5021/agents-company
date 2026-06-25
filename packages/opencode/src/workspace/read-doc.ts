import path from "path"
import { Effect } from "effect"
import { parseFrontMatter } from "./front-matter"
import { canAccess, getAgentClearance, type OrgStructure } from "./clearance"
import { workspaceRoot } from "./workspace"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import z from "zod"

// ---------------------------------------------------------------------------
// Audit event
// ---------------------------------------------------------------------------

export const ReadDocAudit = BusEvent.define(
  "workspace.read_doc",
  z.object({
    agentId: z.string(),
    docPath: z.string(),
    granted: z.boolean(),
    classification: z.string().optional(),
  }),
)

// ---------------------------------------------------------------------------
// readDoc — read a workspace document with ACL check
// ---------------------------------------------------------------------------

export interface ReadDocInput {
  agentId: string
  docPath: string
  org?: OrgStructure
}

export interface ReadDocResult {
  content: string
  frontMatter: Record<string, string | undefined>
  granted: boolean
}

export function readDoc(input: ReadDocInput): Effect.Effect<ReadDocResult, Error> {
  return Effect.gen(function* () {
    const fullPath = path.isAbsolute(input.docPath)
      ? input.docPath
      : path.join(workspaceRoot(), input.docPath)

    const file = Bun.file(fullPath)
    const exists = yield* Effect.promise(() => file.exists())
    if (!exists) {
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: ReadDocAudit.type,
            properties: { agentId: input.agentId, docPath: input.docPath, granted: false },
          },
        }),
      )
      return yield* Effect.fail(new Error(`read_doc: file not found: ${input.docPath}`))
    }

    const content = yield* Effect.promise(() => file.text())
    const { frontMatter, body } = parseFrontMatter(content)
    const classification = frontMatter.classification ?? "public"

    // If no org structure provided, default to permissive (public access)
    if (!input.org) {
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: ReadDocAudit.type,
            properties: {
              agentId: input.agentId,
              docPath: input.docPath,
              granted: true,
              classification,
            },
          },
        }),
      )
      return { content: body, frontMatter, granted: true }
    }

    const agentClearance = getAgentClearance(input.agentId, input.org)
    const granted = canAccess(agentClearance, classification)

    yield* Effect.sync(() =>
      GlobalBus.emit("event", {
        directory: "global",
        payload: {
          type: ReadDocAudit.type,
          properties: {
            agentId: input.agentId,
            docPath: input.docPath,
            granted,
            classification,
          },
        },
      }),
    )

    if (!granted) {
      return yield* Effect.fail(
        new Error(`read_doc: access denied for agent "${input.agentId}" to "${input.docPath}" (classification: ${classification})`),
      )
    }

    return { content: body, frontMatter, granted: true }
  })
}
