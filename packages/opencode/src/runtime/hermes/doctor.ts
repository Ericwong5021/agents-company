import * as fs from "fs/promises"
import * as path from "path"
import { execSync } from "child_process"
import { FileBindingStore } from "./binding-store"
import type { HermesRuntimeConfig } from "./types"
import type { RuntimeBinding } from "../interface"

// ---------------------------------------------------------------------------
// Doctor result types
// ---------------------------------------------------------------------------

export interface DoctorCheck {
  name: string
  status: "pass" | "fail" | "warn"
  message: string
  detail?: string
}

export interface DoctorReport {
  checks: DoctorCheck[]
  passed: number
  failed: number
  warnings: number
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function checkHermesInstalled(): Promise<DoctorCheck> {
  try {
    const out = execSync("which hermes 2>/dev/null || echo not-found", {
      encoding: "utf-8",
      timeout: 5_000,
    }).trim()
    if (!out || out === "not-found" || out.includes("not found")) {
      // Try command -v as fallback
      const out2 = execSync("command -v hermes 2>/dev/null || echo not-found", {
        encoding: "utf-8",
        timeout: 5_000,
      }).trim()
      if (!out2 || out2 === "not-found" || out2.includes("not found")) {
        return {
          name: "Hermes CLI installed",
          status: "fail",
          message: "hermes binary not found in PATH",
          detail: "Install Hermes from https://github.com/hermes-agent/hermes",
        }
      }
      return { name: "Hermes CLI installed", status: "pass", message: `Found at: ${out2}` }
    }
    return { name: "Hermes CLI installed", status: "pass", message: `Found at: ${out}` }
  } catch {
    return {
      name: "Hermes CLI installed",
      status: "fail",
      message: "hermes binary not found in PATH",
      detail: "Install Hermes from https://github.com/hermes-agent/hermes",
    }
  }
}

async function checkHermesVersion(): Promise<DoctorCheck> {
  try {
    const out = execSync("hermes --version 2>&1", {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim()
    if (!out) {
      return { name: "Hermes version", status: "warn", message: "Could not determine version" }
    }
    return { name: "Hermes version", status: "pass", message: out }
  } catch {
    return { name: "Hermes version", status: "warn", message: "Could not determine version" }
  }
}

async function checkProfileDirExists(): Promise<DoctorCheck> {
  const homeDir = process.env.HOME || process.env.USERPROFILE || ""
  const profilesDir = path.join(homeDir, ".hermes", "profiles")
  try {
    await fs.access(profilesDir)
    const entries = await fs.readdir(profilesDir)
    const agentCompanyProfiles = entries.filter((e) => e.startsWith("agentcompany-"))
    const detail = `Total profiles: ${entries.length}, agentcompany-*: ${agentCompanyProfiles.length}`
    return { name: "Hermes profiles directory", status: "pass", message: detail }
  } catch {
    return {
      name: "Hermes profiles directory",
      status: "warn",
      message: "~/.hermes/profiles/ does not exist yet",
      detail: "Profiles are created automatically on first compile",
    }
  }
}

async function checkProfileCreate(): Promise<DoctorCheck> {
  const testProfileName = `agentcompany-doctor-check-${Date.now()}`
  try {
    execSync(`hermes profile create ${testProfileName}`, {
      stdio: "pipe",
      timeout: 15_000,
    })
    // Clean up.
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    const profileDir = path.join(homeDir, ".hermes", "profiles", testProfileName)
    await fs.rm(profileDir, { recursive: true, force: true })
    return { name: "Profile creation", status: "pass", message: "Can create Hermes profiles" }
  } catch (error: any) {
    const msg = error?.stdout?.toString() ?? error?.stderr?.toString() ?? error?.message ?? ""
    if (msg.includes("already exists")) {
      return { name: "Profile creation", status: "pass", message: "Profile creation works (idempotent)" }
    }
    return {
      name: "Profile creation",
      status: "fail",
      message: `Cannot create Hermes profiles: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function checkOneShotExecution(): Promise<DoctorCheck> {
  try {
    const out = execSync("hermes -p default -z 'hello' 2>&1", {
      encoding: "utf-8",
      timeout: 30_000,
    }).trim()
    return {
      name: "One-shot execution",
      status: out.includes("error") || out.includes("Error") ? "warn" : "pass",
      message: "hermes -z executes",
      detail: out.length > 120 ? out.substring(0, 120) + "..." : out,
    }
  } catch (error: any) {
    const msg = error?.stderr?.toString() ?? error?.stdout?.toString() ?? error?.message ?? ""
    if (msg.includes("profile") && (msg.includes("not found") || msg.includes("does not exist"))) {
      return {
        name: "One-shot execution",
        status: "warn",
        message: "No default profile found; run 'hermes profile create default' first",
      }
    }
    return {
      name: "One-shot execution",
      status: "warn",
      message: `One-shot test failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function checkBindings(config: HermesRuntimeConfig): Promise<DoctorCheck> {
  try {
    const store = new FileBindingStore(config.bindingStorePath)
    const all = await store.getAll()
    if (all.length === 0) {
      return {
        name: "Runtime bindings",
        status: "warn",
        message: "No bindings found. Run 'agents hermes compile <agentId>' to create one.",
      }
    }
    const details = all.map((b) => `  ${b.agentId} -> ${b.profileName}`).join("\n")
    return {
      name: "Runtime bindings",
      status: "pass",
      message: `${all.length} binding(s) found`,
      detail: details,
    }
  } catch (error) {
    return {
      name: "Runtime bindings",
      status: "fail",
      message: `Cannot read bindings: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

async function checkBindingIntegrity(bindings: RuntimeBinding[]): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = []

  for (const b of bindings) {
    // SOUL.md exists?
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    const profileDir = path.join(homeDir, ".hermes", "profiles", b.profileName)
    const soulMdPath = path.join(profileDir, "SOUL.md")
    try {
      await fs.access(soulMdPath)
      checks.push({
        name: `SOUL.md (${b.profileName})`,
        status: "pass",
        message: "SOUL.md exists",
      })
    } catch {
      checks.push({
        name: `SOUL.md (${b.profileName})`,
        status: "fail",
        message: `SOUL.md not found at ${soulMdPath}`,
        detail: "Recompile with 'agents hermes compile " + b.agentId + "'",
      })
    }

    // terminal.cwd exists?
    const configPath = path.join(profileDir, "config.json")
    try {
      const config = JSON.parse(await fs.readFile(configPath, "utf-8"))
      const cwd = (config as any)?.terminal?.cwd
      if (!cwd) {
        checks.push({
          name: `terminal.cwd (${b.profileName})`,
          status: "warn",
          message: "terminal.cwd not configured in config.json",
        })
      } else {
        await fs.access(cwd)
        checks.push({
          name: `terminal.cwd (${b.profileName})`,
          status: "pass",
          message: `cwd exists: ${cwd}`,
        })
      }
    } catch (error: any) {
      checks.push({
        name: `terminal.cwd (${b.profileName})`,
        status: "warn",
        message: `Cannot read config.json: ${error instanceof Error ? error.message : String(error)}`,
      })
    }
  }

  return checks
}

// ---------------------------------------------------------------------------
// Main doctor
// ---------------------------------------------------------------------------

export async function runDoctor(config: HermesRuntimeConfig): Promise<DoctorReport> {
  const checks: DoctorCheck[] = []

  checks.push(await checkHermesInstalled())
  checks.push(await checkHermesVersion())
  checks.push(await checkProfileDirExists())
  checks.push(await checkProfileCreate())
  checks.push(await checkOneShotExecution())

  // Bindings checks.
  checks.push(await checkBindings(config))

  // Per-binding integrity.
  const store = new FileBindingStore(config.bindingStorePath)
  const all = await store.getAll()
  const integrityChecks = await checkBindingIntegrity(all)
  checks.push(...integrityChecks)

  const passed = checks.filter((c) => c.status === "pass").length
  const failed = checks.filter((c) => c.status === "fail").length
  const warnings = checks.filter((c) => c.status === "warn").length

  return { checks, passed, failed, warnings }
}

function formatDoctorReport(report: DoctorReport): string {
  const nameWidth = Math.max(...report.checks.map((c) => c.name.length), 10)

  const lines: string[] = []
  lines.push("── Hermes Runtime Health ──")
  lines.push("")

  for (const check of report.checks) {
    const icon =
      check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "!"
    const color =
      check.status === "pass"
        ? "\x1b[32m"
        : check.status === "fail"
          ? "\x1b[31m"
          : "\x1b[33m"
    lines.push(
      `  ${color}${icon}\x1b[0m  ${check.name.padEnd(nameWidth)}  ${check.message}`,
    )
    if (check.detail) {
      lines.push(`  ${" ".repeat(nameWidth + 6)}${check.detail}`)
    }
  }

  lines.push("")
  lines.push(
    `  \x1b[32m${report.passed} passed\x1b[0m, ` +
      `\x1b[31m${report.failed} failed\x1b[0m, ` +
      `\x1b[33m${report.warnings} warnings\x1b[0m`,
  )
  lines.push("")

  if (report.failed > 0) {
    lines.push("  Fix failed checks before running agents with Hermes.")
  }

  return lines.join("\n")
}

export { formatDoctorReport }
