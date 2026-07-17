import type { AgentRuntimePort, RuntimeAvailability, RuntimeID } from "./interface"

export class RuntimeRegistry {
  private readonly ports = new Map<RuntimeID, AgentRuntimePort>()

  constructor(ports: AgentRuntimePort[] = []) {
    ports.forEach((port) => this.register(port))
  }

  register(port: AgentRuntimePort) {
    if (this.ports.has(port.runtime)) throw new Error(`Runtime ${port.runtime} is already registered`)
    this.ports.set(port.runtime, port)
    return this
  }

  get(runtime: RuntimeID) {
    return this.ports.get(runtime)
  }

  list() {
    return [...this.ports.values()]
  }

  discover(): Promise<RuntimeAvailability[]> {
    return Promise.all(this.list().map((port) => port.discover()))
  }
}
