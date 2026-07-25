import { useRuntimeConfig } from "nitropack/runtime"
import type { CompanyConnectionIssue, CompanySnapshot, CompanySnapshotResource } from "../../shared/company-contract"
import {
  parseAgents,
  parseBoardChannel,
  parseCompany,
  parseHealth,
  parseMessages,
  parseReadiness,
  parseWorkProjections,
} from "../../shared/snapshot-contract"
import {
  controlPlaneURL,
  publicControlPlaneEndpoint,
  requestControlPlane,
  type ControlPlaneFailure,
} from "../utils/control-plane-client"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { observeSnapshot } from "../utils/snapshot-observability"

function issue(
  input: Omit<CompanyConnectionIssue, "diagnostic"> & {
    checkedAt: string
    endpoint: string
    statusCode?: number
    controlPlaneVersion?: string
    readiness?: "ready" | "blocked" | "unknown"
  },
): CompanyConnectionIssue {
  return {
    kind: input.kind,
    title: input.title,
    detail: input.detail,
    impact: input.impact,
    nextAction: input.nextAction,
    retryable: input.retryable,
    unavailable: input.unavailable,
    diagnostic: {
      checkedAt: input.checkedAt,
      endpoint: input.endpoint,
      issue: input.kind,
      statusCode: input.statusCode,
      controlPlaneVersion: input.controlPlaneVersion,
      readiness: input.readiness,
      unavailable: input.unavailable,
    },
  }
}

function unavailableSnapshot(connectionIssue: CompanyConnectionIssue): CompanySnapshot {
  return observeSnapshot({
    connection: "disconnected",
    issue: connectionIssue,
    company: {
      id: "",
      name: "Agent Company",
      provider: "未读取",
      approvalPolicy: "未读取",
    },
    stats: {},
    agents: [],
    messages: [],
    work: [],
    projects: [],
  })
}

function failureIssue(
  failure: ControlPlaneFailure,
  input: {
    checkedAt: string
    endpoint: string
    unavailable: CompanySnapshotResource[]
    controlPlaneVersion?: string
    phase: "health" | "readiness" | "company"
  },
) {
  if (failure.kind === "invalid_configuration") {
    return issue({
      kind: "invalid_configuration",
      title: "Control Plane 地址无效",
      detail: "当前本地服务地址不是受信任的回环 HTTP(S) 地址。",
      impact: "尚未读取任何真实公司数据。",
      nextAction: "修正 AGENT_COMPANY_CONTROL_PLANE_URL 后重新启动 WebUI。",
      retryable: false,
      unavailable: input.unavailable,
      checkedAt: input.checkedAt,
      endpoint: input.endpoint,
      controlPlaneVersion: input.controlPlaneVersion,
      readiness: input.phase === "readiness" ? "unknown" : undefined,
    })
  }
  if (failure.kind === "authorization_required") {
    return issue({
      kind: "authorization_required",
      title: "Control Plane 需要重新授权",
      detail: "本次连接未获得读取本地公司状态的权限。",
      impact: "尚未读取真实公司数据。",
      nextAction: "更新本地连接凭据后重新连接。",
      retryable: true,
      unavailable: input.unavailable,
      checkedAt: input.checkedAt,
      endpoint: input.endpoint,
      statusCode: failure.statusCode,
      controlPlaneVersion: input.controlPlaneVersion,
      readiness: input.phase === "readiness" ? "unknown" : undefined,
    })
  }
  if (failure.kind === "service_error" && failure.statusCode === 404 && input.phase !== "company") {
    return issue({
      kind: "version_mismatch",
      title: "Control Plane 版本与 WebUI 不匹配",
      detail: "本地服务缺少当前 WebUI 需要的健康或诊断接口。",
      impact: "为避免误读旧接口，工作区没有加载公司数据。",
      nextAction: "更新并重启 Control Plane 后重新连接。",
      retryable: true,
      unavailable: input.unavailable,
      checkedAt: input.checkedAt,
      endpoint: input.endpoint,
      statusCode: failure.statusCode,
      controlPlaneVersion: input.controlPlaneVersion,
      readiness: input.phase === "readiness" ? "unknown" : undefined,
    })
  }
  if (failure.kind === "service_error") {
    return issue({
      kind: "service_error",
      title: "Control Plane 返回服务错误",
      detail: "本地服务已响应，但没有完成真实公司状态读取。",
      impact: "当前页面不会展示可能过期或不完整的数据。",
      nextAction: "查看本地服务日志，修复错误后重新连接。",
      retryable: true,
      unavailable: input.unavailable,
      checkedAt: input.checkedAt,
      endpoint: input.endpoint,
      statusCode: failure.statusCode,
      controlPlaneVersion: input.controlPlaneVersion,
      readiness: input.phase === "readiness" ? "unknown" : undefined,
    })
  }
  return issue({
    kind: "service_unreachable",
    title: "无法连接本地 Control Plane",
    detail: "WebUI 没有收到本地服务响应。",
    impact: "尚未读取任何真实公司数据。",
    nextAction: "在仓库根目录运行 bun run dev，然后重新连接。",
    retryable: true,
    unavailable: input.unavailable,
    checkedAt: input.checkedAt,
    endpoint: input.endpoint,
    controlPlaneVersion: input.controlPlaneVersion,
    readiness: input.phase === "readiness" ? "unknown" : undefined,
  })
}

