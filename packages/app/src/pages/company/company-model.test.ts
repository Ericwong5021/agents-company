import { describe, expect, test } from "bun:test"
import { companyAgents, companyChannels, deliveryEvidence, threadEvents } from "./company-model"

describe("company workspace view model", () => {
  test("keeps the pre-public project as a high-signal channel", () => {
    const project = companyChannels.find((channel) => channel.id === "pre-public-webui")

    expect(project).toMatchObject({
      section: "项目",
      name: "Pre-Public WebUI",
      preview: "准备合并到 main",
    })
  })

  test("only references known agents from direct channels and thread events", () => {
    const referenced = [
      ...companyChannels.flatMap((channel) => (channel.agent ? [channel.agent] : [])),
      ...threadEvents.map((event) => event.agent),
    ]

    expect(referenced.every((agent) => agent in companyAgents)).toBe(true)
  })

  test("ships complete delivery evidence for the approval surface", () => {
    expect(deliveryEvidence.map((item) => item.label)).toEqual(["功能验收", "兼容性检查", "可访问性", "性能基准"])
  })
})
