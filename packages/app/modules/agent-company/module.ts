import {
  addComponent,
  addImports,
  addPlugin,
  addServerHandler,
  createResolver,
  defineNuxtModule,
  extendPages,
} from "@nuxt/kit"

export type AgentCompanyModuleOptions = {
  enabled: boolean
  label: string
}

export default defineNuxtModule<AgentCompanyModuleOptions>({
  meta: {
    name: "@agents-company/eve-extension",
    configKey: "agentCompany",
  },
  defaults: {
    enabled: true,
    label: "Company",
  },
  setup(options, nuxt) {
    if (!options.enabled) return

    const resolver = createResolver(import.meta.url)

    nuxt.options.css.push(resolver.resolve("./runtime/app/assets/company-extension.css"))
    nuxt.options.appConfig.agentCompany = {
      label: options.label,
      navigation: [
        { label: "Overview", to: "/company" },
        { label: "Board", to: "/company/board" },
        { label: "Employees", to: "/company/employees" },
      ],
    }

    addPlugin(resolver.resolve("./runtime/app/plugins/company-extension.client"))
    addComponent({
      name: "CompanyModuleNav",
      filePath: resolver.resolve("./runtime/app/components/CompanyModuleNav.vue"),
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
      route: "/api/agent-company/projects/:projectID",
      method: "get",
      handler: resolver.resolve("./runtime/server/api/project.get"),
    })
    addServerHandler({
      route: "/api/agent-company/projects/:projectID/retry",
      method: "post",
      handler: resolver.resolve("./runtime/server/api/project-retry.post"),
    })

    extendPages((pages) => {
      const loginPage = pages.find((page) => page.path === "/login")
      if (loginPage) {
        loginPage.file = resolver.resolve("./runtime/app/pages/login.vue")
        loginPage.meta = { ...loginPage.meta, layout: false }
      }

      pages.push(
        {
          name: "agent-company-overview",
          path: "/company",
          file: resolver.resolve("./runtime/app/pages/company/index.vue"),
        },
        {
          name: "agent-company-board",
          path: "/company/board",
          file: resolver.resolve("./runtime/app/pages/company/board.vue"),
        },
        {
          name: "agent-company-employees",
          path: "/company/employees",
          file: resolver.resolve("./runtime/app/pages/company/employees.vue"),
        },
        {
          name: "agent-company-project",
          path: "/company/projects/:projectID",
          file: resolver.resolve("./runtime/app/pages/company/projects/[projectID].vue"),
        },
        {
          name: "agent-company-settings",
          path: "/settings/company",
          file: resolver.resolve("./runtime/app/pages/settings/company.vue"),
        },
      )
    })
  },
})
