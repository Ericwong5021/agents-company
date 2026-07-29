import { createHash } from "node:crypto"
import { lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const root = path.resolve(import.meta.dir, "../../..")
const launcherPath = "packages/control-plane/script/seed-grow-pre-public-launcher.ts"
const gatePath = "packages/control-plane/script/seed-grow-pre-public-gate.ts"
const commitSha = /^[a-f0-9]{40}$/
const trustedGitSearchPath = (
  process.platform === "win32"
    ? ["C:\\Program Files\\Git\\cmd", "C:\\Windows\\System32"]
    : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
).join(path.delimiter)
const gitExecutable =
  Bun.which("git", { PATH: trustedGitSearchPath }) ??
  (() => {
    throw new Error("A system Git executable is required for the Pre-Public launcher.")
  })()
const trustedExecutablePath = [
  path.dirname(process.execPath),
  path.dirname(gitExecutable),
  ...trustedGitSearchPath.split(path.delimiter),
]
  .filter((value, index, values) => values.indexOf(value) === index)
  .join(path.delimiter)

function sha256(value: string | Uint8Array) {
  return createHash("sha256").update(value).digest("hex")
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function environment(overrides: Record<string, string>) {
  return {
    ...Object.fromEntries(
      [
        "COLORTERM",
        "COMSPEC",
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        "NUMBER_OF_PROCESSORS",
        "OS",
        "PATHEXT",
        "PROCESSOR_ARCHITECTURE",
        "PROCESSOR_IDENTIFIER",
        "SHELL",
        "SystemDrive",
        "SystemRoot",
        "TERM",
        "WINDIR",
      ]
        .map((key) => [key, process.env[key]])
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    ),
    PATH: trustedExecutablePath,
    TZ: "UTC",
    CI: "1",
    AGENTCOMPANY_DISABLE_CLAUDE_IMPORT: "1",
    AGENTCOMPANY_DISABLE_DEFAULT_PLUGINS: "1",
    AGENTCOMPANY_DISABLE_PROVIDER_ENV: "1",
    AGENTCOMPANY_PURE: "1",
    HUSKY: "0",
    NUXT_TELEMETRY_DISABLED: "1",
    ...overrides,
  }
}

function git(args: string[], bytes = false) {
  const result = Bun.spawnSync([gitExecutable, ...args], {
    cwd: root,
    env: environment({}),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (result.exitCode !== 0)
    throw new Error(`Git verification failed: ${result.stderr.toString().trim().slice(0, 2_000)}`)
  return bytes ? new Uint8Array(result.stdout) : result.stdout.toString().trim()
}

async function main() {
  const requestPath = Bun.argv[2]
  if (!requestPath || !path.isAbsolute(requestPath))
    throw new Error(
      "Usage: AGENTCOMPANY_TRUSTED_VERIFIER_SHA=<sha> bun seed-grow-pre-public-launcher.ts /absolute/request.json",
    )
  const requestInfo = await lstat(requestPath).catch(() => null)
  if (!requestInfo?.isFile() || requestInfo.isSymbolicLink())
    throw new Error("Pre-Public launcher request must be a regular file.")
  const request = await Bun.file(requestPath)
    .json()
    .catch(() => {
      throw new Error("Pre-Public launcher request is not valid JSON.")
    })
  if (!record(request) || (request.mode !== "bootstrap" && request.mode !== "promote"))
    throw new Error("Pre-Public launcher request mode is invalid.")
  const candidate = request.mode === "bootstrap" ? request.candidate : request.current
  const verifierSha = record(candidate) ? candidate.verifierSha : undefined
  const trustedVerifierSha = process.env.AGENTCOMPANY_TRUSTED_VERIFIER_SHA
  if (
    typeof verifierSha !== "string" ||
    !commitSha.test(verifierSha) ||
    !trustedVerifierSha ||
    !commitSha.test(trustedVerifierSha) ||
    verifierSha !== trustedVerifierSha
  )
    throw new Error("Request verifier SHA does not match the externally trusted verifier SHA.")
  if ((await realpath(root)) !== git(["rev-parse", "--show-toplevel"]))
    throw new Error("Pre-Public launcher is not running from its resolved repository.")
  if (git(["rev-parse", "--verify", `${trustedVerifierSha}^{commit}`]) !== trustedVerifierSha)
    throw new Error("Trusted verifier SHA does not resolve to the exact commit.")
  const launcherInfo = await lstat(import.meta.path)
  const launcherSource = new Uint8Array(await Bun.file(import.meta.path).arrayBuffer())
  const trustedLauncherSource = git(["show", `${trustedVerifierSha}:${launcherPath}`], true) as Uint8Array
  if (
    !launcherInfo.isFile() ||
    launcherInfo.isSymbolicLink() ||
    sha256(launcherSource) !== sha256(trustedLauncherSource)
  )
    throw new Error("Launcher source does not match the externally trusted verifier commit.")
  git(["cat-file", "-e", `${trustedVerifierSha}:${gatePath}`])
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "ac-pre-public-verifier-"))
  const worktree = path.join(temporaryRoot, "worktree")
  const added = Bun.spawnSync([gitExecutable, "worktree", "add", "--detach", worktree, trustedVerifierSha], {
    cwd: root,
    env: environment({}),
    stdout: "pipe",
    stderr: "pipe",
  })
  if (added.exitCode !== 0) {
    await rm(temporaryRoot, { recursive: true, force: true })
    throw new Error(`Cannot create exact verifier worktree: ${added.stderr.toString().trim().slice(0, 2_000)}`)
  }
  return (async () => {
    try {
      const isolationRoot = path.join(temporaryRoot, "isolation")
      const directories = Object.fromEntries(
        [
          ["HOME", "home"],
          ["USERPROFILE", "home"],
          ["AGENTCOMPANY_HOME", "agentcompany-home"],
          ["AGENT_COMPANY_WEBUI_DATA_DIR", "webui-data"],
          ["XDG_DATA_HOME", "xdg-data"],
          ["XDG_CONFIG_HOME", "xdg-config"],
          ["XDG_CACHE_HOME", "xdg-cache"],
          ["XDG_STATE_HOME", "xdg-state"],
          ["XDG_RUNTIME_DIR", "xdg-runtime"],
          ["TMPDIR", "temp"],
          ["TMP", "temp"],
          ["TEMP", "temp"],
          ["APPDATA", "app-data"],
          ["LOCALAPPDATA", "local-app-data"],
          ["BUN_INSTALL_CACHE_DIR", "bun-cache"],
          ["BUN_INSTALL_GLOBAL_DIR", "bun-global"],
          ["BUN_INSTALL_BIN", "bun-bin"],
        ].map(([key, value]) => [key, path.join(isolationRoot, value)]),
      )
      await Promise.all(
        [...new Set(Object.values(directories))].map((directory) => mkdir(directory, { recursive: true })),
      )
      await rm(path.join(worktree, "node_modules"), { recursive: true, force: true })
      const install = Bun.spawn(
        [
          process.execPath,
          "install",
          "--frozen-lockfile",
          "--cache-dir",
          directories.BUN_INSTALL_CACHE_DIR!,
          "--backend",
          "copyfile",
          "--no-progress",
          "--no-summary",
        ],
        {
          cwd: worktree,
          env: environment({
            ...directories,
            USER: "agent-company-pre-public-verifier",
            LOGNAME: "agent-company-pre-public-verifier",
          }),
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [installExit, installStdout, installStderr] = await Promise.all([
        install.exited,
        new Response(install.stdout).text(),
        new Response(install.stderr).text(),
      ])
      if (installExit !== 0)
        throw new Error(
          `Fresh verifier dependency install failed: ${(installStderr || installStdout).trim().slice(-8_000)}`,
        )
      if (
        sha256(new Uint8Array(await Bun.file(path.join(worktree, "bun.lock")).arrayBuffer())) !==
        sha256(git(["show", `${trustedVerifierSha}:bun.lock`], true) as Uint8Array)
      )
        throw new Error("Fresh verifier dependency install changed the pinned lockfile.")
      const nodeModules = await lstat(path.join(worktree, "node_modules")).catch(() => null)
      if (
        !nodeModules?.isDirectory() ||
        nodeModules.isSymbolicLink() ||
        !(await realpath(path.join(worktree, "node_modules"))).startsWith(`${await realpath(worktree)}${path.sep}`)
      )
        throw new Error("Fresh verifier dependencies escaped the exact verifier worktree.")
      if (git(["-C", worktree, "status", "--porcelain=v1", "--untracked-files=all"]))
        throw new Error("Fresh verifier worktree drifted during dependency installation.")
      const gate = Bun.spawn([process.execPath, path.join(worktree, gatePath), requestPath], {
        cwd: worktree,
        env: environment({
          ...directories,
          AGENTCOMPANY_TRUSTED_VERIFIER_SHA: trustedVerifierSha,
          AGENTCOMPANY_VERIFIER_LAUNCHER_SHA256: sha256(trustedLauncherSource),
        }),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [exitCode, stdout, stderr] = await Promise.all([
        gate.exited,
        new Response(gate.stdout).text(),
        new Response(gate.stderr).text(),
      ])
      process.stdout.write(stdout)
      process.stderr.write(stderr)
      return exitCode
    } finally {
      const removed = Bun.spawnSync([gitExecutable, "worktree", "remove", "--force", worktree], {
        cwd: root,
        env: environment({}),
        stdout: "pipe",
        stderr: "pipe",
      })
      await rm(temporaryRoot, { recursive: true, force: true })
      if (removed.exitCode !== 0)
        throw new Error(`Cannot remove verifier worktree: ${removed.stderr.toString().trim().slice(0, 2_000)}`)
    }
  })()
}

process.exitCode = await main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
  return 64
})
