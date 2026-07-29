import {
  CompanyCommonsMode,
  FounderOSModeSettings,
  FounderOSModeState,
  FounderTwinMode,
} from "@agents-company/shared/founder-os"
import { Flag } from "@/flag/flag"

const FounderTwinModeOrder = FounderTwinMode.options
const CompanyCommonsModeOrder = CompanyCommonsMode.options

function stricter<T extends string>(globalMaximum: T, company: T, order: readonly T[]) {
  return order[Math.min(order.indexOf(globalMaximum), order.indexOf(company))]!
}

export function globalMaximum() {
  return FounderOSModeSettings.parse({
    founderTwinMode: Flag.AGENTCOMPANY_FOUNDER_TWIN_MODE,
    companyCommonsMode: Flag.AGENTCOMPANY_COMPANY_COMMONS_MODE,
  })
}

export function resolve(company: FounderOSModeSettings) {
  const maximum = globalMaximum()
  return FounderOSModeState.parse({
    schemaVersion: 1,
    globalMaximum: maximum,
    company,
    effective: {
      founderTwinMode: stricter(maximum.founderTwinMode, company.founderTwinMode, FounderTwinModeOrder),
      companyCommonsMode: stricter(maximum.companyCommonsMode, company.companyCommonsMode, CompanyCommonsModeOrder),
    },
  })
}
