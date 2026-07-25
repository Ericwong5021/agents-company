import { describe, expect, test } from "bun:test"
import path from "node:path"
import z from "zod"
import {
  AttentionItem,
  DeliverySummary,
  ExperienceActionDescriptor,
  ExperienceActionType,
  ExperienceActionMutatesBusinessState,
  ExperienceAllowedActionTypes,
  ExperienceIntent,
  ExperienceIntentClassificationInput,
  ExperienceIntentClassificationResult,
  ExperienceIntentCorrectionResult,
  ExperienceNeedsUserAction,
  ExperienceUserStatus,
  ProgressProjection,
  WorkProjection,
  WorkSummary,
} from "@agents-company/shared/experience"

const LanguageContract = z
  .object({
    intentContract: z.array(
      z
        .object({
          id: z.string(),
          defaultRoute: z.string(),
          mayCreateWork: z.boolean(),
        })
        .passthrough(),
    ),
    intentRoutingContract: z
      .object({
        classificationInput: z
          .object({
            requiredFields: z.array(z.string()),
            contextOptionalFields: z.array(z.string()),
            additionalFields: z.boolean(),
            contextAdditionalFields: z.boolean(),
          })
          .passthrough(),
        classificationResult: z
          .object({
            decisionVariants: z.array(z.string()),
            goalModes: z.array(z.string()),
            workCreationPolicies: z.array(z.string()),
            lowConfidenceDecision: z.string(),
            lowConfidenceWorkCreationPolicy: z.string(),
          })
          .passthrough(),
        correctionResult: z
          .object({
            requiredFields: z.array(z.string()),
            sameIntentCorrectionAllowed: z.boolean(),
            targetCorrectionAllowed: z.boolean(),
            previousResultReferenceRequired: z.boolean(),
          })
          .passthrough(),
      })
      .passthrough(),
    projectionContract: z
      .object({
        availabilityDiscriminator: z.string(),
        availabilityVariants: z.array(z.string()),
        unavailableIsUserStatus: z.boolean(),
        userStatusValue: z.string(),
        reason: z
          .object({
            availabilityVariants: z.array(z.string()),
            unavailableText: z.string(),
          })
          .passthrough(),
        action: z
          .object({
            idField: z.string(),
            labelOwner: z.string(),
            missingNextAction: z.null(),
            mutationWithoutValidHandler: z.string(),
          })
          .passthrough(),
      })
      .passthrough(),
    actions: z.array(z.object({ id: z.string(), mutatesBusinessState: z.boolean() }).passthrough()),
    states: z.array(
      z
        .object({
          id: z.string(),
          label: z.string(),
          needsUserAction: z.boolean(),
          allowedActions: z.array(z.string()),
          eventMappings: z.array(
            z
              .object({
                source: z.string(),
                events: z.array(z.string()).optional(),
                values: z.array(z.string()).optional(),
                predicate: z.string().optional(),
                availability: z.string(),
              })
              .strict(),
          ),
        })
        .passthrough(),
    ),
    fallbackRule: z
      .object({
        unknownInternalState: z.string(),
        missingReason: z.string(),
        missingNextAction: z.string(),
      })
      .strict(),
  })
  .passthrough()

function result(intent: "message" | "question" | "goal") {
  const common = {
    schemaVersion: 1,
    requestId: "request-1",
    decision: "routed" as const,
    confidence: 0.95,
    decisionReason: "用户明确要求形成可交付结果",
    source: "model" as const,
    classifiedAt: new Date(0).toISOString(),
  }
  if (intent === "goal")
    return {
      ...common,
      intent,
      route: "goal_brief" as const,
      goalMode: "briefed" as const,
      workCreationPolicy: "requires_explicit_start" as const,
    }
  return {
    ...common,
    intent,
    route: "conversation" as const,
    workCreationPolicy: "forbidden" as const,
  }
}

const projectionTimestamp = new Date(0).toISOString()
const projectionSourceRefs = [{ kind: "project" as const, id: "project-1" }]
const projectionReason = {
  availability: "known" as const,
  text: "Persisted project fact",
  sourceRefs: projectionSourceRefs,
}
const viewProgress = { id: "view_progress" as const, enabled: true as const }
const viewEvidence = { id: "view_evidence" as const, enabled: true as const }
const openDelivery = { id: "open_delivery" as const, enabled: true as const }

function projectionPair(
  userStatus: "running" | "reviewing" | "delivered",
  phase: string,
  needsUserAction: boolean,
  action: typeof viewProgress | typeof viewEvidence | typeof openDelivery,
) {
  return {
    summary: {
      workId: "project-1",
      title: "Experience project",
      userStatus,
      phase,
      needsUserAction,
      reason: projectionReason,
      nextAction: action,
      updatedAt: projectionTimestamp,
      sourceRefs: projectionSourceRefs,
      allowedActions: [action],
    },
    progress: {
      workId: "project-1",
      userStatus,
      phase,
      completedItems: 0,
      totalItems: 0,
      reason: projectionReason,
      nextAction: action,
      updatedAt: projectionTimestamp,
      sourceRefs: projectionSourceRefs,
      allowedActions: [action],
    },
  }
}

