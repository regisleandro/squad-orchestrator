// Task orchestrator: (repoUrl, branch, prompt, harness) -> container -> git clone -> kilo serve
// (ou a ponte do Claude Code / Codex, que fala o mesmo protocolo) -> health -> sessão -> prompt
// da squad. Guarda Task <-> sessionID <-> containerID.

import type { Config } from "./config.js"
import { KiloClient } from "./kilo.js"
import type { Relay } from "./relay.js"
import type { SandboxDriver } from "./sandbox.js"
import type { TaskStore } from "./store.js"
import type { Task } from "./types.js"

export class Orchestrator {
  private reaper?: NodeJS.Timeout
  private queue: string[] = []
  private active = 0

  constructor(
    private cfg: Config,
    private store: TaskStore,
    private relay: Relay,
    private driver: SandboxDriver,
    private maxConcurrentProvisioning = 4,
  ) {}

  /** Enfileira a tarefa; o provisionamento roda em background. */
  enqueue(task: Task) {
    this.queue.push(task.id)
    this.drain()
  }

  private drain() {
    while (this.active < this.maxConcurrentProvisioning && this.queue.length) {
      const id = this.queue.shift()!
      this.active++
      void this.run(id).finally(() => {
        this.active--
        this.drain()
      })
    }
  }

  private async run(taskID: string) {
    const task = this.store.get(taskID)
    if (!task || task.status === "stopped") return
    try {
      this.relay.setStatus(taskID, "provisioning")
      const sandbox = await this.driver.provision(task)
      this.store.update(taskID, { sandbox })

      this.relay.setStatus(taskID, "starting")
      const kilo = new KiloClient(sandbox)
      // O entrypoint clona o repo antes de subir o kilo serve, então o health cobre o clone.
      const alive = this.driver.isAlive ? () => this.driver.isAlive!(sandbox) : undefined
      const version = await kilo.waitHealthy(180_000, 1_000, alive)
      this.relay.publish(taskID, "raw", { type: "sandbox.ready", version, harness: task.harness })

      // Assina o stream ANTES de mandar o prompt para não perder os primeiros eventos.
      await Promise.race([this.relay.attach(this.store.get(taskID)!), timeout(15_000, "SSE /event não abriu")])

      const session = await kilo.createSession({ title: task.prompt.slice(0, 80), agent: task.agent })
      this.store.update(taskID, { sessionID: session.id })
      this.relay.publish(taskID, "raw", { type: "session.bound", sessionID: session.id })

      await kilo.promptAsync(session.id, { text: task.prompt, agent: task.agent, model: this.modelFor(task) })
      this.relay.setStatus(taskID, "running")
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const current = this.store.get(taskID)
      let logs: string | undefined
      if (current?.sandbox && this.driver.logs) logs = await this.driver.logs(current.sandbox, 80).catch(() => undefined)
      this.relay.publish(taskID, "error", { message, logs })
      this.relay.setStatus(taskID, "error", message)
    }
  }

  /** Follow-up do usuário na mesma sessão (ou comandos como "/goal pause"). */
  async prompt(task: Task, text: string, agent?: string) {
    const { kilo, sessionID } = this.require(task)
    await kilo.promptAsync(sessionID, { text, agent: agent ?? task.agent, model: this.modelFor(task) })
    this.store.touch(task.id)
    this.relay.setStatus(task.id, "running")
  }

  private modelFor(task: Task) {
    return task.model ?? this.cfg.defaultModels[task.harness]
  }

  async abort(task: Task) {
    const { kilo, sessionID } = this.require(task)
    await kilo.abort(sessionID)
  }

  async destroy(task: Task) {
    this.relay.detach(task.id)
    this.queue = this.queue.filter((id) => id !== task.id)
    if (task.sandbox) await this.driver.destroy(task.sandbox)
    this.relay.setStatus(task.id, "stopped")
  }

  kilo(task: Task) {
    return this.require(task)
  }

  private require(task: Task) {
    if (!task.sandbox || !task.sessionID) throw new HttpError(409, `tarefa em estado ${task.status}, sem sessão ativa`)
    if (task.status === "stopped") throw new HttpError(409, "sandbox já encerrada")
    return { kilo: new KiloClient(task.sandbox), sessionID: task.sessionID }
  }

  /** Spindown: destrói sandboxes ociosas há mais de IDLE_TTL. */
  startReaper(intervalMs = 60_000) {
    this.reaper = setInterval(() => {
      const now = Date.now()
      for (const task of this.store.list()) {
        if (task.status === "stopped" || task.status === "queued") continue
        if (task.status === "running" || task.status === "provisioning" || task.status === "starting") continue
        if (now - task.lastActivityAt > this.cfg.idleTtlMs) {
          this.relay.publish(task.id, "raw", { type: "sandbox.reaped", idleMs: now - task.lastActivityAt })
          void this.destroy(task)
        }
      }
    }, intervalMs)
    this.reaper.unref()
  }

  async shutdown() {
    clearInterval(this.reaper)
    await Promise.all(this.store.list().filter((t) => t.status !== "stopped").map((t) => this.destroy(t)))
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

function timeout(ms: number, message: string) {
  return new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), ms).unref())
}
