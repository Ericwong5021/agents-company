import { Schema } from "effect"
import z from "zod"
import { withStatics } from "@/util/schema"
import { Identifier } from "@/id/id"
import { ZodOverride } from "@/util/effect-zod"

export const GroupSessionID = Schema.String.annotate({ [ZodOverride]: Identifier.schema("session") }).pipe(
  Schema.brand("GroupSessionID"),
  withStatics((s) => ({
    ascending: (id?: string) => s.make(Identifier.ascending("session", id)),
    zod: Identifier.schema("session").pipe(z.custom<Schema.Schema.Type<typeof s>>()),
  })),
)

export type GroupSessionID = Schema.Schema.Type<typeof GroupSessionID>
