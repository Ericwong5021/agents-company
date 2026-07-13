import z from "zod"
import { Effect } from "effect"
import { CompanyAgent } from "@/company-agent"
import { TemplateService } from "@/company-agent/template"
import { Session } from "@/session"
import { SessionID } from "@/session/schema"
import type { CompanyAgentID } from "@/company-agent/schema"
import * as Tool from "./tool"
import DESCRIPTION from "./recruit.txt"

const Parameters = z.object({
  query: z.string().min(1).describe("Role / keywords to match a template, e.g. 'frontend engineer' or 'growth lead'."),
  division: z
    .string()
    .optional()
    .describe("Optional division to narrow the search, e.g. 'engineering', 'marketing', 'design'."),
  name: z.string().optional().describe("Optional display name override for the new hire."),
  department: z
    .string()
    .optional()
    .describe("Optional department to place the new hire in (defaults to the template's division)."),
  reason: z.string().min(1).describe("Why this hire is needed now — shown to the founder for confirmation."),
})

type Metadata = {
  recruitedID?: string
  templateSlug?: string
}

// Turn a template into a stable, unique, lowercase-dashed agent id.
function slugify(division: string, slug: string) {
  return `${division}-${slug}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

export const RecruitTool = Tool.define<typeof Parameters, Metadata, CompanyAgent.Service | Session.Service>(
  "recruit",
  Effect.gen(function* () {
    const companyAgentSvc = yield* CompanyAgent.Service
    const sessionSvc = yield* Session.Service

    return {
      description: DESCRIPTION,
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const match = TemplateService.search(params.query, { division: params.division, limit: 1 })[0]
          if (!match) {
            throw new Error(
              `No matching template for "${params.query}"${params.division ? ` in division "${params.division}"` : ""}. Try a broader query or drop the division.`,
            )
          }

          // Who is doing the hiring — the new member reports to them.
          const session = yield* sessionSvc.get(SessionID.make(ctx.sessionID))
          const recruiterID = ctx.companyAgentID ?? session.companyAgentID ?? ("onboarding-assistant" as CompanyAgentID)

          // Ensure a unique id (the same template can be hired more than once).
          const baseID = slugify(match.division, match.slug)
          let id = baseID
          for (
            let n = 2;
            yield* companyAgentSvc.get(id as CompanyAgentID).pipe(Effect.catch(() => Effect.succeed(undefined)));
            n++
          ) {
            id = `${baseID}-${n}`
          }

          const displayName = params.name ?? match.name

          // Hiring is consequential — get the founder's confirmation first.
          yield* ctx.ask({
            permission: "recruit",
            patterns: [id],
            always: [],
            metadata: { name: displayName, template: `${match.division}/${match.slug}`, reason: params.reason },
          })

          const created = yield* companyAgentSvc.create({
            id,
            name: displayName,
            description: match.description,
            system_prompt: match.system_prompt,
            color: match.color,
            icon: match.emoji,
            org_layer: "execution",
            department: params.department ?? match.division,
            reports_to: recruiterID,
          })

          return {
            title: `Recruited ${created.name}`,
            output: [
              `Recruited **${created.name}** (${created.icon ?? ""}) into the company.`,
              `- Agent ID: ${created.id}`,
              `- Department: ${params.department ?? match.division}`,
              `- Reports to: ${recruiterID}`,
              `- Based on template: ${match.division}/${match.slug}`,
              ``,
              `Brief them on the company thesis and their first task to get them started.`,
            ].join("\n"),
            metadata: { recruitedID: created.id, templateSlug: match.slug },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
