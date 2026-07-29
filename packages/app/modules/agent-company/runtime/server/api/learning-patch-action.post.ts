import { createError, getRouterParam, readBody } from "h3"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { companyLearningMutation } from "../utils/company-learning"

export default defineAgentCompanyHandler(async (event) => {
  const patchID = getRouterParam(event, "patchID")
  if (!patchID) throw createError({ statusCode: 400, statusMessage: "Patch ID 无效" })
  const input = await readBody<Record<string, unknown>>(event)
  return companyLearningMutation(
    event,
    `/company-learning/patches/${encodeURIComponent(patchID)}/actions`,
    input,
    access => input.action === "record_benchmark"
      ? {}
      : input.action === "approve"
        ? { actor_kind: "human", actor_id: access.private_owner_id }
        : { actor_id: access.private_owner_id },
  )
})
