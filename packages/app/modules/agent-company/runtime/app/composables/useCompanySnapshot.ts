import { useFetch } from "nuxt/app"
import { computed } from "vue"
import type { CompanySnapshot } from "../../shared/company-contract"

const loadingSnapshot: CompanySnapshot = {
  connection: "demo",
  company: {
    id: "loading",
    name: "Agent Company",
    provider: "Loading",
    approvalPolicy: "Loading",
  },
  stats: {
    online: 0,
    activeProjects: 0,
    boardMessages: 0,
  },
  agents: [],
  messages: [],
  projects: [],
}

export function useCompanySnapshot() {
  const request = useFetch<CompanySnapshot>("/api/agent-company/snapshot", {
    key: "agent-company-snapshot",
  })

  return {
    ...request,
    data: computed(() => request.data.value ?? loadingSnapshot),
  }
}
