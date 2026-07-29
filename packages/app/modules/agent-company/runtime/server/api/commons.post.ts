import { createError, readValidatedBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyCommonsImportSourceResponses } from "@agents-company/sdk/v2"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const Submission = z
  .object({
    source_type: z.enum(["text", "markdown", "url", "conversation_export", "pdf", "image", "podcast", "video"]),
    title: z.string().trim().min(1).max(500),
    content: z.string().max(10_000_000).optional(),
    url: z.string().trim().max(4_000).optional(),
    content_base64: z.string().max(28_000_000).optional(),
    media_type: z.string().trim().min(1).max(255).optional(),
    privacy_scope: z.enum(["company", "project", "private"]),
    project_id: z.string().trim().min(1).optional(),
    author: z.string().trim().min(1).max(500).optional(),
    language: z.string().trim().min(1).max(64).optional(),
    tags: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source_type === "url" && !value.url)
      context.addIssue({ code: "custom", message: "URL is required", path: ["url"] })
    if (["text", "markdown", "conversation_export"].includes(value.source_type) && !value.content?.trim())
      context.addIssue({ code: "custom", message: "Content is required", path: ["content"] })
    if (
      ["pdf", "image", "podcast", "video"].includes(value.source_type) &&
      (!value.content_base64 || !value.media_type)
    )
      context.addIssue({ code: "custom", message: "Media payload is required", path: ["content_base64"] })
    if (value.privacy_scope === "project" && !value.project_id)
      context.addIssue({ code: "custom", message: "Project is required", path: ["project_id"] })
  })

export default defineAgentCompanyHandler(async (event): Promise<CompanyCommonsImportSourceResponses[200]> => {
  const input = await readValidatedBody(event, Submission.parse)
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const access = await commonsAccess(event, client)
  if (input.project_id && !access.project_ids.includes(input.project_id))
    throw createError({ statusCode: 403, statusMessage: "项目资料范围不可用" })
  const scope = input.privacy_scope === "project"
    ? { privacy_scope: input.privacy_scope, project_id: input.project_id! }
    : input.privacy_scope === "private"
      ? { privacy_scope: input.privacy_scope, private_owner_id: access.private_owner_id }
      : { privacy_scope: input.privacy_scope }
  const common = {
    company_id: access.company_id,
    title: input.title,
    author: input.author,
    language: input.language,
    tags: input.tags,
    ...scope,
  }
  const body = input.source_type === "url"
    ? { ...common, source_type: input.source_type, url: input.url! }
    : ["text", "markdown", "conversation_export"].includes(input.source_type)
      ? {
          ...common,
          source_type: input.source_type as "text" | "markdown" | "conversation_export",
          content: input.content!,
        }
      : {
          ...common,
          source_type: input.source_type as "pdf" | "image" | "podcast" | "video",
          content_base64: input.content_base64!,
          media_type: input.media_type!,
        }
  const result = await requestControlPlaneSDK<CompanyCommonsImportSourceResponses[200]>(
    client.companyCommons.importSource({ body }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "资料导入未完成",
    })
  return result.value
})
