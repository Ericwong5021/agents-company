const dict: Record<string, string> = {
  "cli.providers.mimo_login.decrypt_retry": "Decryption failed. {remaining} attempts remaining.",
  "cli.providers.mimo_login.decrypt_exhausted": "Decryption failed too many times.",
  "cli.providers.select": "Select a provider",
  "cli.providers.mimo.recommended_hint": "Recommended",
  "cli.providers.other": "Other",
}

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = dict[key] ?? key
  if (!params) return raw
  return raw.replace(/\{(\w+)\}/g, (_, name) => (name in params ? String(params[name]) : `{${name}}`))
}
