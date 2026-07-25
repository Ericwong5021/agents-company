export type ShellNavigationItem = {
  label: string
  to: string
  hidden?: boolean
}

export function visibleShellNavigation<T extends ShellNavigationItem>(items: readonly T[]) {
  return items.filter((item) => !item.hidden)
}

export function isShellNavigationActive(item: ShellNavigationItem, path: string) {
  return !item.hidden && (path === item.to || path.startsWith(`${item.to}/`))
}

export function activeShellNavigationItem<T extends ShellNavigationItem>(
  items: readonly T[],
  path: string,
) {
  return visibleShellNavigation(items).find((item) => isShellNavigationActive(item, path))
}
