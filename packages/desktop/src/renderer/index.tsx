import { createSignal, Show } from "solid-js"
import { render } from "solid-js/web"
import type { LauncherState } from "../main/company-home"

const root = document.getElementById("root")
if (!(root instanceof HTMLElement)) throw new Error("Agent Company renderer root was not found")
const mount = root

function dataDirectory(path: string) {
  return `${path}${path.includes("\\") ? "\\" : "/"}data`
}

function CompanyHomePreflight(props: { state: Extract<LauncherState, { state: "needs_company_home" }> }) {
  const [pending, setPending] = createSignal(false)
  const [error, setError] = createSignal<string>()

  const select = async () => {
    setPending(true)
    setError()
    try {
      const companyHome = await window.api.selectCompanyHome()
      if (companyHome) window.api.relaunch()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Agent Company could not write to that folder.")
    } finally {
      setPending(false)
    }
  }

  return (
    <main
      style={{
        "min-height": "100dvh",
        display: "grid",
        "place-items": "center",
        padding: "24px",
        color: "#e9e9ec",
        background: "#171719",
        "font-family": "ui-sans-serif, system-ui, sans-serif",
      }}
    >
      <section style={{ width: "min(100%, 560px)", padding: "32px", border: "1px solid #39393d", "border-radius": "14px" }}>
        <p style={{ margin: "0 0 12px", color: "#91a7ff", "font-size": "13px", "font-weight": 700 }}>AGENT COMPANY</p>
        <h1 style={{ margin: "0", "font-size": "28px" }}>Choose a Company home</h1>
        <p style={{ color: "#b8b8c0", "line-height": 1.6 }}>
          Agent Company keeps its local control-plane data in one folder that you own.
        </p>
        <div style={{ padding: "16px", color: "#d7d7df", background: "#222225", "border-radius": "9px", "word-break": "break-all" }}>
          <div>{props.state.suggested_path}</div>
          <div style={{ margin: "8px 0 0", color: "#92929d", "font-size": "13px" }}>{dataDirectory(props.state.suggested_path)}</div>
        </div>
        <Show when={error()}>{(message) => <p style={{ color: "#ff9a9a" }}>{message()}</p>}</Show>
        <button
          type="button"
          disabled={pending()}
          onClick={() => void select()}
          style={{
            margin: "24px 0 0",
            padding: "10px 16px",
            border: 0,
            "border-radius": "8px",
            color: "#fff",
            background: pending() ? "#555566" : "#5865f2",
            cursor: pending() ? "wait" : "pointer",
          }}
        >
          {pending() ? "Checking folder…" : "Choose folder"}
        </button>
      </section>
    </main>
  )
}

async function start() {
  const state = await window.api.getLauncherState()
  if (state.state === "needs_company_home") {
    render(() => <CompanyHomePreflight state={state} />, mount)
    return
  }

  const { mountApp } = await import("./app-shell")
  mountApp(mount)
}

void start()
