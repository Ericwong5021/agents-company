import { createError, getRouterParam, readBody } from "h3"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { companyLearningMutation } from "../utils/company-learning"

export default defineAgentCompanyHandler(async (event) => {
  const beliefID = getRouterParam(event, "beliefID")
  if (!beliefID) throw createError({ statusCode: 400, statusMessage: "Belief ID 无效" })
  return companyLearningMutation(
    event,
    `/company-learning/beliefs/${encodeURIComponent(beliefID)}/adopt`,
    await readBody(event),
    access => ({ approved_by: access.private_owner_id }),
  )
})
