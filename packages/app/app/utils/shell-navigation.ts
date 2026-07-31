export type ShellNavigationItem = {
  label: string
  to: string
  hidden?: boolean
}

export function visibleShellNavigation<T extends ShellNavigationItem>(items: readonly T[]) {
  return items.filter((item) => !item.hidden)
}

export function isShellNavigationActive(item: ShellNavigationItem, path: string) {
  const targetPath = item.to.split(/[?#]/, 1)[0]!
  if (targetPath === "/company") return !item.hidden && path === targetPath
  return !item.hidden && (path === targetPath || path.startsWith(`${targetPath}/`))
}

export function activeShellNavigationItem<T extends ShellNavigationItem>(
  items: readonly T[],
  path: string,
) {
  return visibleShellNavigation(items).find((item) => isShellNavigationActive(item, path))
}
