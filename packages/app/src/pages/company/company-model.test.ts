import { describe, expect, test } from "bun:test"
import { createDisconnectedCompanyWorkspaceDataSource } from "./company-data-source"
import { createFixtureCompanyWorkspaceDataSource } from "./company-fixture"

describe("company workspace data source", () => {
  test("keeps production honest when runtime data is not connected", () => {
    const source = createDisconnectedCompanyWorkspaceDataSource()
    const snapshot = source.getSnapshot()

    expect(snapshot.status).toBe("disconnected")
    expect(JSON.stringify(snapshot)).not.toMatch(/142\/142|评审通过|后端接口、权限与审计日志已实现|已通过/)
    expect(source.approveDelivery === undefined).toBe(true)
    expect(source.sendMessage === undefined).toBe(true)
  })

  test("exposes the visual fixture only through the development adapter", () => {
    const source = createFixtureCompanyWorkspaceDataSource()
    const snapshot = source.getSnapshot()

    expect(snapshot.status).toBe("ready")
    if (snapshot.status !== "ready") return
    expect(snapshot.channels.find((channel) => channel.id === "pre-public-webui")).toMatchObject({
      section: "项目",
      name: "Pre-Public WebUI",
    })
  })

  test("publishes fixture action results through the same subscription boundary", async () => {
    const source = createFixtureCompanyWorkspaceDataSource()
    const updates: string[] = []
    const unsubscribe = source.subscribe((snapshot) => {
      if (snapshot.status !== "ready") return
      updates.push(`${snapshot.delivery.status}:${snapshot.userMessages.length}`)
    })

    await source.sendMessage?.({ channelID: "pre-public-webui", body: "继续推进 M0" })
    await source.approveDelivery?.({ deliveryID: "pre-public-webui-delivery" })
    unsubscribe()

    expect(updates).toEqual(["pending:1", "approved:1"])
  })
})
