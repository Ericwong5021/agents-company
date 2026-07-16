import { spawn } from "child_process"
import type { AgentRunInput, AgentRunOutput, RuntimeAdapter, RuntimeBindingStore } from "../legacy-interface"
import { HermesRuntimeError } from "./types"
import type { HermesRuntimeConfig } from "./types"

export class HermesRuntimeAdapter implements RuntimeAdapter {
  readonly runtimeType = "hermes"

  constructor(
    private readonly config: HermesRuntimeConfig,
    private readonly bindingStore: RuntimeBindingStore,
  ) {}

  async run(input: AgentRunInput): Promise<AgentRunOutput> {
    const startedAt = Date.now()

    // Get the binding for this agent.
    const binding = await this.bindingStore.get(input.agentId)
    if (!binding) {
      throw new HermesRuntimeError(
        "BINDING_NOT_FOUND",
        `No binding found for agent ${input.agentId}. Run compile first.`,
      )
    }

    // Build the command from template: hermes -p <profileName> -z <prompt>.
    const command = this.buildCommand(binding.profileName, input.prompt)
    const timeout = input.timeout ?? this.config.defaultTimeout

    try {
      const result = await this.executeCommand(command, {
        timeout,
        cwd: input.cwd,
      })

      return {
        agentId: input.agentId,
        runtime: "hermes",
        // content = semantically parsed response (currently the full stdout).
        content: result.stdout.trim(),
        rawStdout: result.stdout,
        rawStderr: result.stderr || undefined,
        exitCode: result.exitCode,
        startedAt,
        finishedAt: Date.now(),
        metadata: {
          profileName: binding.profileName,
        },
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (message.toLowerCase().includes("timeout")) {
        throw new HermesRuntimeError(
          "EXECUTION_TIMEOUT",
          `Hermes execution timed out after ${timeout}ms`,
          error,
        )
      }
      throw new HermesRuntimeError(
        "EXECUTION_FAILED",
        `Hermes execution failed: ${message}`,
        error,
      )
    }
  }

  // ---------------------------------------------------------------------------
  // Command building
  // ---------------------------------------------------------------------------

  private buildCommand(profileName: string, prompt: string): string {
    return this.config.commandTemplate
      .replace("<profileName>", profileName)
      .replace("<prompt>", this.escapeShellArg(prompt))
  }

  private escapeShellArg(arg: string): string {
    return `'${arg.replace(/'/g, "'\\''")}'`
  }

  // ---------------------------------------------------------------------------
  // Process execution
  // ---------------------------------------------------------------------------

  private async executeCommand(
    command: string,
    options: { timeout: number; cwd?: string },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(command, [], {
        shell: true,
        timeout: options.timeout,
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      })

      let stdout = ""
      let stderr = ""

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString()
      })

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString()
      })

      child.on("close", (code) => {
        resolve({
          stdout,
          stderr,
          exitCode: code ?? 0,
        })
      })

      child.on("error", (error) => {
        reject(error)
      })
    })
  }
}
