import * as fs from "fs/promises"
import * as path from "path"
import * as crypto from "crypto"
import type {
  AgentProfile,
  RuntimeBinding,
  RuntimeCompiler,
  RuntimeBindingStore,
} from "../legacy-interface"
import { RUNTIME_COMPILER_VERSION } from "../legacy-interface"
import { HermesRuntimeError, TOOLSET_MAPPING } from "./types"
import type { HermesRuntimeConfig, HermesRuntimeBinding } from "./types"

export class HermesProfileCompiler implements RuntimeCompiler {
  readonly runtimeType = "hermes"

  constructor(
    private readonly config: HermesRuntimeConfig,
    private readonly bindingStore: RuntimeBindingStore,
    private readonly dataDir: string,
  ) {}

  async compile(agentId: string, profile: AgentProfile): Promise<RuntimeBinding> {
    const profileName = this.buildProfileName(agentId)

    // Map AgentCompany tools → Hermes toolsets (needed both for config and hash).
    const toolsets = this.mapToolsets(profile.tools)

    // Compute content hash — must include EVERY field whose change should
    // trigger a recompile. The identity of the profile is this hash.
    // Fields: compilerVersion, persona, instruct, tools, toolsets, workspace.cwd,
    //         model, skills, responsibilities, commandMode.
    const contentHash = this.computeAgentHash(profile, toolsets)

    // Check if already compiled with matching hash AND the Hermes profile
    // still exists on disk (user may have manually deleted it).
    const existing = await this.bindingStore.get(agentId)
    if (existing && existing.compiledHash === contentHash) {
      const profileDir = this.getProfileDir(existing.profileName)
      try {
        await fs.access(profileDir)
        return existing
      } catch {
        // Profile directory was removed — fall through and recompile.
      }
    }

    // Get or create the Hermes profile directory.
    await this.ensureProfile(profileName)

    // Write stable persona into SOUL.md.
    const soulMdPath = await this.writeSoulMd(profileName, profile)

    // Configure terminal.cwd — prefer AgentProfile.workspace.cwd, validate it
    // exists, then fall back to process.cwd().
    await this.configureTerminal(profileName, profile.workspace?.cwd)

    // Configure toolsets.
    await this.writeToolsets(profileName, toolsets)

    // Persist binding.
    const binding: HermesRuntimeBinding = {
      agentId,
      runtimeType: "hermes",
      profileName,
      compiledHash: contentHash,
      compiledAt: Date.now(),
      metadata: {
        soulMdPath,
        toolsets,
        compilerVersion: RUNTIME_COMPILER_VERSION,
        commandMode: "oneshot",
      },
    }

    await this.bindingStore.save(binding)
    return binding
  }

  async isCompiled(agentId: string): Promise<boolean> {
    const binding = await this.bindingStore.get(agentId)
    return binding !== null
  }

