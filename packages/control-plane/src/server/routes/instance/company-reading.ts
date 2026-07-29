import { Effect } from "effect"
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  AgentInterestProfile,
  AgentInterestProfileInput,
  CompanyReading,
  Interpretation,
  KnowledgeReadingReceipt,
  ReadingAssignment,
  ReadingScheduleInput,
  ReadingScheduleResult,
} from "@/company-reading"
import { CommonsAccess } from "@/company-commons"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const AccessQuery = z.object({
  company_id: z.string().trim().min(1),
  project_ids: z
    .string()
    .default("")
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean)),
  private_owner_id: z.string().trim().min(1).optional(),
})

export const CompanyReadingRoutes = lazy(() =>
  new Hono()
    .get(
      "/interpretations",
      describeRoute({
        summary: "List privacy-filtered Commons Interpretations",
        operationId: "companyReading.interpretations",
        responses: {
          200: {
            description: "Interpretations",
            content: { "application/json": { schema: resolver(z.array(Interpretation)) } },
          },
        },
      }),
      validator("query", AccessQuery.extend({ project_id: z.string().trim().min(1).optional() })),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.interpretations", c, function* () {
          const query = c.req.valid("query")
          return yield* (yield* CompanyReading.Service).listInterpretations(
            CommonsAccess.parse(query),
            query.project_id,
          )
        }),
    )
    .post(
      "/interpretations",
      describeRoute({
        summary: "Persist a cited KNOWLEDGE_READING Interpretation",
        operationId: "companyReading.createInterpretation",
        responses: {
          200: {
            description: "Interpretation",
            content: { "application/json": { schema: resolver(Interpretation) } },
          },
        },
      }),
      validator("json", z.object({ access: CommonsAccess, receipt: KnowledgeReadingReceipt }).strict()),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.createInterpretation", c, function* () {
          return yield* (yield* CompanyReading.Service).createInterpretation(
            c.req.valid("json").receipt,
            c.req.valid("json").access,
          )
        }),
    )
    .post(
      "/receipts/:receiptID/consume",
      describeRoute({
        summary: "Deterministically consume a typed KNOWLEDGE_READING Work Receipt",
        operationId: "companyReading.consumeReceipt",
        responses: {
          200: {
            description: "Interpretation",
            content: { "application/json": { schema: resolver(Interpretation) } },
          },
        },
      }),
      validator("param", z.object({ receiptID: z.string().trim().min(1) })),
      validator("json", CommonsAccess),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.consumeReceipt", c, function* () {
          return yield* (yield* CompanyReading.Service).consumeReceipt(
            c.req.valid("param").receiptID,
            c.req.valid("json"),
          )
        }),
    )
    .get(
      "/profiles",
      describeRoute({
        summary: "List Agent Interest Profiles",
        operationId: "companyReading.profiles",
        responses: {
          200: {
            description: "Profiles",
            content: { "application/json": { schema: resolver(z.array(AgentInterestProfile)) } },
          },
        },
      }),
      validator("query", z.object({ company_id: z.string().trim().min(1) })),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.profiles", c, function* () {
          return yield* (yield* CompanyReading.Service).listProfiles(c.req.valid("query").company_id)
        }),
    )
    .put(
      "/profiles/:agentID",
      describeRoute({
        summary: "Create or replace an Agent Interest Profile",
        operationId: "companyReading.upsertProfile",
        responses: {
          200: {
            description: "Profile",
            content: { "application/json": { schema: resolver(AgentInterestProfile) } },
          },
        },
      }),
      validator("param", z.object({ agentID: z.string().trim().min(1) })),
      validator("json", AgentInterestProfileInput.omit({ agent_id: true })),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.upsertProfile", c, function* () {
          return yield* (yield* CompanyReading.Service).upsertProfile({
            ...c.req.valid("json"),
            agent_id: c.req.valid("param").agentID,
          })
        }),
    )
    .get(
      "/assignments",
      describeRoute({
        summary: "List privacy-filtered reading assignments",
        operationId: "companyReading.assignments",
        responses: {
          200: {
            description: "Assignments",
            content: { "application/json": { schema: resolver(z.array(ReadingAssignment)) } },
          },
        },
      }),
      validator("query", AccessQuery),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.assignments", c, function* () {
          return yield* (yield* CompanyReading.Service).listAssignments(
            CommonsAccess.parse(c.req.valid("query")),
          )
        }),
    )
    .post(
      "/schedule",
      describeRoute({
        summary: "Score and schedule bounded Commons reading through the Orchestrator",
        operationId: "companyReading.schedule",
        responses: {
          200: {
            description: "Schedule result",
            content: { "application/json": { schema: resolver(ReadingScheduleResult) } },
          },
        },
      }),
      validator("json", ReadingScheduleInput),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.schedule", c, function* () {
          return yield* (yield* CompanyReading.Service).schedule(c.req.valid("json"))
        }),
    )
    .post(
      "/assignments/:assignmentID/stop",
      describeRoute({
        summary: "Stop a reading assignment through the Orchestrator",
        operationId: "companyReading.stop",
        responses: {
          200: {
            description: "Stopped assignment",
            content: { "application/json": { schema: resolver(ReadingAssignment) } },
          },
        },
      }),
      validator("param", z.object({ assignmentID: z.string().trim().min(1) })),
      validator("json", CommonsAccess),
      async (c) =>
        jsonRequest("CompanyReadingRoutes.stop", c, function* () {
          const assignment = yield* (yield* CompanyReading.Service).stop(
            c.req.valid("param").assignmentID,
            c.req.valid("json"),
          )
          if (!assignment) return yield* Effect.fail(new Error("Reading assignment not found"))
          return assignment
        }),
    ),
)