describe("Experience language contract", () => {
  test("matches the canonical intent, action, state-action, and user-attention vocabulary", async () => {
    const contract = LanguageContract.parse(
      await Bun.file(
        path.resolve(import.meta.dir, "../../../../docs/product-design/experience-refactor/language-contract.v1.json"),
      ).json(),
    )

    expect([...ExperienceIntent.options] as string[]).toEqual(contract.intentContract.map((item) => item.id))
    expect([...ExperienceActionType.options] as string[]).toEqual(contract.actions.map((item) => item.id))
    expect(Object.fromEntries(contract.actions.map((item) => [item.id, item.mutatesBusinessState]))).toEqual(
      ExperienceActionMutatesBusinessState,
    )
    expect(
      Object.fromEntries(
        contract.states.map((state) => [
          state.id,
          {
            needsUserAction: state.needsUserAction,
            allowedActions: state.allowedActions,
          },
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        ExperienceUserStatus.options.map((state) => [
          state,
          {
            needsUserAction: ExperienceNeedsUserAction[state],
            allowedActions: [...ExperienceAllowedActionTypes[state]],
          },
        ]),
      ),
    )
  })

  test("freezes intent routing and truthful projection fallback shapes", async () => {
    const contract = LanguageContract.parse(
      await Bun.file(
        path.resolve(import.meta.dir, "../../../../docs/product-design/experience-refactor/language-contract.v1.json"),
      ).json(),
    )

    expect(contract.intentRoutingContract.classificationInput).toMatchObject({
      requiredFields: ["schemaVersion", "requestId", "text", "context", "createdAt"],
      contextOptionalFields: ["existingWorkId", "pendingDecisionId", "replyToId"],
      additionalFields: false,
      contextAdditionalFields: false,
    })
    expect(contract.intentRoutingContract.classificationResult).toMatchObject({
      decisionVariants: ["routed", "needs_confirmation"],
      goalModes: ["direct", "briefed"],
      workCreationPolicies: ["forbidden", "requires_explicit_start"],
      lowConfidenceDecision: "needs_confirmation",
      lowConfidenceWorkCreationPolicy: "forbidden",
    })
    expect(contract.intentRoutingContract.correctionResult).toMatchObject({
      sameIntentCorrectionAllowed: true,
      targetCorrectionAllowed: true,
      previousResultReferenceRequired: true,
    })
    expect(contract.projectionContract).toMatchObject({
      availabilityDiscriminator: "availability",
      availabilityVariants: ["available", "unavailable"],
      unavailableIsUserStatus: false,
      userStatusValue: "state.id",
      reason: {
        availabilityVariants: ["known", "unavailable"],
        unavailableText: "当前原因不可用",
      },
      action: {
        idField: "id",
        labelOwner: "frontend_localization",
        missingNextAction: null,
        mutationWithoutValidHandler: "disabled",
      },
    })
    expect(contract.states.find((state) => state.id === "delivered")?.eventMappings).toEqual([
      expect.objectContaining({ events: ["delivery.ready"], availability: "r0_contract" }),
    ])
    expect(contract.states.find((state) => state.id === "cancelled")?.eventMappings).toEqual([
      expect.objectContaining({ events: ["work.cancelled"], availability: "r0_contract" }),
    ])
    expect(contract.fallbackRule).toMatchObject({
      unknownInternalState: expect.stringContaining("explicit unavailable state"),
      missingReason: expect.stringContaining("Do not fabricate a reason"),
      missingNextAction: expect.stringContaining("Disable mutation controls"),
    })
  })

  test("freezes a versioned classification input without internal runtime fields", () => {
    expect(
      ExperienceIntentClassificationInput.parse({
        schemaVersion: 1,
        requestId: "request-1",
        text: "请帮我判断是否值得进入新市场",
        context: {},
        createdAt: new Date(0).toISOString(),
      }),
    ).toMatchObject({ schemaVersion: 1, requestId: "request-1" })
    expect(
      ExperienceIntentClassificationInput.safeParse({
        schemaVersion: 1,
        requestId: "request-1",
        text: "问题",
        context: {},
        createdAt: new Date(0).toISOString(),
        biddingState: "running",
      }).success,
    ).toBe(false)
  })

  test("prevents message and question classifications from creating formal work", () => {
    expect(ExperienceIntentClassificationResult.parse(result("message")).workCreationPolicy).toBe("forbidden")
    expect(ExperienceIntentClassificationResult.parse(result("question")).workCreationPolicy).toBe("forbidden")
    expect(ExperienceIntentClassificationResult.parse(result("goal")).workCreationPolicy).toBe(
      "requires_explicit_start",
    )
    expect(
      ExperienceIntentClassificationResult.safeParse({
        ...result("message"),
        route: "goal_brief",
        workCreationPolicy: "requires_explicit_start",
      }).success,
    ).toBe(false)
    expect(
      ExperienceIntentClassificationResult.safeParse({
        ...result("question"),
        route: "goal_brief",
        workCreationPolicy: "requires_explicit_start",
      }).success,
    ).toBe(false)
    expect(
      ExperienceIntentClassificationResult.parse({
        schemaVersion: 1,
        requestId: "request-low-confidence",
        decision: "needs_confirmation",
        confidence: 0.2,
        decisionReason: "目标与普通讨论边界不明确",
        source: "model",
        classifiedAt: new Date(0).toISOString(),
        proposedIntent: "goal",
        confirmationOptions: ["execute_as_goal", "discuss_only"],
        workCreationPolicy: "forbidden",
      }),
    ).toMatchObject({ decision: "needs_confirmation", workCreationPolicy: "forbidden" })
    expect(
      ExperienceIntentClassificationResult.safeParse({
        ...result("message"),
        decisionReason: "事实".repeat(121),
      }).success,
    ).toBe(false)
    const { decisionReason: _, ...withoutDecisionReason } = result("message")
    expect(
      ExperienceIntentClassificationResult.safeParse({
        ...withoutDecisionReason,
        rationale: "模型私有推理",
      }).success,
    ).toBe(false)
  })

  test("requires existing targets for interventions and approval responses", () => {
    expect(
      ExperienceIntentClassificationResult.safeParse({
        ...result("message"),
        decision: "routed",
        intent: "intervention",
        route: "existing_work",
      }).success,
    ).toBe(false)
    expect(
      ExperienceIntentClassificationResult.safeParse({
        ...result("message"),
        decision: "routed",
        intent: "approval_response",
        route: "pending_decision",
      }).success,
    ).toBe(false)
  })

  test("records a user correction as a versioned classification result", () => {
    const corrected = {
      ...result("goal"),
      source: "user_correction" as const,
    }
    expect(
      ExperienceIntentCorrectionResult.parse({
        schemaVersion: 1,
        correctionId: "correction-1",
        requestId: "request-1",
        previousResultRef: "classification-1",
        correctedBy: "user",
        reason: "我需要正式交付，不只是回答",
        correctedAt: new Date(1).toISOString(),
        result: corrected,
      }).result.intent,
    ).toBe("goal")
    expect(
      ExperienceIntentCorrectionResult.safeParse({
        schemaVersion: 1,
        correctionId: "correction-2",
        requestId: "another-request",
        previousResultRef: "classification-1",
        correctedBy: "user",
        correctedAt: new Date(1).toISOString(),
        result: corrected,
      }).success,
    ).toBe(false)
    expect(
      ExperienceIntentCorrectionResult.parse({
        schemaVersion: 1,
        correctionId: "correction-3",
        requestId: "request-1",
        previousResultRef: "classification-2",
        correctedBy: "user",
        correctedAt: new Date(1).toISOString(),
        result: corrected,
      }).result.intent,
    ).toBe("goal")
    expect(
      ExperienceIntentCorrectionResult.safeParse({
        schemaVersion: 1,
        correctionId: "correction-4",
        requestId: "request-1",
        previousResultRef: "classification-3",
        correctedBy: "user",
        correctedAt: new Date(1).toISOString(),
        result: {
          schemaVersion: 1,
          requestId: "request-1",
          decision: "needs_confirmation",
          confidence: 0.2,
          decisionReason: "仍需确认",
          source: "user_correction",
          classifiedAt: new Date(1).toISOString(),
          proposedIntent: "goal",
          confirmationOptions: ["execute_as_goal"],
          workCreationPolicy: "forbidden",
        },
      }).success,
    ).toBe(false)
    expect(
      ExperienceIntentCorrectionResult.safeParse({
        schemaVersion: 1,
        correctionId: "correction-5",
        requestId: "request-1",
        previousResultRef: "classification-4",
        correctedBy: "user",
        correctedAt: new Date(1).toISOString(),
        result: {
          ...corrected,
          source: "model",
        },
      }).success,
    ).toBe(false)
  })

  test("rejects inconsistent action, progress, attention, and delivery contracts", () => {
    const running = projectionPair("running", "execution", false, viewProgress)
    const disabledPause = {
      id: "pause_work" as const,
      enabled: false as const,
      disabledReason: "No active run",
    }
    const artifact = {
      id: "artifact-1",
      projectId: "project-1",
      kind: "product",
      title: "Result",
      href: "/experience/projects/project-1/artifacts/artifact-1",
    }
    const delivery = {
      id: "delivery-1",
      workId: "project-1",
      version: 1,
      acceptanceState: "pending" as const,
      artifacts: [artifact],
      reason: projectionReason,
      nextAction: openDelivery,
      updatedAt: projectionTimestamp,
      sourceRefs: projectionSourceRefs,
      allowedActions: [openDelivery],
    }

    expect(ExperienceActionDescriptor.safeParse({ id: "start_work", enabled: true }).success).toBe(false)
    expect(
      WorkSummary.safeParse({
        ...running.summary,
        needsUserAction: true,
        nextAction: disabledPause,
        allowedActions: [viewProgress, viewProgress, openDelivery],
      }).success,
    ).toBe(false)
    expect(
      ProgressProjection.safeParse({
        ...running.progress,
        completedItems: 1,
        totalItems: 0,
        percent: 5,
      }).success,
    ).toBe(false)
    expect(
      ProgressProjection.safeParse({
        ...running.progress,
        completedItems: 1,
        totalItems: 2,
        percent: 99,
      }).success,
    ).toBe(false)
    expect(
      AttentionItem.safeParse({
        id: "attention-1",
        type: "blocked",
        workId: "project-1",
        title: "Blocked",
        reason: projectionReason,
        impact: "Delivery cannot proceed",
        recommendedAction: disabledPause,
        priority: "high",
        updatedAt: projectionTimestamp,
        sourceRefs: projectionSourceRefs,
        allowedActions: [viewProgress, viewProgress],
      }).success,
    ).toBe(false)
    expect(
      DeliverySummary.safeParse({
        ...delivery,
        artifacts: [],
        nextAction: { id: "open_delivery", enabled: false, disabledReason: "Missing Artifact" },
        allowedActions: [openDelivery, openDelivery],
      }).success,
    ).toBe(false)
    expect(
      DeliverySummary.safeParse({
        ...delivery,
        nextAction: openDelivery,
        allowedActions: [viewEvidence],
      }).success,
    ).toBe(false)
  })

  test("rejects cross-object projection contradictions with precise diagnostics", () => {
    const metadata = {
      projectorVersion: 1,
      sourceWatermark: "0".repeat(64),
    }
    const diagnostic = {
      id: "diagnostic-1",
      code: "missing_fact" as const,
      message: "Required fact is missing",
    }
    expect(
      WorkProjection.safeParse({
        availability: "unavailable",
        ...metadata,
        workId: "project-1",
        title: "Experience project",
        updatedAt: projectionTimestamp,
        reason: {
          availability: "unavailable",
          text: "当前原因不可用",
          diagnosticIds: ["diagnostic-missing"],
        },
        diagnostics: [diagnostic, diagnostic],
      }).success,
    ).toBe(false)

    const running = projectionPair("running", "execution", false, viewProgress)
    const evidenceReason = {
      availability: "known" as const,
      text: "Event fact",
      sourceRefs: [{ kind: "project_event" as const, id: "event-1" }],
    }
    const attention = {
      id: "attention-1",
      type: "blocked" as const,
      workId: "project-1",
      title: "Blocked",
      reason: evidenceReason,
      impact: "Delivery cannot proceed",
      recommendedAction: openDelivery,
      priority: "high" as const,
      updatedAt: projectionTimestamp,
      sourceRefs: projectionSourceRefs,
      allowedActions: [openDelivery],
    }
    expect(
      WorkProjection.safeParse({
        availability: "available",
        ...metadata,
        summary: { ...running.summary, reason: evidenceReason },
        progress: { ...running.progress, phase: "different", reason: evidenceReason },
        attentionItems: [attention, attention],
        diagnostics: [],
      }).success,
    ).toBe(false)

    const reviewing = projectionPair("reviewing", "verification", false, viewEvidence)
    expect(
      WorkProjection.safeParse({
        availability: "available",
        ...metadata,
        ...reviewing,
        attentionItems: [],
        delivery: {
          id: "delivery-1",
          workId: "another-project",
          version: 1,
          acceptanceState: "pending",
          artifacts: [
            {
              id: "artifact-1",
              projectId: "project-1",
              kind: "product",
              title: "Result",
              href: "/experience/projects/project-1/artifacts/artifact-1",
            },
          ],
          reason: evidenceReason,
          nextAction: openDelivery,
          updatedAt: projectionTimestamp,
          sourceRefs: projectionSourceRefs,
          allowedActions: [openDelivery],
        },
        diagnostics: [],
      }).success,
    ).toBe(false)

    const delivered = projectionPair("delivered", "delivery", true, openDelivery)
    expect(
      WorkProjection.safeParse({
        availability: "available",
        ...metadata,
        ...delivered,
        attentionItems: [],
        diagnostics: [],
      }).success,
    ).toBe(false)
  })
})
