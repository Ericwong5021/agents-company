import { PRODUCT_BRAND } from "../shared/brand"

type Channel = "dev" | "beta" | "prod"
const raw = import.meta.env.AGENTCOMPANY_CHANNEL
export const CHANNEL: Channel = raw === "dev" || raw === "beta" || raw === "prod" ? raw : "dev"

export const SETTINGS_STORE = PRODUCT_BRAND.settings_store
export const DEFAULT_SERVER_URL_KEY = "defaultServerUrl"
export const WSL_ENABLED_KEY = "wslEnabled"
export const DESKTOP_NOTIFICATION_KEYS = "desktopNotificationKeys"
export const UPDATER_ENABLED = false
