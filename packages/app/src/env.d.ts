interface ImportMetaEnv {
  readonly VITE_AGENTCOMPANY_SERVER_HOST: string
  readonly VITE_AGENTCOMPANY_SERVER_PORT: string
  readonly VITE_AGENTCOMPANY_CHANNEL?: "dev" | "beta" | "prod"
  readonly VITE_AGENTCOMPANY_COMPANY_FIXTURE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

export declare module "solid-js" {
  namespace JSX {
    interface Directives {
      sortable: true
    }
  }
}
