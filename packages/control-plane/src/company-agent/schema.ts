import { Schema } from "effect"
import z from "zod"
import { withStatics } from "@/util/schema"

const companyAgentIdSchema = Schema.String.pipe(Schema.brand("CompanyAgentID"))

export type CompanyAgentID = typeof companyAgentIdSchema.Type

export const CompanyAgentID = companyAgentIdSchema.pipe(
  withStatics((schema: typeof companyAgentIdSchema) => ({
    default: schema.make("assistant"),
    zod: z.string().pipe(z.custom<CompanyAgentID>()),
  })),
)
