import path from "path"
import { Effect } from "effect"
import { parseFrontMatter } from "./front-matter"
import { canSeeDocEnhanced, canSeeDocWithoutOrg, type OrgStructure } from "./clearance"
import { isGroupMember, listEdges, makeDelegationChecker } from "./relationships"
import { workspaceRoot } from "./workspace"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { AuditEvent } from "@/audit-event/audit-event"
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

function usableOrg(org?: OrgStructure) {
  if (!org?.departments || !org.agents) return
  return org
}

export function readDoc(input: ReadDocInput): Effect.Effect<ReadDocResult, Error> {
  return Effect.gen(function* () {
    const root = path.resolve(workspaceRoot())
    const fullPath = path.resolve(path.isAbsolute(input.docPath) ? input.docPath : path.join(root, input.docPath))
    const relativePath = path.relative(root, fullPath)
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
      yield* Effect.sync(() =>
        GlobalBus.emit("event", {
          directory: "global",
          payload: {
            type: ReadDocAudit.type,
            properties: { agentId: input.agentId, docPath: input.docPath, granted: false },
          },
        }),
      )
      yield* AuditEvent.record({
        kind: "access",
        action: "read_doc",
        actorAgentID: input.agentId,
        subjectID: input.docPath,
        subjectType: "workspace_doc",
        granted: false,
        metadata: { reason: "outside_workspace" },
      })
      return yield* Effect.fail(new Error(`read_doc: path outside workspace: ${input.docPath}`))
    }

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
      yield* AuditEvent.record({
        kind: "access",
        action: "read_doc",
        actorAgentID: input.agentId,
        subjectID: input.docPath,
        subjectType: "workspace_doc",
        granted: false,
        metadata: { reason: "missing" },
      })
      return yield* Effect.fail(new Error(`read_doc: file not found: ${input.docPath}`))
    }

    const content = yield* Effect.promise(() => file.text())
    const { frontMatter, body } = parseFrontMatter(content)
    const classification = frontMatter.classification ?? "public"

    const org = usableOrg(input.org)
    const edges = listEdges(input.agentId)
    const granted = org
      ? canSeeDocEnhanced(
          input.agentId,
          frontMatter,
          org,
          edges
            .filter((edge) => edge.toAgentId === input.agentId)
            .reduce((sum, edge) => sum + edge.clearanceModifier, 0),
          (groupId) => isGroupMember(groupId, input.agentId),
          makeDelegationChecker(input.agentId, edges),
        )
      : canSeeDocWithoutOrg(input.agentId, frontMatter)

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
    yield* AuditEvent.record({
      kind: "access",
      action: "read_doc",
      actorAgentID: input.agentId,
      subjectID: input.docPath,
      subjectType: "workspace_doc",
      granted,
      metadata: {
        classification,
        scope: frontMatter.scope ?? "public",
      },
    })

    if (!granted) {
      return yield* Effect.fail(
        new Error(
          `read_doc: access denied for agent "${input.agentId}" to "${input.docPath}" (classification: ${classification})`,
        ),
      )
    }

    return { content: body, frontMatter, granted: true }
  })
}
