import path from "path"
import { cp, mkdir, mkdtemp } from "fs/promises"
import { expectOk } from "./assert"
import { jsonOf, packageRoot, runCli } from "./cli"

export type ScenarioEnv = {
  root: string
  project: string
  home: string
  agentcompanyHome: string
  artifacts: string
  env: Record<string, string>
}

export async function createScenarioEnv(name: string): Promise<ScenarioEnv> {
  const base = path.join(packageRoot, ".agentcompany-cli-scenarios")
  await mkdir(base, { recursive: true })
  const root = await mkdtemp(path.join(base, `${name}-`))
  const scenario = {
    root,
    project: path.join(root, "project"),
    home: path.join(root, "home"),
    agentcompanyHome: path.join(root, "agentcompany"),
    artifacts: path.join(root, "artifacts"),
    env: {
      HOME: path.join(root, "home"),
      AGENTCOMPANY_HOME: path.join(root, "agentcompany"),
      AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    },
  }

  await Promise.all([mkdir(scenario.project, { recursive: true }), mkdir(scenario.home, { recursive: true }), mkdir(scenario.artifacts, { recursive: true })])
  await copyAuthConfig(scenario)
  return scenario
}

async function copyAuthConfig(scenario: ScenarioEnv) {
  const source = expectOk<Record<string, string>>(jsonOf(await runCli(["debug", "paths", "--json"])))
  const target = expectOk<Record<string, string>>(
    jsonOf(await runCli(["debug", "paths", "--json"], { env: scenario.env, cwd: scenario.project, artifactDir: scenario.artifacts })),
  )

  await Promise.all([
    copyIfExists(source.config, target.config),
    copyIfExists(path.join(source.data, "auth.json"), path.join(target.data, "auth.json")),
  ])
}

async function copyIfExists(source: string | undefined, target: string | undefined) {
  if (!source || !target) return
  if (!(await Bun.file(source).exists())) return
  await cp(source, target, { recursive: true, force: true, errorOnExist: false })
}
