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

    nuxt.options.css.push(resolver.resolve("./runtime/app/assets/company-extension.css"))
    addComponent({
      name: "CompanyModuleNav",
      filePath: resolver.resolve("./runtime/app/components/CompanyModuleNav.vue"),
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
    addServerHandler({
      route: "/api/agent-company/snapshot",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/snapshot.get"),
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
      route: "/api/agent-company/projects/:projectID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/project.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/goal-brief",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/goal-brief.get"),
    })
    addServerHandler({
      route: "/api/agent-company/goal-brief/generate",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/goal-brief-generate.post"),
    })
    addServerHandler({
      route: "/api/agent-company/goal-brief/:briefID/versions",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/goal-brief-append.post"),
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
