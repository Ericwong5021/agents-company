import { readBody } from "h3"
import { defineAgentCompanyHandler } from "../utils/authenticated-handler"
import { companyLearningMutation } from "../utils/company-learning"

export default defineAgentCompanyHandler(async (event) =>
  companyLearningMutation(event, "/company-learning/beliefs/compare", await readBody(event)))
