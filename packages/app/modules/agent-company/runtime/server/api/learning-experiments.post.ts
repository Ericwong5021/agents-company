import { readBody } from "h3"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { companyLearningMutation } from "../utils/company-learning"

export default defineAgentCompanyHandler(async (event) =>
  companyLearningMutation(
    event,
    "/company-learning/experiments",
    await readBody(event),
    access => ({ company_id: access.company_id, proposed_by: access.private_owner_id }),
  ))
