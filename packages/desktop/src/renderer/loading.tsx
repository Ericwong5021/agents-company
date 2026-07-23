const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("Agent Company loading root was not found")

root.innerHTML = `
  <main style="min-height:100dvh;display:grid;place-items:center;color:#e9e9ec;background:#171719;font-family:ui-sans-serif,system-ui,sans-serif">
    <p aria-live="polite">Starting Agent Company…</p>
  </main>
`

void window.api.awaitInitialization(() => {
  const status = root.querySelector("p")
  if (status) status.textContent = "Ready"
})
