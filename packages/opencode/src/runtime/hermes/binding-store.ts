import * as fs from "fs/promises"
import * as path from "path"
import type { RuntimeBinding, RuntimeBindingStore } from "../legacy-interface"

export class FileBindingStore implements RuntimeBindingStore {
  private readonly storePath: string

  constructor(storePath: string) {
    this.storePath = storePath
  }

  async save(binding: RuntimeBinding): Promise<void> {
    const bindings = await this.loadAll()
    bindings[binding.agentId] = binding
    await this.ensureDir()
    await fs.writeFile(this.storePath, JSON.stringify(bindings, null, 2))
  }

  async get(agentId: string): Promise<RuntimeBinding | null> {
    const bindings = await this.loadAll()
    return bindings[agentId] ?? null
  }

  async getAll(): Promise<RuntimeBinding[]> {
    const bindings = await this.loadAll()
    return Object.values(bindings)
  }

  async delete(agentId: string): Promise<void> {
    const bindings = await this.loadAll()
    delete bindings[agentId]
    await this.ensureDir()
    await fs.writeFile(this.storePath, JSON.stringify(bindings, null, 2))
  }

  private async loadAll(): Promise<Record<string, RuntimeBinding>> {
    try {
      const content = await fs.readFile(this.storePath, "utf-8")
      return JSON.parse(content)
    } catch {
      return {}
    }
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(path.dirname(this.storePath), { recursive: true })
  }
}
