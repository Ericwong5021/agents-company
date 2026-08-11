import { createError, readBody } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import z from "zod"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneSDK, requestControlPlaneSDK } from "../utils/control-plane-client"

const Input = z.object({ approval_preset: z.enum(["autonomous", "balanced", "strict"]) }).strict()

export default defineAgentCompanyHandler(async (event) => {
  const parsed = Input.safeParse(await readBody(event))
  if (!parsed.success) throw createError({ statusCode: 400, statusMessage: "审批策略无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const result = await requestControlPlaneSDK(
    client.company.approvalPolicyUpdate({
      approvalPolicyUpdateInput: { preset: parsed.data.approval_preset },
    }),
  )
  if (result.ok) return result.value
  throw createError({
    statusCode: result.failure.statusCode ?? 502,
    statusMessage: "审批策略未保存",
  })
})