export default defineAgentCompanyHandler(async (event): Promise<CompanySnapshot> => {
  const config = useRuntimeConfig(event)
  const checkedAt = new Date().toISOString()
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) {
    return unavailableSnapshot(
      issue({
        kind: "invalid_configuration",
        title: "Control Plane 地址无效",
        detail: "当前本地服务地址不是可用的 HTTP(S) 地址。",
        impact: "尚未读取任何真实公司数据。",
        nextAction: "修正 AGENT_COMPANY_CONTROL_PLANE_URL 后重新启动 WebUI。",
        retryable: false,
        unavailable: ["company", "agents", "work", "channels", "messages"],
        checkedAt,
        endpoint: "invalid",
      }),
    )
  }

  const endpoint = publicControlPlaneEndpoint(baseURL)
  const authorization = config.agentCompanyControlPlaneAuthorization || undefined
  const allResources: CompanySnapshotResource[] = ["company", "agents", "work", "channels", "messages"]
  const healthResult = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    "/global/health",
    authorization,
  )
  if (!healthResult.ok) {
    return unavailableSnapshot(
      failureIssue(healthResult.failure, {
        checkedAt,
        endpoint,
        unavailable: allResources,
        phase: "health",
      }),
    )
  }
  const health = parseHealth(healthResult.value)
  if (!health.ok) {
    return unavailableSnapshot(
      issue({
        kind: "invalid_response",
        title: "Control Plane 健康响应无法识别",
        detail: "本地服务返回了不符合当前契约的健康状态。",
        impact: "为避免误读服务版本，工作区没有加载公司数据。",
        nextAction: "更新并重启 Control Plane 后重新连接。",
        retryable: true,
        unavailable: allResources,
        checkedAt,
        endpoint,
      }),
    )
  }

  const readinessResult = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    "/global/readiness",
    authorization,
  )
  if (!readinessResult.ok) {
    return unavailableSnapshot(
      failureIssue(readinessResult.failure, {
        checkedAt,
        endpoint,
        unavailable: allResources,
        controlPlaneVersion: health.value,
        phase: "readiness",
      }),
    )
  }
  const readiness = parseReadiness(readinessResult.value)
  if (!readiness.ok) {
    return unavailableSnapshot(
      issue({
        kind: "invalid_response",
        title: "Control Plane 诊断响应无法识别",
        detail: "本地服务返回了不符合当前契约的就绪状态。",
        impact: "数据库与迁移状态尚未确认，工作区没有加载公司数据。",
        nextAction: "更新并重启 Control Plane 后重新连接。",
        retryable: true,
        unavailable: allResources,
        checkedAt,
        endpoint,
        controlPlaneVersion: health.value,
        readiness: "unknown",
      }),
    )
  }
  if (!readiness.value.ready || readiness.value.checks.some((entry) => entry.status === "fail")) {
    return unavailableSnapshot(
      issue({
        kind: "migration_required",
        title: "Control Plane 数据库尚未就绪",
        detail: "本地服务报告数据库或迁移检查失败。",
        impact: "为保护现有数据，工作区没有继续读取公司状态。",
        nextAction: "查看 Control Plane 启动日志并完成迁移后重新连接。",
        retryable: true,
        unavailable: allResources,
        checkedAt,
        endpoint,
        controlPlaneVersion: health.value,
        readiness: "blocked",
      }),
    )
  }

  const companyResult = await requestControlPlane<unknown>(
    config.agentCompanyControlPlaneUrl,
    "/company",
    authorization,
  )
  if (!companyResult.ok) {
    return unavailableSnapshot(
      failureIssue(companyResult.failure, {
        checkedAt,
        endpoint,
        unavailable: allResources,
        controlPlaneVersion: health.value,
        phase: "company",
      }),
    )
  }
  const company = parseCompany(companyResult.value)
  if (!company.ok) {
    return unavailableSnapshot(
      issue({
        kind: "invalid_response",
        title: "Control Plane 公司状态无法识别",
        detail: "本地服务返回了不符合当前契约的公司数据。",
        impact: "页面不会用默认值伪造员工、项目或进度。",
        nextAction: "检查 Control Plane 版本和数据诊断后重新连接。",
        retryable: true,
        unavailable: allResources,
        checkedAt,
        endpoint,
        controlPlaneVersion: health.value,
        readiness: "ready",
      }),
    )
  }

  const [agentsResult, workResult, channelsResult] = await Promise.all([
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company/agents?company_id=${encodeURIComponent(company.value.id)}`,
      authorization,
    ),
    requestControlPlane<unknown>(config.agentCompanyControlPlaneUrl, "/experience/work", authorization),
    requestControlPlane<unknown>(
      config.agentCompanyControlPlaneUrl,
      `/company/channels?company_id=${encodeURIComponent(company.value.id)}`,
      authorization,
    ),
  ])
  const agents = agentsResult.ok ? parseAgents(agentsResult.value) : { ok: false as const }
  const work = workResult.ok ? parseWorkProjections(workResult.value) : { ok: false as const }
  const board = channelsResult.ok ? parseBoardChannel(channelsResult.value) : { ok: false as const }
  const messagesResult =
    board.ok && board.value
      ? await requestControlPlane<unknown>(
          config.agentCompanyControlPlaneUrl,
          `/company/channels/${encodeURIComponent(board.value)}/messages?company_id=${encodeURIComponent(company.value.id)}&limit=30`,
          authorization,
        )
      : board.ok
        ? { ok: true as const, value: { items: [] } }
        : { ok: false as const }
  const messages =
    messagesResult.ok && agents.ok ? parseMessages(messagesResult.value, agents.value) : { ok: false as const }
  const unavailable = [
    !agents.ok ? ("agents" as const) : undefined,
    !work.ok ? ("work" as const) : undefined,
    !board.ok ? ("channels" as const) : undefined,
    !messages.ok ? ("messages" as const) : undefined,
  ].filter((resource): resource is Exclude<CompanySnapshotResource, "company"> => resource !== undefined)
  const providerRequired = company.value.provider === null
  const connectionIssue = unavailable.length
    ? issue({
        kind: "partial_data",
        title: "部分真实数据暂时不可用",
        detail: "页面只显示已通过契约验证的数据，未加载区域不会被当成空数据。",
        impact: "员工、工作或消息中的部分区域可能暂时隐藏。",
        nextAction: "重新连接；若问题持续，请复制诊断并查看 Control Plane 日志。",
        retryable: true,
        unavailable,
        checkedAt,
        endpoint,
        controlPlaneVersion: health.value,
        readiness: "ready",
      })
    : providerRequired
      ? issue({
          kind: "provider_required",
          title: "还未连接模型 Provider",
          detail: "Control Plane 与公司数据已就绪，但团队暂时不能开始新目标。",
          impact: "可以查看真实历史数据，新的 Agent 执行会保持停用。",
          nextAction: "在设置中连接 Provider 并选择模型。",
          retryable: false,
          unavailable: [],
          checkedAt,
          endpoint,
          controlPlaneVersion: health.value,
          readiness: "ready",
        })
      : undefined
  const availableAgents = agents.ok ? agents.value : []
  const availableWork = work.ok ? work.value : []
  const projectedWork = availableWork.filter((item) => item.availability === "available")
  const fullyProjectedWork = work.ok && projectedWork.length === availableWork.length
  const availableMessages = messages.ok ? messages.value : []

  return observeSnapshot({
    connection: connectionIssue ? "degraded" : "ready",
    issue: connectionIssue,
    company: {
      id: company.value.id,
      name: company.value.name,
      provider: company.value.provider
        ? `${company.value.provider.providerID} / ${company.value.provider.modelID}`
        : "未配置",
      providerConfigured: !providerRequired,
      approvalPolicy: company.value.policy,
      setupGoal: company.value.setupGoal,
    },
    stats: {
      ...(agents.ok ? { online: availableAgents.filter((agent) => agent.presence === "online").length } : {}),
      ...(fullyProjectedWork
        ? {
            activeProjects: projectedWork.filter(
              (item) => !["accepted", "failed", "cancelled"].includes(item.summary.userStatus),
            ).length,
          }
        : {}),
      ...(messages.ok ? { boardMessages: availableMessages.length } : {}),
    },
    agents: availableAgents,
    messages: availableMessages,
    work: availableWork,
    projects: availableWork.map((item) =>
      item.availability === "available"
        ? {
            id: item.summary.workId,
            title: item.summary.title,
            status: item.summary.userStatus,
            progress: item.progress.percent,
          }
        : {
            id: item.workId,
            title: item.title,
            status: "状态不可用",
          },
    ),
    notice: connectionIssue?.detail,
  })
})
