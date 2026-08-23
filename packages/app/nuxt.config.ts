import { mkdirSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import agentCompanyModule from "./modules/agent-company/module"

const privateNoStore = { "cache-control": "private, no-store" } as const
const noStore = { "cache-control": "no-store" } as const
const webuiDataDir = process.env.AGENT_COMPANY_WEBUI_DATA_DIR
if (webuiDataDir) mkdirSync(path.join(webuiDataDir, "db"), { recursive: true })
const nativeLibsqlPackage =
  process.platform === "darwin"
    ? `@libsql/darwin-${process.arch}`
    : process.platform === "linux" && process.arch === "x64"
      ? "@libsql/linux-x64-gnu"
      : process.platform === "win32" && process.arch === "x64"
        ? "@libsql/win32-x64-msvc"
        : undefined

export default defineNuxtConfig({
  buildDir: process.env.AGENT_COMPANY_WEBUI_BUILD_DIR || ".nuxt",
  modules: ["@nuxt/ui", "@comark/nuxt", "eve/nuxt", "@nuxthub/core", agentCompanyModule],
  css: ["~/assets/css/main.css"],
  devtools: { enabled: process.env.NUXT_DEVTOOLS !== "false" },
  compatibilityDate: "latest",
  experimental: {
    payloadExtraction: true,
    viewTransition: true,
  },
  routeRules: {
    "/": { ssr: true, headers: privateNoStore },
    "/inbox/**": { ssr: true, headers: privateNoStore },
    "/work/**": { ssr: true, headers: privateNoStore },
    "/team/**": { ssr: true, headers: privateNoStore },
    "/library/**": { ssr: true, headers: privateNoStore },
    "/company/**": { ssr: true, headers: privateNoStore },
    "/chat/**": { ssr: true, headers: privateNoStore },
    "/settings/**": { ssr: true, headers: privateNoStore },
    "/api/auth/**": { headers: noStore },
    "/api/remote/**": { headers: noStore },
    "/api/internal/**": { headers: noStore },
    "/api/agent-company/**": { headers: noStore },
    "/_eve_internal/**": { headers: noStore },
    "/sw.js": { headers: { "cache-control": "no-cache", "service-worker-allowed": "/" } },
  },
  nitro: {
    output: {
      dir: process.env.AGENT_COMPANY_WEBUI_OUTPUT_DIR || ".output",
    },
    compressPublicAssets: true,
    externals: {
      traceInclude: nativeLibsqlPackage ? [fileURLToPath(import.meta.resolve(nativeLibsqlPackage))] : [],
    },
    prerender: { routes: ["/login"], crawlLinks: false },
  },
  app: {
    head: {
      htmlAttrs: { lang: "zh-CN" },
      title: "Agent Company",
      titleTemplate: "%s · Agent Company",
      charset: "utf-8",
      viewport: "width=device-width, initial-scale=1",
      meta: [
        { name: "description", content: "A local-first company operated by autonomous agents." },
        { name: "theme-color", content: "#1b1718" },
        { name: "color-scheme", content: "light dark" },
        { name: "mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-capable", content: "yes" },
        { name: "apple-mobile-web-app-status-bar-style", content: "default" },
        { name: "apple-mobile-web-app-title", content: "Agent Company" },
        { name: "robots", content: "noindex, nofollow" },
      ],
      link: [
        { rel: "manifest", href: "/manifest.webmanifest" },
        { rel: "icon", type: "image/svg+xml", href: "/agent-company-mark.svg" },
        { rel: "apple-touch-icon", sizes: "180x180", href: "/agent-company-icon-180.png" },
      ],
    },
  },
  fonts: {
    families: [
      { name: "Geist", weights: ["100 900"], global: true },
      { name: "Geist Mono", weights: ["100 900"], global: true },
      { name: "Manrope", weights: ["400 800"] },
    ],
  },
  hub: {
    db: webuiDataDir
      ? {
          dialect: "sqlite",
          driver: "libsql",
          connection: { url: `file:${path.join(webuiDataDir, "db/sqlite.db")}` },
        }
      : "sqlite",
    dir: ".data",
  },
  runtimeConfig: {
    betterAuthSecret: process.env.BETTER_AUTH_SECRET,
    betterAuthUrl: process.env.BETTER_AUTH_URL,
    agentCompanyControlPlaneUrl: process.env.AGENT_COMPANY_CONTROL_PLANE_URL || "http://127.0.0.1:4096",
    agentCompanyControlPlaneAuthorization: process.env.AGENT_COMPANY_CONTROL_PLANE_AUTHORIZATION || "",
    agentCompanyTelemetryUrl: process.env.AGENT_COMPANY_TELEMETRY_URL || "",
    agentCompanyTelemetryAuthorization: process.env.AGENT_COMPANY_TELEMETRY_AUTHORIZATION || "",
    agentCompanyRelayInternalUrl: process.env.AGENT_COMPANY_RELAY_INTERNAL_URL || "http://127.0.0.1:4318",
    agentCompanyRelayServiceToken: process.env.AGENT_COMPANY_RELAY_SERVICE_TOKEN || "",
    public: {
      siteUrl: process.env.NUXT_PUBLIC_SITE_URL || "",
      agentCompanyVersion: process.env.AGENT_COMPANY_VERSION || "0.1.2",
    },
  },
})
