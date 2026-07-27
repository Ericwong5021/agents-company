const element = document.getElementById("root")
if (!(element instanceof HTMLElement)) throw new Error("Agent Company renderer root was not found")
const root = element

function showCompanyHomePicker(path: string) {
  root.innerHTML = `
    <main style="min-height:100dvh;display:grid;place-items:center;padding:24px;color:#e9e9ec;background:#171719;font-family:ui-sans-serif,system-ui,sans-serif">
      <section style="width:min(100%,560px);padding:32px;border:1px solid #39393d;border-radius:14px">
        <p style="margin:0 0 12px;color:#91a7ff;font-size:13px;font-weight:700">AGENT COMPANY</p>
        <h1 style="margin:0;font-size:28px">Choose a Company home</h1>
        <p style="color:#b8b8c0;line-height:1.6">Agent Company keeps its local Control Plane data in one folder that you own.</p>
        <p style="padding:16px;color:#d7d7df;background:#222225;border-radius:9px;word-break:break-all">${path}</p>
        <button type="button" style="padding:10px 16px;border:0;border-radius:8px;color:#fff;background:#5865f2;cursor:pointer">Choose folder</button>
      </section>
    </main>
  `
  root.querySelector("button")?.addEventListener("click", async () => {
    const companyHome = await window.api.selectCompanyHome()
    if (companyHome) window.api.relaunch()
  })
}

const state = await window.api.getLauncherState()
if (state.state === "needs_company_home") {
  showCompanyHomePicker(state.suggested_path)
} else {
  await window.api.awaitInitialization(() => undefined)
  window.location.replace(`${import.meta.env.VITE_AGENTCOMPANY_WEB_URL || "http://127.0.0.1:3210"}/company`)
}
