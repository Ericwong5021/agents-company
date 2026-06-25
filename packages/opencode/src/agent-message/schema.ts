import { Schema } from "effect"
import z from "zod"
import { Identifier } from "@/id/id"
import { ZodOverride } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

const agentMessageIdSchema = Schema.String.annotate({ [ZodOverride]: Identifier.schema("message") }).pipe(
  Schema.brand("AgentMessageID"),
)

export type AgentMessageID = typeof agentMessageIdSchema.Type

export const AgentMessageID = agentMessageIdSchema.pipe(
  withStatics((schema: typeof agentMessageIdSchema) => ({
    ascending: (id?: string) => schema.make(Identifier.ascending("message", id)),
    zod: Identifier.schema("message").pipe(z.custom<AgentMessageID>()),
  })),
)

export const AgentMessageKind = z.enum(["fyi", "request", "reply", "proposal"])
export type AgentMessageKind = z.infer<typeof AgentMessageKind>
