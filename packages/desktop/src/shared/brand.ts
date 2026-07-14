export const PRODUCT_BRAND = {
  names: { dev: "Agent Company Dev", beta: "Agent Company Beta", prod: "Agent Company" },
  app_ids: {
    dev: "ai.agentcompany.desktop.dev",
    beta: "ai.agentcompany.desktop.beta",
    prod: "ai.agentcompany.desktop",
  },
  settings_store: "agent-company.settings",
  deep_link_protocol: "agentcompany",
  renderer_scheme: "ac",
} as const

export const COMPANY_HOME_KEY = "companyHome"
