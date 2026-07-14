import { execFile } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { promisify } from "node:util"

import type { Configuration } from "electron-builder"
import { PRODUCT_BRAND } from "./src/shared/brand"

const execFileAsync = promisify(execFile)
const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const signScript = path.join(rootDir, "script", "sign-windows.ps1")

async function signWindows(configuration: { path: string }) {
  if (process.platform !== "win32") return
  if (process.env.GITHUB_ACTIONS !== "true") return

  await execFileAsync(
    "pwsh",
    ["-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", signScript, configuration.path],
    { cwd: rootDir },
  )
}

const channel = (() => {
  const raw = process.env.AGENTCOMPANY_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  return "dev"
})()

const getBase = (): Configuration => ({
  artifactName: "agent-company-desktop-${os}-${arch}.${ext}",
  directories: {
    output: "dist",
    buildResources: "resources",
  },
  files: ["out/**/*", "resources/**/*"],
  extraResources: [
    {
      from: "native/",
      to: "native/",
      filter: ["index.js", "index.d.ts", "build/Release/mac_window.node", "swift-build/**"],
    },
  ],
  mac: {
    category: "public.app-category.developer-tools",
    icon: `resources/icons/icon.icns`,
    hardenedRuntime: true,
    gatekeeperAssess: false,
    entitlements: "resources/entitlements.plist",
    entitlementsInherit: "resources/entitlements.plist",
    notarize: true,
    target: ["dmg", "zip"],
  },
  dmg: {
    sign: true,
  },
  protocols: {
    name: PRODUCT_BRAND.names.prod,
    schemes: [PRODUCT_BRAND.deep_link_protocol],
  },
  win: {
    icon: `resources/icons/icon.ico`,
    signtoolOptions: {
      sign: signWindows,
    },
    target: ["nsis"],
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    installerIcon: `resources/icons/icon.ico`,
    installerHeaderIcon: `resources/icons/icon.ico`,
  },
  linux: {
    icon: `resources/icons`,
    category: "Development",
    target: ["AppImage", "deb", "rpm"],
  },
})

function getConfig() {
  const base = getBase()

  switch (channel) {
    case "dev": {
      return {
        ...base,
        appId: PRODUCT_BRAND.app_ids.dev,
        productName: PRODUCT_BRAND.names.dev,
        rpm: { packageName: "agent-company-dev" },
      }
    }
    case "beta": {
      return {
        ...base,
        appId: PRODUCT_BRAND.app_ids.beta,
        productName: PRODUCT_BRAND.names.beta,
        protocols: { name: PRODUCT_BRAND.names.beta, schemes: [PRODUCT_BRAND.deep_link_protocol] },
        rpm: { packageName: "agent-company-beta" },
      }
    }
    case "prod": {
      return {
        ...base,
        appId: PRODUCT_BRAND.app_ids.prod,
        productName: PRODUCT_BRAND.names.prod,
        protocols: { name: PRODUCT_BRAND.names.prod, schemes: [PRODUCT_BRAND.deep_link_protocol] },
        rpm: { packageName: "agent-company" },
      }
    }
  }
}

export default getConfig()
