import { createError, readValidatedBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { CommonsSourceRecord } from "@agents-company/sdk/v2"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { commonsAccess } from "../utils/commons-context"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const Submission = z
  .object({
    source_type: z.enum(["text", "markdown", "url", "conversation_export"]),
    title: z.string().trim().min(1).max(500),
    content: z.string().max(10_000_000).optional(),
    url: z.string().trim().max(4_000).optional(),
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
    if (value.source_type !== "url" && !value.content?.trim())
      context.addIssue({ code: "custom", message: "Content is required", path: ["content"] })
    if (value.privacy_scope === "project" && !value.project_id)
      context.addIssue({ code: "custom", message: "Project is required", path: ["project_id"] })
  })

export default defineAgentCompanyHandler(async (event): Promise<CommonsSourceRecord> => {
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
  const result = await requestControlPlaneSDK<CommonsSourceRecord>(
    client.companyCommons.importSource({
      company_id: access.company_id,
      title: input.title,
      author: input.author,
      language: input.language,
      tags: input.tags,
      privacy_scope: input.privacy_scope,
      project_id: input.privacy_scope === "project" ? input.project_id : undefined,
      private_owner_id: input.privacy_scope === "private" ? access.private_owner_id : undefined,
      source_type: input.source_type,
      content: input.source_type === "url" ? undefined : input.content,
      url: input.source_type === "url" ? input.url : undefined,
    }),
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "资料导入未完成",
    })
  return result.value
})
