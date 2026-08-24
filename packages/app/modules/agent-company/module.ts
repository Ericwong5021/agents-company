import {
  addComponent,
  addImports,
  addServerHandler,
  createResolver,
  defineNuxtModule,
  extendPages,
} from "@nuxt/kit"

export type AgentCompanyModuleOptions = {
  enabled: boolean
}

export default defineNuxtModule<AgentCompanyModuleOptions>({
  meta: {
    name: "@agents-company/webui",
    configKey: "agentCompany",
  },
  defaults: {
    enabled: true,
  },
  setup(options, nuxt) {
    if (!options.enabled) return

    const resolver = createResolver(import.meta.url)

    nuxt.options.css.push(resolver.resolve("./runtime/app/assets/boardroom-tokens.css"))
    nuxt.options.css.push(resolver.resolve("./runtime/app/assets/boardroom-motion.css"))
    nuxt.options.css.push(resolver.resolve("./runtime/app/assets/company-extension.css"))
    addComponent({
      name: "AppButton",
      filePath: resolver.resolve("./runtime/app/components/ui/AppButton.vue"),
    })
    addComponent({
      name: "AppAvatar",
      filePath: resolver.resolve("./runtime/app/components/ui/AppAvatar.vue"),
    })
    addComponent({
      name: "AppTooltip",
      filePath: resolver.resolve("./runtime/app/components/ui/AppTooltip.vue"),
    })
    addComponent({
      name: "AppPopover",
      filePath: resolver.resolve("./runtime/app/components/ui/AppPopover.vue"),
    })
    addComponent({
      name: "AppDialog",
      filePath: resolver.resolve("./runtime/app/components/ui/AppDialog.vue"),
    })
    addComponent({
      name: "AppScrollArea",
      filePath: resolver.resolve("./runtime/app/components/ui/AppScrollArea.vue"),
    })
    addComponent({
      name: "AppResizablePane",
      filePath: resolver.resolve("./runtime/app/components/ui/AppResizablePane.vue"),
    })
    addComponent({
      name: "AppTitlebar",
      filePath: resolver.resolve("./runtime/app/components/shell/AppTitlebar.vue"),
    })
    addComponent({
      name: "AppRail",
      filePath: resolver.resolve("./runtime/app/components/shell/AppRail.vue"),
    })
    addComponent({
      name: "ContextSidebar",
      filePath: resolver.resolve("./runtime/app/components/shell/ContextSidebar.vue"),
    })
    addComponent({
      name: "WorkspaceStage",
      filePath: resolver.resolve("./runtime/app/components/shell/WorkspaceStage.vue"),
    })
    addComponent({
      name: "ContextPane",
      filePath: resolver.resolve("./runtime/app/components/shell/ContextPane.vue"),
    })
    addComponent({
      name: "ModuleWorkspace",
      filePath: resolver.resolve("./runtime/app/components/shell/ModuleWorkspace.vue"),
    })
    addComponent({
      name: "CompanyConnectionState",
      filePath: resolver.resolve("./runtime/app/components/CompanyConnectionState.vue"),
    })
    addComponent({
      name: "GoalBriefCard",
      filePath: resolver.resolve("./runtime/app/components/GoalBriefCard.vue"),
    })
    addComponent({
      name: "OnboardingChoice",
      filePath: resolver.resolve("./runtime/app/components/OnboardingChoice.vue"),
    })
    addComponent({
      name: "DemoWorkspace",
      filePath: resolver.resolve("./runtime/app/components/DemoWorkspace.vue"),
    })
    addImports({
      name: "useCompanySnapshot",
      from: resolver.resolve("./runtime/app/composables/useCompanySnapshot"),
    })
    addImports({
      name: "useProductTelemetry",
      from: resolver.resolve("./runtime/app/composables/useProductTelemetry"),
    })
    addServerHandler({
      route: "/api/agent-company/snapshot",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/snapshot.get"),
    })
    addServerHandler({
      route: "/api/agent-company/archived-work",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/archived-work.get"),
    })
    addServerHandler({
      route: "/api/agent-company/board",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/board.get"),
    })
    addServerHandler({
      route: "/api/agent-company/board",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/board.post"),
    })
    addServerHandler({
      route: "/api/agent-company/board/decide",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/board-decide.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-board",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/founder-board.get"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-board/intervene",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-board-intervene.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-board/converge",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-board-converge.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-shadow/run",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-shadow-run.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-shadow/compare",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-shadow-compare.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-advisor-readiness",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/founder-advisor-readiness.get"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-advisor-readiness",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-advisor-readiness.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-control-center",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/founder-control-center.get"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-modes",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/founder-modes.get"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-modes",
      method: "put",
      handler: resolver.resolve("./runtime/server/api/founder-modes.put"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/founder-studio.get"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio/assets/:assetID/versions",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio-revise.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio/cases",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio-case.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio/calibrations",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio-calibration.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio/calibration-responses",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio-calibration-response.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio/snapshots",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio-compile.post"),
    })
    addServerHandler({
      route: "/api/agent-company/founder-studio/snapshot-selection",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/founder-studio-select.post"),
    })
    addServerHandler({
      route: "/api/agent-company/decision-center",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/decision-center.get"),
    })
    addServerHandler({
      route: "/api/agent-company/decision-center-action",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/decision-center-action.post"),
    })
    addServerHandler({
      route: "/api/agent-company/decision-center-gate",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/decision-center-gate.post"),
    })
    addServerHandler({
      route: "/api/agent-company/decision-center-correction",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/decision-center-correction.post"),
    })
    addServerHandler({
      route: "/api/agent-company/decision-center-yellow-rollback",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/decision-center-yellow-rollback.post"),
    })
    addServerHandler({
      route: "/api/agent-company/messages",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/message.post"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/messages",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/project-messages.get"),
    })
    addServerHandler({
      route: "/api/agent-company/events",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/events.get"),
    })
    addServerHandler({
      route: "/api/agent-company/product-telemetry",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/product-telemetry.post"),
    })
    addServerHandler({
      route: "/api/agent-company/provider",
      method: "put",
      handler: resolver.resolve("./runtime/server/api/provider.put"),
    })
    addServerHandler({
      route: "/api/agent-company/provider/models",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/provider-models.post"),
    })
    addServerHandler({
      route: "/api/agent-company/approval-policy",
      method: "put",
      handler: resolver.resolve("./runtime/server/api/approval-policy.put"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/project.get"),
    })
    addServerHandler({
      route: "/api/agent-company/agents/:agentID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/agent.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/goal-brief",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/goal-brief.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/experience/:projection",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/experience.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/experience/receipts/:receiptID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/receipt.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/seed-grow",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/seed-grow.get"),
    })
    addServerHandler({
      route: "/api/agent-company/experience/organization",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/organization-list.get"),
    })
    addServerHandler({
      route: "/api/agent-company/goal-brief/generate",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/goal-brief-generate.post"),
    })
    addServerHandler({
      route: "/api/agent-company/goal-brief/request",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/goal-brief-request.get"),
    })
    addServerHandler({
      route: "/api/agent-company/goal-brief/:briefID/versions",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/goal-brief-append.post"),
    })
    addServerHandler({
      route: "/api/agent-company/goal-brief/:briefID/start",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/goal-brief-start.post"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/artifacts/:artifactID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/artifact.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/retry",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/project-retry.post"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/actions",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/project-action.post"),
    })
    addServerHandler({
      route: "/api/agent-company/commons",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/commons.get"),
    })
    addServerHandler({
      route: "/api/agent-company/commons",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/commons.post"),
    })
    addServerHandler({
      route: "/api/agent-company/commons/search",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/commons-search.get"),
    })
    addServerHandler({
      route: "/api/agent-company/commons/:sourceID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/commons-source.get"),
    })
    addServerHandler({
      route: "/api/agent-company/commons/:sourceID/retry",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/commons-retry.post"),
    })
    addServerHandler({
      route: "/api/agent-company/reading",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/reading.get"),
    })
    addServerHandler({
      route: "/api/agent-company/reading/schedule",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/reading-schedule.post"),
    })
    addServerHandler({
      route: "/api/agent-company/reading/profiles/:agentID",
      method: "put",
      handler: resolver.resolve("./runtime/server/api/reading-profile.put"),
    })
    addServerHandler({
      route: "/api/agent-company/reading/:assignmentID/stop",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/reading-stop.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/learning.get"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/beliefs",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-beliefs.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/beliefs/compare",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-beliefs-compare.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/beliefs/:beliefID/evidence",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-belief-evidence.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/beliefs/:beliefID/adopt",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-belief-adopt.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/experiments",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-experiments.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/experiments/:experimentID/actions",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-experiment-action.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/patches",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-patches.post"),
    })
    addServerHandler({
      route: "/api/agent-company/learning/patches/:patchID/actions",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/learning-patch-action.post"),
    })

    extendPages((pages) => {
      pages.push(
        {
          name: "agent-company-settings",
          path: "/settings",
          file: resolver.resolve("./runtime/app/pages/settings/company.vue"),
        },
        {
          name: "agent-company-welcome",
          path: "/welcome",
          file: resolver.resolve("./runtime/app/pages/welcome/company.vue"),
        },
      )
    })
  },
})
