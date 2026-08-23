export type AppShellNavigationItem = {
  label: string
  to: string
  icon: string
  badge?: number
  active?: boolean
}

export type AppShellContextTone = "accent" | "danger" | "muted" | "success" | "warning"

export type AppShellContextItem = {
  id: string
  label: string
  to: string
  description?: string
  meta?: string
  icon?: string
  initials?: string
  badge?: number
  active?: boolean
  tone?: AppShellContextTone
}

export type AppShellContextSection = {
  id: string
  label: string
  items: AppShellContextItem[]
  emptyLabel?: string
}
