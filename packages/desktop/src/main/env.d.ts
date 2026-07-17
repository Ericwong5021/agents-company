interface ImportMetaEnv {
  readonly AGENTCOMPANY_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
declare module "virtual:control-plane-server" {
  export namespace Server {
    export type Listener = {
      stop: (close?: boolean) => Promise<void>
    }
    export function listen(input: {
      port: number
      hostname: string
      noAuth?: boolean
      cors?: string[]
    }): Promise<Listener>
  }
  export namespace Log {
    export function init(input: { print: boolean; level?: "DEBUG" | "INFO" | "WARN" | "ERROR" }): Promise<void>
  }
}
