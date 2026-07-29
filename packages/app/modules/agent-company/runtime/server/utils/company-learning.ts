import type { H3Event } from "h3"
import { createError } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { commonsAccess } from "./commons-context"
import {
  controlPlaneSDK,
  writeControlPlane,
} from "./control-plane-client"

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

export async function companyLearningMutation(
  event: H3Event,
  path: string,
  input: unknown,
  bind: (access: Awaited<ReturnType<typeof commonsAccess>>) => Record<string, unknown> = () => ({}),
) {
  if (!record(input)) throw createError({ statusCode: 400, statusMessage: "Learning 操作输入无效" })
  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const result = await writeControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    path,
    { ...input, ...bind(await commonsAccess(event, client)) },
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!result.ok)
    throw createError({
      statusCode: result.failure.statusCode ?? 503,
      statusMessage: "Learning 操作未写入",
    })
  return result.value
}
