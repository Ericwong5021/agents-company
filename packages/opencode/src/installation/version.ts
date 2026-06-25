declare global {
  const AGENTCOMPANY_VERSION: string
  const AGENTCOMPANY_CHANNEL: string
}

export const InstallationVersion = typeof AGENTCOMPANY_VERSION === "string" ? AGENTCOMPANY_VERSION : "local"
export const InstallationChannel = typeof AGENTCOMPANY_CHANNEL === "string" ? AGENTCOMPANY_CHANNEL : "local"
export const InstallationLocal = InstallationChannel === "local"
