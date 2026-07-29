import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import z from "zod"
import { CompanyAgent } from "@/company-agent"
import { CompanyRecruitment } from "@/company-recruitment"
import {
  CreateCapabilityNeedInput,
  DepartmentRecurringDemandNotProven,
  EnsureDepartmentInput,
  PerformanceProjectNotCompleted,
  RecordPerformanceInput,
  RecruitmentQuery,
  ReviewEmploymentInput,
  SelectForNeedInput,
} from "@/company-recruitment/schema"
import { CompanyID } from "@/company/schema"
import { AppRuntime } from "@/effect/app-runtime"
import { lazy } from "@/util/lazy"
import { namedErrorResponse } from "../error"

const departmentConflict = namedErrorResponse("Recurring department demand is not proven", [
  DepartmentRecurringDemandNotProven.Schema,
] as const)
const performanceConflict = namedErrorResponse("Project delivery is not completed", [
  PerformanceProjectNotCompleted.Schema,
] as const)

export const CompanyRecruitmentRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        operationId: "company.recruitment.snapshot",
        summary: "List capability needs, team decisions, candidate lifecycle, employment reviews and departments",
        responses: { 200: { description: "Recruitment and organization facts" } },
      }),
      validator("query", RecruitmentQuery),
      async (c) => {
        const snapshot = await AppRuntime.runPromise(
          CompanyRecruitment.Service.use((service) => service.snapshot(c.req.valid("query"))),
        )
        return c.json({
          ...snapshot,
          candidate_pool: snapshot.candidate_pool.map(CompanyAgent.toPublicInfo),
          assigned_candidates: snapshot.assigned_candidates.map(CompanyAgent.toPublicInfo),
        })
      },
    )
    .post(
      "/needs",
      describeRoute({
        operationId: "company.recruitment.need.create",
        summary: "Persist a project capability need",
        responses: { 200: { description: "Capability need" } },
      }),
      validator("json", CreateCapabilityNeedInput),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            CompanyRecruitment.Service.use((service) => service.createNeed(c.req.valid("json"))),
          ),
        ),
    )
    .post(
      "/needs/:needID/select",
      describeRoute({
        operationId: "company.recruitment.need.select",
        summary: "Select the smallest available team member and preserve rejection reasons",
        responses: { 200: { description: "Selection result" } },
      }),
      validator("param", z.object({ needID: z.string().min(1) })),
      validator("json", SelectForNeedInput.omit({ capability_need_id: true })),
      async (c) => {
        const result = await AppRuntime.runPromise(
          CompanyRecruitment.Service.use((service) =>
            service.selectAndAssign({
              capability_need_id: c.req.valid("param").needID,
              ...c.req.valid("json"),
            }),
          ),
        )
        return c.json({ ...result, agent: CompanyAgent.toPublicInfo(result.agent) })
      },
    )
    .post(
      "/projects/:projectID/release",
      describeRoute({
        operationId: "company.recruitment.project.release",
        summary: "Return assigned candidates to the reusable candidate pool",
        responses: { 200: { description: "Released assignments" } },
      }),
      validator("param", z.object({ projectID: z.string().min(1) })),
      validator("json", z.object({ company_id: CompanyID }).strict()),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            CompanyRecruitment.Service.use((service) =>
              service.releaseProject({
                company_id: c.req.valid("json").company_id,
                project_id: c.req.valid("param").projectID,
              }),
            ),
          ),
        ),
    )
    .post(
      "/selections/:selectionID/performance",
      describeRoute({
        operationId: "company.recruitment.performance.record",
        summary: "Record delivery quality, reliability, cost and speed for a selected candidate",
        responses: {
          200: { description: "Performance fact" },
          409: performanceConflict,
        },
      }),
      validator("param", z.object({ selectionID: z.string().min(1) })),
      validator("json", RecordPerformanceInput.omit({ selection_id: true })),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            CompanyRecruitment.Service.use((service) =>
              service.recordPerformance({
                selection_id: c.req.valid("param").selectionID,
                ...c.req.valid("json"),
              }),
            ),
          ),
        ),
    )
    .post(
      "/agents/:agentID/employment-review",
      describeRoute({
        operationId: "company.recruitment.employmentReview",
        summary: "Evaluate and govern promotion from reusable candidate to formal employee",
        responses: { 200: { description: "Employment review and eligibility evidence" } },
      }),
      validator("param", z.object({ agentID: z.string().min(1) })),
      validator("json", ReviewEmploymentInput.omit({ agent_id: true })),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            CompanyRecruitment.Service.use((service) =>
              service.reviewEmployment({
                agent_id: c.req.valid("param").agentID,
                ...c.req.valid("json"),
              }),
            ),
          ),
        ),
    )
    .post(
      "/departments",
      describeRoute({
        operationId: "company.recruitment.department.ensure",
        summary: "Create a department only after recurring need is proven across projects",
        responses: {
          200: { description: "Department" },
          409: departmentConflict,
        },
      }),
      validator("json", EnsureDepartmentInput),
      async (c) =>
        c.json(
          await AppRuntime.runPromise(
            CompanyRecruitment.Service.use((service) => service.ensureDepartment(c.req.valid("json"))),
          ),
        ),
    ),
)
