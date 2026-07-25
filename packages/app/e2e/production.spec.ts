import { expect, test, type APIRequestContext } from "@playwright/test"

const controlPlaneURL = "http://127.0.0.1:3311"

async function setControlPlaneMode(request: APIRequestContext, mode: string) {
  const response = await request.put(`${controlPlaneURL}/__test/mode`, {
    data: { mode, reset: true },
  })
  expect(response.ok()).toBe(true)
}

test("production preview never enables fixture fallback through query parameters", async ({ page, request }) => {
  await setControlPlaneMode(request, "health-500")
  await page.goto("/login")
  await page.waitForURL(url => url.pathname === "/inbox")
  const response = await page.context().request.get("/api/agent-company/snapshot?fixture=1&demo=1")
  expect(response.ok()).toBe(true)
  const snapshot = await response.json()
  expect(snapshot.connection).toBe("disconnected")
  expect(snapshot.agents).toEqual([])
  expect(snapshot.work).toEqual([])
  expect(snapshot.messages).toEqual([])
})
