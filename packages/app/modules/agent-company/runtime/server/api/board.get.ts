import { createError, getQuery } from "h3"
import { useRuntimeConfig } from "nitropack/runtime"
import { ofetch } from "ofetch"
import type { CompanyBoardThread } from "../../shared/company-contract"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { controlPlaneURL } from "../utils/control-plane-client"

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function text(value: unknown) {
  return typeof value === "string" ? value : ""
}

export default defineAgentCompanyHandler(async (event): Promise<CompanyBoardThread> => {
  const threadID = text(getQuery(event).thread_id)
  if (!threadID.startsWith("cth_")) throw createError({ statusCode: 400, statusMessage: "Invalid board thread" })

  const config = useRuntimeConfig(event)
  const baseURL = controlPlaneURL(config.agentCompanyControlPlaneUrl)
  if (!baseURL) throw createError({ statusCode: 503, statusMessage: "Control Plane 配置不可用" })
  const headers = config.agentCompanyControlPlaneAuthorization
    ? { authorization: config.agentCompanyControlPlaneAuthorization }
    : undefined
  const request = (path: string) => ofetch<unknown>(new URL(path, baseURL).toString(), { headers })
  const state = await request("/company")
  if (!record(state) || !record(state.company)) {
    throw createError({ statusCode: 503, statusMessage: "Company is not ready" })
  }

  const companyID = text(state.company.id)
  const query = `company_id=${encodeURIComponent(companyID)}`
  const [thread, entries] = await Promise.all([
    request(`/company/threads/${encodeURIComponent(threadID)}?${query}`),
    request(`/company/threads/${encodeURIComponent(threadID)}/entries?${query}&limit=100`),
  ])
  if (!record(thread)) throw createError({ statusCode: 404, statusMessage: "Board thread was not found" })

  const items = record(entries) && Array.isArray(entries.items) ? entries.items : []
  const messages = items
    .flatMap((entry) => {
      if (!record(entry) || entry.type !== "agent_message" || !record(entry.message)) return []
      const created =
        record(entry.message.time) && typeof entry.message.time.created === "number" ? entry.message.time.created : 0
      return [
        {
          id: text(entry.message.id),
          agentID: text(entry.message.agentID),
          body: text(entry.message.body),
          status: text(entry.message.status) || undefined,
          time: created
            ? new Intl.DateTimeFormat("en", { hour: "2-digit", minute: "2-digit" }).format(new Date(created))
            : "",
        },
      ]
    })
    .reverse()
  const bidding = items.find((entry) => record(entry) && entry.type === "bidding" && record(entry.bidding))
  const run = record(thread.run) ? thread.run : undefined

  return {
    id: text(thread.id),
    projectID: text(thread.projectScopeID) || undefined,
    status: thread.status === "completed" || thread.status === "interrupted" ? thread.status : "active",
    run: run
      ? {
          state:
            run.state === "queued" ||
            run.state === "projecting" ||
            run.state === "completed" ||
            run.state === "failed" ||
            run.state === "interrupted"
              ? run.state
              : "running",
          retryable: run.retryable === true,
          error: text(run.safeErrorSummary) || undefined,
        }
      : undefined,
    messages,
    bidding:
      record(bidding) && record(bidding.bidding)
        ? {
            roundNum: typeof bidding.bidding.roundNum === "number" ? bidding.bidding.roundNum : 0,
            state: bidding.bidding.state === "bidding" ? "bidding" : "decided",
            winnerAgentID: text(bidding.bidding.winnerAgentID) || undefined,
          }
        : undefined,
  }
})
