import type { CompanyWorkspaceSnapshot } from "./company-model"
import { createFixtureCompanyWorkspaceDataSource } from "./company-fixture"

export type CompanyWorkspaceDataSource = {
  getSnapshot(): CompanyWorkspaceSnapshot
  subscribe(listener: (snapshot: CompanyWorkspaceSnapshot) => void): () => void
  sendMessage?(input: { channelID: string; body: string }): Promise<void>
  approveDelivery?(input: { deliveryID: string }): Promise<void>
}

export const createDisconnectedCompanyWorkspaceDataSource = (): CompanyWorkspaceDataSource => {
  const snapshot: CompanyWorkspaceSnapshot = {
    status: "disconnected",
    company: { name: "Agent Company", versionLabel: "本地运行数据未连接" },
    title: "尚未连接公司运行数据",
    description: "连接本地 Control Plane 后，这里会显示真实频道、Thread、代理状态与交付证据。",
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
  }
}

export function createCompanyWorkspaceDataSource(): CompanyWorkspaceDataSource {
  if (import.meta.env.DEV) return createFixtureCompanyWorkspaceDataSource()
  return createDisconnectedCompanyWorkspaceDataSource()
}
