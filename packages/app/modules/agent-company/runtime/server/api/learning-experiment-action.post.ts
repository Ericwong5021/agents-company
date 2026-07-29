import { createError, getRouterParam, readBody } from "h3"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { companyLearningMutation } from "../utils/company-learning"

export default defineAgentCompanyHandler(async (event) => {
  const experimentID = getRouterParam(event, "experimentID")
  if (!experimentID) throw createError({ statusCode: 400, statusMessage: "Experiment ID 无效" })
  return companyLearningMutation(
    event,
    `/company-learning/experiments/${encodeURIComponent(experimentID)}/actions`,
    await readBody(event),
    access => ({ actor_id: access.private_owner_id }),
  )
})
