import { createHash } from "node:crypto"
import {
  AcceptanceSummary,
  DiscoverySummary,
  GraphChangeSummary,
  OrganizationProjection,
  ValidationSummary,
} from "@agents-company/shared/experience"
import { createError, getQuery, getRouterParam } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import z from "zod"
import type { SeedGrowProjectExperience } from "../../shared/company-contract"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import {
  controlPlaneSDK,
  requestControlPlane,
  requestControlPlaneSDK,
} from "../utils/control-plane-client"

const ReceiptPage = z.object({
  page: z.coerce.number().int().positive().max(2_000).default(1),
  pageSize: z.coerce.number().int().positive().max(50).default(25),
})

async function mapConcurrent<T, U>(values: T[], concurrency: number, task: (value: T) => Promise<U>) {
  const cursor = { value: 0 }
  const results = new Array<U>(values.length)
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (cursor.value < values.length) {
        const index = cursor.value
        cursor.value += 1
        results[index] = await task(values[index]!)
      }
    }),
  )
  return results
}

export default defineAgentCompanyHandler(async (event): Promise<SeedGrowProjectExperience> => {
  const projectID = getRouterParam(event, "projectID")
  if (!projectID) throw createError({ statusCode: 400, statusMessage: "工作 ID 无效" })
  const page = ReceiptPage.safeParse(getQuery(event))
  if (!page.success) throw createError({ statusCode: 400, statusMessage: "Receipt 分页参数无效" })

  const config = useRuntimeConfig(event)
  const client = controlPlaneSDK(
    config.agentCompanyControlPlaneUrl,
    config.agentCompanyControlPlaneAuthorization || undefined,
  )
  if (!client) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const [acceptanceResult, organizationResult, graphResult, validationResult, receiptListResult] = await Promise.all([
    requestControlPlaneSDK<unknown>(client.experience.work.acceptance({ projectID })),
    requestControlPlaneSDK<unknown>(client.experience.work.organization({ projectID })),
    requestControlPlaneSDK<unknown>(client.experience.work.graph({ projectID })),
    requestControlPlaneSDK<unknown>(client.experience.work.validation({ projectID })),
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company-project/${encodeURIComponent(projectID)}/receipts?limit=${page.data.pageSize + 1}&offset=${(page.data.page - 1) * page.data.pageSize}`,
      config.agentCompanyControlPlaneAuthorization || undefined,
    ),
  ])
  if (!acceptanceResult.ok || !organizationResult.ok || !graphResult.ok || !validationResult.ok || !receiptListResult.ok)
    throw createError({ statusCode: 503, statusMessage: "动态组织投影暂时不可用" })

  const acceptance = AcceptanceSummary.safeParse(acceptanceResult.value)
  const organization = OrganizationProjection.safeParse(organizationResult.value)
  const graph = GraphChangeSummary.safeParse(graphResult.value)
  const validation = ValidationSummary.safeParse(validationResult.value)
  if (!acceptance.success || !organization.success || !graph.success || !validation.success)
    throw createError({ statusCode: 502, statusMessage: "动态组织投影响应无法识别" })

  const persistedReceiptIDs =
    Array.isArray(receiptListResult.value)
      ? receiptListResult.value.flatMap((receipt) =>
          typeof receipt === "object" &&
          receipt !== null &&
          "id" in receipt &&
          typeof receipt.id === "string"
            ? [receipt.id]
            : [],
        )
      : []
  const hasMore = persistedReceiptIDs.length > page.data.pageSize
  const pageUnavailable = page.data.page > 1 && persistedReceiptIDs.length === 0
  const receiptIds = [...new Set(persistedReceiptIDs.slice(0, page.data.pageSize))]
  const receiptResults = await mapConcurrent(
    receiptIds,
    4,
    (receiptID) =>
      requestControlPlaneSDK<unknown>(client.experience.work.receipt({ projectID, receiptID })),
  )
  if (receiptResults.some((result) => !result.ok))
    throw createError({ statusCode: 503, statusMessage: "Receipt 投影暂时不可用" })
  const discoveries = receiptResults.map((result) =>
    DiscoverySummary.safeParse(result.ok ? result.value : undefined),
  )
  if (discoveries.some((result) => !result.success))
    throw createError({ statusCode: 502, statusMessage: "Receipt 投影响应无法识别" })

  const overflow = hasMore
    ? DiscoverySummary.parse({
        availability: "unavailable",
        projectorVersion: 1,
        sourceWatermark: createHash("sha256")
          .update(`${projectID}:${persistedReceiptIDs[page.data.pageSize]}:${page.data.page}`)
          .digest("hex"),
        sourceRefs: [{ kind: "work_receipt", id: persistedReceiptIDs[page.data.pageSize]! }],
        updatedAt: new Date().toISOString(),
        receiptId: persistedReceiptIDs[page.data.pageSize]!,
        projectId: projectID,
        reason: {
          code: "projection_overflow",
          message: `Receipt 第 ${page.data.page} 页已达到 ${page.data.pageSize} 条上限，请读取下一页。`,
        },
      })
    : undefined
  return {
    acceptance: acceptance.data,
    organization: organization.data,
    graph: graph.data,
    validation: validation.data,
    discoveries: [
      ...discoveries.flatMap((result) => (result.success ? [result.data] : [])),
      ...(overflow ? [overflow] : []),
    ],
    receiptPage: {
      page: page.data.page,
      pageSize: page.data.pageSize,
      returned: receiptIds.length,
      availability: hasMore || pageUnavailable ? "unavailable" : "available",
      ...(hasMore
        ? { reason: "projection_overflow" as const }
        : pageUnavailable
          ? { reason: "page_unavailable" as const }
          : {}),
      ...(hasMore ? { nextPage: page.data.page + 1 } : {}),
    },
  }
})
