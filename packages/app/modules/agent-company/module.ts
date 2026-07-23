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
          name: "agent-company-settings",
          path: "/settings/company",
          file: resolver.resolve("./runtime/app/pages/settings/company.vue"),
        },
      )
    })
  },
})
