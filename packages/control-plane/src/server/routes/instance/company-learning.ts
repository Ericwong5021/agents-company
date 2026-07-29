import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import {
  Belief,
  BeliefAdoptionInput,
  BeliefCandidateInput,
  BeliefComparison,
  BeliefEvidenceAppendInput,
  ActiveLearningTarget,
  CompanyLearning,
  Experiment,
  ExperimentActionInput,
  ExperimentProposalInput,
  LearningEvidencePackage,
  LearningPatch,
  LearningPatchActionInput,
  LearningPatchProposalInput,
  LearningPatchTargetType,
} from "@/company-learning"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const CompanyQuery = z.object({ company_id: z.string().trim().min(1) })

export const CompanyLearningRoutes = lazy(() =>
  new Hono()
    .get(
      "/beliefs",
      describeRoute({
        summary: "List evidence-bearing Company Beliefs",
        operationId: "companyLearning.beliefs",
        responses: { 200: { description: "Beliefs", content: { "application/json": { schema: resolver(z.array(Belief)) } } } },
      }),
      validator("query", CompanyQuery),
      async (c) => jsonRequest("CompanyLearningRoutes.beliefs", c, function* () {
        return yield* (yield* CompanyLearning.Service).listBeliefs(c.req.valid("query").company_id)
      }),
    )
    .post(
      "/beliefs/compare",
      describeRoute({
        summary: "Compare same-source Interpretations without an automatic verdict",
        operationId: "companyLearning.compareInterpretations",
        responses: { 200: { description: "Comparison", content: { "application/json": { schema: resolver(BeliefComparison) } } } },
      }),
      validator("json", z.object({
        source_id: z.string().trim().min(1),
        interpretation_ids: z.array(z.string().trim().min(1)).min(2).max(100),
      }).strict()),
      async (c) => jsonRequest("CompanyLearningRoutes.compareInterpretations", c, function* () {
        return yield* (yield* CompanyLearning.Service).compareInterpretations(
          c.req.valid("json").source_id,
          c.req.valid("json").interpretation_ids,
        )
      }),
    )
    .post(
      "/beliefs",
      describeRoute({
        summary: "Create a proposal-only Candidate Belief",
        operationId: "companyLearning.createCandidate",
        responses: { 200: { description: "Candidate Belief", content: { "application/json": { schema: resolver(Belief) } } } },
      }),
      validator("json", BeliefCandidateInput),
      async (c) => jsonRequest("CompanyLearningRoutes.createCandidate", c, function* () {
        return yield* (yield* CompanyLearning.Service).createCandidate(c.req.valid("json"))
      }),
    )
    .post(
      "/beliefs/:beliefID/evidence",
      describeRoute({
        summary: "Append supporting or counter evidence to a Belief",
        operationId: "companyLearning.appendBeliefEvidence",
        responses: { 200: { description: "Belief", content: { "application/json": { schema: resolver(Belief) } } } },
      }),
      validator("param", z.object({ beliefID: z.string().trim().min(1) })),
      validator("json", BeliefEvidenceAppendInput),
      async (c) => jsonRequest("CompanyLearningRoutes.appendBeliefEvidence", c, function* () {
        return yield* (yield* CompanyLearning.Service).appendEvidence(
          c.req.valid("param").beliefID,
          c.req.valid("json"),
        )
      }),
    )
    .post(
      "/beliefs/:beliefID/adopt",
      describeRoute({
        summary: "Adopt a Belief through an accepted Board decision",
        operationId: "companyLearning.adoptBelief",
        responses: { 200: { description: "Adopted Belief", content: { "application/json": { schema: resolver(Belief) } } } },
      }),
      validator("param", z.object({ beliefID: z.string().trim().min(1) })),
      validator("json", BeliefAdoptionInput),
      async (c) => jsonRequest("CompanyLearningRoutes.adoptBelief", c, function* () {
        return yield* (yield* CompanyLearning.Service).adoptBelief(
          c.req.valid("param").beliefID,
          c.req.valid("json"),
        )
      }),
    )
    .get(
      "/experiments",
      describeRoute({
        summary: "List governed Belief Experiments",
        operationId: "companyLearning.experiments",
        responses: { 200: { description: "Experiments", content: { "application/json": { schema: resolver(z.array(Experiment)) } } } },
      }),
      validator("query", CompanyQuery),
      async (c) => jsonRequest("CompanyLearningRoutes.experiments", c, function* () {
        return yield* (yield* CompanyLearning.Service).listExperiments(c.req.valid("query").company_id)
      }),
    )
    .post(
      "/experiments",
      describeRoute({
        summary: "Propose an Experiment through DecisionIntent and Governance",
        operationId: "companyLearning.proposeExperiment",
        responses: { 200: { description: "Experiment", content: { "application/json": { schema: resolver(Experiment) } } } },
      }),
      validator("json", ExperimentProposalInput),
      async (c) => jsonRequest("CompanyLearningRoutes.proposeExperiment", c, function* () {
        return yield* (yield* CompanyLearning.Service).proposeExperiment(c.req.valid("json"))
      }),
    )
    .post(
      "/experiments/:experimentID/actions",
      describeRoute({
        summary: "Advance an Experiment without treating completion as success",
        operationId: "companyLearning.actOnExperiment",
        responses: { 200: { description: "Experiment", content: { "application/json": { schema: resolver(Experiment) } } } },
      }),
      validator("param", z.object({ experimentID: z.string().trim().min(1) })),
      validator("json", ExperimentActionInput),
      async (c) => jsonRequest("CompanyLearningRoutes.actOnExperiment", c, function* () {
        return yield* (yield* CompanyLearning.Service).actOnExperiment(
          c.req.valid("param").experimentID,
          c.req.valid("json"),
        )
      }),
    )
    .get(
      "/patches",
      describeRoute({
        summary: "List Learning Patches with Benchmark and Canary facts",
        operationId: "companyLearning.patches",
        responses: { 200: { description: "Learning Patches", content: { "application/json": { schema: resolver(z.array(LearningPatch)) } } } },
      }),
      validator("query", CompanyQuery),
      async (c) => jsonRequest("CompanyLearningRoutes.patches", c, function* () {
        return yield* (yield* CompanyLearning.Service).listPatches(c.req.valid("query").company_id)
      }),
    )
    .post(
      "/patches",
      describeRoute({
        summary: "Create a proposal-only Learning Patch",
        operationId: "companyLearning.proposePatch",
        responses: { 200: { description: "Learning Patch", content: { "application/json": { schema: resolver(LearningPatch) } } } },
      }),
      validator("json", LearningPatchProposalInput),
      async (c) => jsonRequest("CompanyLearningRoutes.proposePatch", c, function* () {
        return yield* (yield* CompanyLearning.Service).proposePatch(c.req.valid("json"))
      }),
    )
    .post(
      "/patches/:patchID/actions",
      describeRoute({
        summary: "Apply the target permission, Benchmark, Canary, activation, or rollback gate",
        operationId: "companyLearning.actOnPatch",
        responses: { 200: { description: "Learning Patch", content: { "application/json": { schema: resolver(LearningPatch) } } } },
      }),
      validator("param", z.object({ patchID: z.string().trim().min(1) })),
      validator("json", LearningPatchActionInput),
      async (c) => jsonRequest("CompanyLearningRoutes.actOnPatch", c, function* () {
        return yield* (yield* CompanyLearning.Service).actOnPatch(
          c.req.valid("param").patchID,
          c.req.valid("json"),
        )
      }),
    )
    .get(
      "/evidence-package",
      describeRoute({
        summary: "Generate a fail-closed real-chain learning evidence package",
        operationId: "companyLearning.evidencePackage",
        responses: { 200: { description: "Evidence package", content: { "application/json": { schema: resolver(LearningEvidencePackage) } } } },
      }),
      validator("query", CompanyQuery),
      async (c) => jsonRequest("CompanyLearningRoutes.evidencePackage", c, function* () {
        return yield* (yield* CompanyLearning.Service).evidencePackage(c.req.valid("query").company_id)
      }),
    )
    .get(
      "/targets/:targetType/:targetID",
      describeRoute({
        summary: "Resolve the active versioned Learning Patch target",
        operationId: "companyLearning.resolveTarget",
        responses: { 200: { description: "Active target", content: { "application/json": { schema: resolver(ActiveLearningTarget.optional()) } } } },
      }),
      validator("param", z.object({
        targetType: LearningPatchTargetType,
        targetID: z.string().trim().min(1),
      })),
      validator("query", CompanyQuery),
      async (c) => jsonRequest("CompanyLearningRoutes.resolveTarget", c, function* () {
        return yield* (yield* CompanyLearning.Service).resolveTarget(
          c.req.valid("query").company_id,
          c.req.valid("param").targetType,
          c.req.valid("param").targetID,
        )
      }),
    ),
)