  async getBinding(agentId: string): Promise<RuntimeBinding | null> {
    return this.bindingStore.get(agentId)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private buildProfileName(agentId: string): string {
    return `${this.config.profilePrefix}-${agentId}`
  }

  /**
   * Hash ALL fields whose mutation should invalidate the compiled profile.
   *
   * Covers: compilerVersion, persona (system_prompt / instruct), tools,
   *         mapped Hermes toolsets, workspace.cwd, model, skills,
   *         responsibilities, and commandMode.
   *
   * Sorting arrays before hashing ensures deterministic output regardless of
   * insertion order.
   */
  private computeAgentHash(profile: AgentProfile, toolsets: string[]): string {
    const payload = {
      compilerVersion: RUNTIME_COMPILER_VERSION,
      persona: profile.persona,
      instruct: profile.instruct,
      tools: [...(profile.tools ?? [])].sort(),
      toolsets: [...toolsets].sort(),
      workspaceCwd: profile.workspace?.cwd,
      model: profile.model,
      skills: [...(profile.skills ?? [])].sort(),
      responsibilities: [...(profile.responsibilities ?? [])].sort(),
      commandMode: "oneshot",
    }
    return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex")
  }

  private async ensureProfile(profileName: string): Promise<void> {
    const profileDir = this.getProfileDir(profileName)
    try {
      await fs.access(profileDir)
      // Profile already exists.
    } catch {
      if (this.config.cloneModePreferred && this.config.defaultCloneSource) {
        await this.cloneProfile(this.config.defaultCloneSource, profileName)
      } else {
        await this.createProfile(profileName)
      }
    }
  }

  private async cloneProfile(source: string, target: string): Promise<void> {
    const { execSync } = await import("child_process")
    try {
      execSync(`hermes profile clone ${source} ${target}`, {
        stdio: "pipe",
        timeout: 30_000,
      })
    } catch {
      // Fall back to create if clone fails.
      await this.createProfile(target)
    }
  }

  private async createProfile(profileName: string): Promise<void> {
    const { execSync } = await import("child_process")
    try {
      execSync(`hermes profile create ${profileName}`, {
        stdio: "pipe",
        timeout: 30_000,
      })
    } catch (error) {
      // Profile already exists is not a failure.
      // execSync throws with stdout/stderr as Buffers.
      const err = error as any
      const stdout = Buffer.isBuffer(err?.stdout) ? err.stdout.toString() : (err?.stdout ?? "")
      const stderr = Buffer.isBuffer(err?.stderr) ? err.stderr.toString() : (err?.stderr ?? "")
      const message = err instanceof Error ? err.message : String(error)
      if (stdout.includes("already exists") || stderr.includes("already exists") || message.includes("already exists")) return
      throw new HermesRuntimeError(
        "COMPILATION_FAILED",
        `Failed to create Hermes profile ${profileName}`,
        error,
      )
    }
  }

  private async writeSoulMd(
    profileName: string,
    profile: AgentProfile,
  ): Promise<string> {
    const profileDir = this.getProfileDir(profileName)
    const soulMdPath = path.join(profileDir, "SOUL.md")

    const sections: string[] = []

    // SOUL.md contains STABLE persona only.
    if (profile.persona) sections.push(profile.persona)
    if (profile.description) sections.push(`\n## Role\n${profile.description}`)
    if (profile.responsibilities?.length) {
      sections.push(
        `\n## Responsibilities\n${profile.responsibilities.map((r) => `- ${r}`).join("\n")}`,
      )
    }
    if (profile.instruct) sections.push(`\n## Instructions\n${profile.instruct}`)

    // Per-turn room context is injected via HermesRuntimeAdapter.run(),
    // NOT persisted here.

    const content = sections.join("\n\n")
    await fs.mkdir(profileDir, { recursive: true })
    await fs.writeFile(soulMdPath, content)
    return soulMdPath
  }

  /**
   * Prefer AgentProfile.workspace.cwd. Validate it exists on disk before
   * writing. Fall back to process.cwd() when no workspace config is provided.
   */
  private async configureTerminal(
    profileName: string,
    workspaceCwd?: string,
  ): Promise<void> {
    const resolvedCwd = workspaceCwd ?? process.cwd()

    // Validate the directory exists.
    try {
      const stat = await fs.stat(resolvedCwd)
      if (!stat.isDirectory()) {
        throw new HermesRuntimeError(
          "WORKSPACE_NOT_FOUND",
          `Configured cwd is not a directory: ${resolvedCwd}`,
        )
      }
    } catch (error) {
      if (error instanceof HermesRuntimeError) throw error
      throw new HermesRuntimeError(
        "WORKSPACE_NOT_FOUND",
        `Workspace directory does not exist: ${resolvedCwd}`,
        error,
      )
    }

    const profileDir = this.getProfileDir(profileName)
    const configPath = path.join(profileDir, "config.json")

    let config: Record<string, unknown> = {}
    try {
      const existing = await fs.readFile(configPath, "utf-8")
      config = JSON.parse(existing)
    } catch {
      // File doesn't exist yet.
    }

    config.terminal = {
      ...(config.terminal as Record<string, unknown> | undefined),
      cwd: resolvedCwd,
    }

    await fs.writeFile(configPath, JSON.stringify(config, null, 2))
  }

  /**
   * Map AgentCompany tool capabilities to Hermes toolsets.
   * Empty / missing tools default to ["read", "write", "edit", "search", "execute"].
   */
  private mapToolsets(agentTools: string[]): string[] {
    if (!agentTools || agentTools.length === 0) {
      return ["read", "write", "edit", "search", "execute"]
    }

    const set = new Set<string>()
    for (const tool of agentTools) {
      const mapping = TOOLSET_MAPPING[tool]
      if (mapping) mapping.forEach((t) => set.add(t))
    }

    // If nothing mapped, fall back to safe defaults.
    if (set.size === 0) {
      return ["read", "write", "edit", "search", "execute"]
    }

    return Array.from(set)
  }

  private async writeToolsets(
    profileName: string,
    toolsets: string[],
  ): Promise<void> {
    const profileDir = this.getProfileDir(profileName)
    const configPath = path.join(profileDir, "config.json")

    let config: Record<string, unknown> = {}
    try {
      const existing = await fs.readFile(configPath, "utf-8")
      config = JSON.parse(existing)
    } catch {
      // File doesn't exist yet.
    }

    config.toolsets = toolsets
    await fs.writeFile(configPath, JSON.stringify(config, null, 2))
  }

  private getProfileDir(profileName: string): string {
    const homeDir = process.env.HOME || process.env.USERPROFILE || ""
    return path.join(homeDir, ".hermes", "profiles", profileName)
  }
}
