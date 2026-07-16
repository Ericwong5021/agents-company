import { base64Encode } from "@agents-company/shared/util/encode"

export const companyWorkspacePath = "/"

export function projectWorkspacePath(directory: string) {
  return `/${base64Encode(directory)}/session`
}
