import { EOL } from "os"
import { errorMessage } from "../util/error"

export type JsonArgs = object

type CliError = {
  code: string
  message: string
  details?: unknown
}

export type CliResult<T> =
  | {
      ok: true
      type: string
      data: T
    }
  | {
      ok: false
      type: string
      error: CliError
    }

export function printJson<T>(value: T) {
  process.stdout.write(JSON.stringify(value, null, 2) + EOL)
}

export function printSuccess<T>(args: JsonArgs, type: string, data: T, text?: (data: T) => string | void) {
  if (wantsJson(args)) {
    printJson({ ok: true, type, data } satisfies CliResult<T>)
    return
  }

  const rendered =
    text?.(data) ??
    (typeof data === "string" ? data : data === undefined ? "" : JSON.stringify(data, null, 2))
  if (rendered) process.stdout.write(rendered.endsWith(EOL) ? rendered : rendered + EOL)
}

export function printFailure(type: string, code: string, error: unknown, details?: unknown) {
  printJson({
    ok: false,
    type,
    error: {
      code,
      message: errorMessage(error),
      ...(details === undefined ? {} : { details }),
    },
  } satisfies CliResult<never>)
}

export async function runJsonCommand<T>(
  args: JsonArgs,
  type: string,
  fn: () => Promise<T>,
  text?: (data: T) => string | void,
) {
  if (!wantsJson(args)) {
    printSuccess(args, type, await fn(), text)
    return
  }

  try {
    printSuccess(args, type, await fn(), text)
  } catch (error) {
    printFailure(type, "CLI_COMMAND_FAILED", error)
    process.exitCode = 1
  }
}

function wantsJson(args: JsonArgs) {
  return "json" in args && (args as { json?: unknown }).json === true
}
