const localServerURLPattern = /https?:\/\/(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]):\d+/g

export function findLocalEveServerOrigin(output: string) {
  return output.match(localServerURLPattern)?.at(-1)
}
