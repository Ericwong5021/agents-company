import {
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"
import { createError, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import type { SeedGrowProjectExperience } from "../../shared/company-contract"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

export default defineAgentCompanyHandler(async (event): Promise<SeedGrowProjectExperience> => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })

  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const [organizationResult, graphResult, validationResult, receiptListResult] = await Promise.all([
    requestControlPlaneSDK<unknown>(client.experience.work.organization({ projectID })),
    requestControlPlaneSDK<unknown>(client.experience.work.graph({ projectID })),
    requestControlPlaneSDK<unknown>(client.experience.work.validation({ projectID })),
    requestControlPlaneSDK<unknown>(client.companyProject.receipts({ projectID })),
  ])
  if (!organizationResult.ok || !graphResult.ok || !validationResult.ok)
    throw createError({ statusCode: 503, statusMessage: "动态组织投影暂时不可用" })

  const organization = OrganizationProjection.safeParse(organizationResult.value)
  const graph = GraphChangeSummary.safeParse(graphResult.value)
  const validation = ValidationSummary.safeParse(validationResult.value)
  if (!organization.success || !graph.success || !validation.success)
    throw createError({ statusCode: 502, statusMessage: "动态组织投影响应无法识别" })

  const persistedReceiptIDs =
    receiptListResult.ok && Array.isArray(receiptListResult.value)
      ? receiptListResult.value.flatMap((receipt) =>
          typeof receipt === "object" &&
          receipt !== null &&
          "id" in receipt &&
          typeof receipt.id === "string"
            ? [receipt.id]
            : [],
        )
      : []
  const receiptIds = [
    ...new Set([
      ...persistedReceiptIDs,
      ...(graph.data.availability === "available"
        ? graph.data.changes.map((change) => change.triggerReceiptId)
        : []),
    ]),
  ]
  const receiptResults = await Promise.all(
    receiptIds.map((receiptID) =>
      requestControlPlaneSDK<unknown>(client.experience.work.receipt({ projectID, receiptID })),
    ),
  )
  if (receiptResults.some((result) => !result.ok))
    throw createError({ statusCode: 503, statusMessage: "Receipt 投影暂时不可用" })
  const discoveries = receiptResults.map((result) =>
    DiscoverySummary.safeParse(result.ok ? result.value : undefined),
  )
  if (discoveries.some((result) => !result.success))
    throw createError({ statusCode: 502, statusMessage: "Receipt 投影响应无法识别" })

  return {
    organization: organization.data,
    graph: graph.data,
    validation: validation.data,
    discoveries: discoveries.flatMap((result) => (result.success ? [result.data] : [])),
  }
})
