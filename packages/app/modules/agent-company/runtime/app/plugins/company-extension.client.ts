import { defineNuxtPlugin, navigateTo } from "nuxt/app"
import { createApp, nextTick } from "vue"
import CompanyModuleLauncher from "../components/CompanyModuleLauncher.vue"

function installSettingsTab() {
  const integrations = document.querySelector<HTMLAnchorElement>('a[href="/settings/integrations"]')
  const navigation = integrations?.closest("nav")
  if (!integrations || !navigation || navigation.querySelector('a[href="/settings/company"]')) return

  const link = document.createElement("a")
  link.href = "/settings/company"
  link.dataset.agentCompanySettingsTab = "true"
  link.className = integrations.className
  link.textContent = "Company"
  link.addEventListener("click", (event) => {
    event.preventDefault()
    void navigateTo("/settings/company")
  })
  navigation.append(link)
}

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.hook("app:mounted", async () => {
    await nextTick()
    const root = document.createElement("div")
    root.id = "agent-company-module-root"
    document.body.append(root)

    const launcher = createApp(CompanyModuleLauncher)
    Object.assign(launcher._context, nuxtApp.vueApp._context)
    launcher.mount(root)

    const observer = new MutationObserver(installSettingsTab)
    observer.observe(document.body, { childList: true, subtree: true })
    installSettingsTab()
  })
})
