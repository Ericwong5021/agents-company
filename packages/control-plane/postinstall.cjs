const childProcess = require("child_process")
const fs = require("fs")
const os = require("os")
const path = require("path")

const platformMap = {
  darwin: "darwin",
  linux: "linux",
  win32: "windows",
}

const archMap = {
  x64: "x64",
  arm64: "arm64",
  arm: "arm",
}

const platform = platformMap[os.platform()] || os.platform()
const arch = archMap[os.arch()] || os.arch()
const base = `@agents-company/agentcompany-${platform}-${arch}`

function supportsAvx2() {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      return result.status === 0 && (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const cmd =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const exe of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const out = (result.stdout || "").trim().toLowerCase()
        if (out === "true" || out === "1") return true
        if (out === "false" || out === "0") return false
      } catch {
        continue
      }
    }
  }

  return false
}

function linuxUsesMusl() {
  if (platform !== "linux") return false

  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    return false
  }

  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    return ((result.stdout || "") + (result.stderr || "")).toLowerCase().includes("musl")
  } catch {
    return false
  }
}

function candidatePackages() {
  if (platform === "linux") {
    const musl = linuxUsesMusl()
    const baseline = arch === "x64" && !supportsAvx2()

    if (musl && arch === "x64") {
      if (baseline) return [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
      return [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
    }

    if (musl) return [`${base}-musl`, base]

    if (arch === "x64") {
      if (baseline) return [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
      return [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
    }

    return [base, `${base}-musl`]
  }

  if (arch === "x64") {
    if (!supportsAvx2()) return [`${base}-baseline`, base]
    return [base, `${base}-baseline`]
  }

  return [base]
}

const found = candidatePackages().find((name) => {
  try {
    const pkg = require.resolve(`${name}/package.json`, { paths: [__dirname] })
    const binary = path.join(path.dirname(pkg), "bin", platform === "windows" ? "agents.exe" : "agents")
    return fs.existsSync(binary)
  } catch {
    return false
  }
})

if (found) process.exit(0)

const names = candidatePackages()

console.warn(`
Agent Company installed, but the optional platform binary was not found.

Tried:
${names.map((name) => `  - ${name}`).join("\n")}

This usually happens when optional dependencies are disabled or omitted.

Try:
  npm uninstall -g @agents-company/control-plane
  npm install -g @agents-company/control-plane

Do not install with:
  npm install -g @agents-company/control-plane --omit=optional

If your package manager intentionally skips optional dependencies, install the matching binary package manually:
  npm install -g ${names[0]}
`)
