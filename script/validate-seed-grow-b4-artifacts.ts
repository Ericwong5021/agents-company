import { lstat } from "node:fs/promises"
import path from "node:path"
import sharp from "sharp"

const root = path.resolve(import.meta.dir, "..")
const directory = path.join(root, "packages/app/.artifacts/seed-grow-b4")
const reportPath = path.join(directory, "result.json")
const screenshots = [path.join(directory, "work-before-restart.png"), path.join(directory, "work-after-restart.png")]

function record(value: unknown, label: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid.`)
  return value as Record<string, unknown>
}

function allTrue(value: unknown, label: string) {
  const item = record(value, label)
  if (!Object.keys(item).length || Object.values(item).some((entry) => entry !== true))
    throw new Error(`${label} is incomplete.`)
}

export async function validateSeedGrowB4Artifacts() {
  const reportInfo = await lstat(reportPath)
  if (!reportInfo.isFile() || reportInfo.isSymbolicLink()) throw new Error("B4 result is not a regular file.")
  const report = record(await Bun.file(reportPath).json(), "B4 result")
  const candidateSha = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  })
    .stdout.toString()
    .trim()
  if (report.result !== "pass" || report.candidateSha !== candidateSha)
    throw new Error("B4 result does not pass for the exact candidate.")
  if (!Array.isArray(report.uncovered) || report.uncovered.length)
    throw new Error("B4 result contains uncovered requirements.")

  const controlPlane = record(report.controlPlane, "B4 Control Plane result")
  for (const key of [
    "healthy",
    "readiness",
    "providerConfiguredThroughProductAPI",
    "projectCreatedThroughProductAPI",
    "restarted",
    "persistentCompanyIdentity",
  ])
    if (controlPlane[key] !== true) throw new Error(`B4 Control Plane check failed: ${key}`)

  const project = record(report.project, "B4 project result")
  if (
    project.executionStrategy !== "seed_and_grow" ||
    project.seedMode !== "seed_pair" ||
    project.workProjectionAvailability !== "available" ||
    project.independentAgents !== true ||
    !Array.isArray(project.realProviderCalls) ||
    !project.realProviderCalls.some((request) => record(request, "B4 provider request").kind === "wayfinder") ||
    !project.realProviderCalls.some((request) => record(request, "B4 provider request").kind === "builder")
  )
    throw new Error("B4 Seed Pair project result is incomplete.")

  const browser = record(report.browser, "B4 Browser result")
  for (const key of [
    "productionWebUI",
    "seedPairVisible",
    "assignmentReasonAndSourceRefs",
    "graphValidationDiagnostics",
    "eventAfterDOMConverged",
    "sseReconnected",
    "refreshConverged",
  ])
    if (browser[key] !== true) throw new Error(`B4 Browser check failed: ${key}`)
  const states = record(browser.states, "B4 Browser states")
  for (const key of ["loading", "empty", "filteredEmpty", "error", "offline"])
    if (states[key] !== true) throw new Error(`B4 Browser state failed: ${key}`)
  if (typeof states.offlineDiagnostic !== "string" || !states.offlineDiagnostic.trim())
    throw new Error("B4 Browser offline diagnostic is missing.")
  allTrue(browser.accessibility, "B4 Browser accessibility")

  const screenshotDiff = record(report.screenshotDiff, "B4 screenshot diff")
  if (
    report.visualQA !== "pass" ||
    screenshotDiff.changedPixels !== 0 ||
    screenshotDiff.ratio !== 0 ||
    screenshotDiff.maxChannelDelta !== 0
  )
    throw new Error("B4 visual regression result failed.")
  allTrue(report.cleanup, "B4 cleanup")

  const screenshotMetadata = await Promise.all(
    screenshots.map(async (file) => {
      const info = await lstat(file)
      if (!info.isFile() || info.isSymbolicLink()) throw new Error(`B4 screenshot is not a regular file: ${file}`)
      const metadata = await sharp(file).metadata()
      if (!metadata.width || !metadata.height || metadata.width < 1024 || metadata.height < 240)
        throw new Error(`B4 screenshot dimensions are invalid: ${file}`)
      return {
        file: path.relative(root, file).split(path.sep).join("/"),
        width: metadata.width,
        height: metadata.height,
      }
    }),
  )

  return {
    result: "pass",
    candidateSha,
    screenshots: screenshotMetadata,
    sourceWatermarks: controlPlane.sourceWatermarks,
  }
}

if (import.meta.main) console.log(JSON.stringify(await validateSeedGrowB4Artifacts(), null, 2))
