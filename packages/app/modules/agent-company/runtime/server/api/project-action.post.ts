import {
  ExperienceWorkActionRequest,
  GoalBriefDraft,
} from "@agents-company/shared/experience"
import { createError, getRouterParam, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  classifyControlPlaneFailure,
  controlPlaneRequestURL,
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const AdjustBrief = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(500),
    expectedGraphRevision: z.number().int().nonnegative(),
    action: z.literal("adjust_brief"),
    attentionId: z.string().trim().min(1).optional(),
    briefId: z.string().trim().min(1),
    expectedBriefVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    source: z.enum(["user_input", "system_suggestion", "user_confirmation"]),
    brief: GoalBriefDraft,
    changeReason: z.string().trim().min(1).max(8_000),
  })
  .strict()

const Input = z.union([ExperienceWorkActionRequest, AdjustBrief])

export default defineAgentCompanyHandler(async (event) => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "工作动作无效" })

  const config = useRuntimeConfig(event)
  if (parsed.data.action === "adjust_brief") {
    const target = controlPlaneRequestURL(
      config.agentCompanyControlPlaneUrl,
      `/experience/work/${encodeURIComponent(projectID)}/actions`,
    )
    if (!target) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
    return ofetch(target.toString(), {
      method: "POST",
      headers: config.agentCompanyControlPlaneAuthorization
        ? { authorization: config.agentCompanyControlPlaneAuthorization }
        : undefined,
      body: parsed.data,
      timeout: 5_000,
    }).catch((error: unknown) => {
      const failure = classifyControlPlaneFailure(error)
      throw createError({
        statusCode: failure.statusCode ?? 503,
        statusMessage: "调整方向未被本地服务接受",
      })
    })
  }

  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const result = await requestControlPlaneSDK(
    client.experience.work.action({ projectID, body: parsed.data }),
  )
  if (result.ok) return result.value
  throw createError({
    statusCode: result.failure.statusCode ?? 503,
    statusMessage: "工作动作未被本地服务接受",
  })
})
