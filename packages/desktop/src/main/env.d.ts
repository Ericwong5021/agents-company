interface ImportMetaEnv {
  readonly AGENTCOMPANY_CHANNEL: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
declare module "virtual:opencode-server" {
  type BasicCredentials = { username: string; password: string }

  export namespace Server {
    export type Listener = {
      credentials?: BasicCredentials
      stop: (close?: boolean) => Promise<void>
    }
    export function listen(input: {
      port: number
      hostname: string
      auth?: BasicCredentials
      cors?: string[]
    }): Promise<Listener>
  }
  export namespace Log {
    export function init(input: { print: boolean; level?: "DEBUG" | "INFO" | "WARN" | "ERROR" }): Promise<void>
  }
}
