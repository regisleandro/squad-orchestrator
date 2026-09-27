// TaskStore em memória, com persistência opcional em arquivo (DATA_DIR):
//   <DATA_DIR>/tasks/<id>/task.json     a tarefa (sem o handle da sandbox, que tem a senha)
//   <DATA_DIR>/tasks/<id>/events.jsonl  todos os UiEvent, um por linha (replay completo)
// No boot, as tarefas voltam do disco como "stopped" (as sandboxes não sobrevivem ao restart).
// A interface é pequena de propósito para trocar por Postgres (tasks + task_events) sem mexer no resto.

import { randomUUID } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { CreateTaskInput, Task, UiEvent } from "./types.js"

/** Eventos mantidos em memória por tarefa (SSE e reconexão); o arquivo guarda todos. */
const MAX_EVENTS_PER_TASK = 5_000
const TERMINAL: Task["status"][] = ["stopped", "error"]

export class TaskStore {
  private tasks = new Map<string, Task>()
  private events = new Map<string, UiEvent[]>()
  private seqs = new Map<string, number>()
  private dir?: string

  constructor(dataDir?: string) {
    if (!dataDir) return
    this.dir = join(dataDir, "tasks")
    mkdirSync(this.dir, { recursive: true })
    this.load()
  }

  create(owner: string, input: CreateTaskInput & { agent: string; harness: Task["harness"] }): Task {
    const now = Date.now()
    const task: Task = {
      id: "tsk_" + randomUUID().replaceAll("-", "").slice(0, 20),
      owner,
      repoUrl: input.repoUrl,
      branch: input.branch ?? "", // vazio = branch padrão do repo
      prompt: input.prompt,
      harness: input.harness,
      agent: input.agent,
      model: input.model,
      status: "queued",
      members: {},
      pendingPermissions: {},
      createdAt: now,
      updatedAt: now,
      lastActivityAt: now,
    }
    this.tasks.set(task.id, task)
    this.events.set(task.id, [])
    this.seqs.set(task.id, 0)
    this.save(task)
    return task
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id)
  }

  list(owner?: string): Task[] {
    const all = [...this.tasks.values()]
    return (owner ? all.filter((t) => t.owner === owner) : all).sort((a, b) => b.createdAt - a.createdAt)
  }

  update(id: string, patch: Partial<Task>): Task {
    const task = this.tasks.get(id)
    if (!task) throw new Error(`task ${id} not found`)
    Object.assign(task, patch, { updatedAt: Date.now() })
    this.save(task)
    return task
  }

  touch(id: string) {
    const task = this.tasks.get(id)
    if (task) task.lastActivityAt = Date.now()
  }

  /** Grava o evento no log da tarefa (para replay via Last-Event-ID) e devolve com seq. */
  appendEvent(taskID: string, kind: UiEvent["kind"], data: unknown): UiEvent {
    const seq = (this.seqs.get(taskID) ?? 0) + 1
    this.seqs.set(taskID, seq)
    const event: UiEvent = { seq, taskID, kind, at: Date.now(), data }
    const log = this.events.get(taskID) ?? []
    log.push(event)
    if (log.length > MAX_EVENTS_PER_TASK) log.splice(0, log.length - MAX_EVENTS_PER_TASK)
    this.events.set(taskID, log)
    if (this.dir) {
      try {
        appendFileSync(join(this.dir, taskID, "events.jsonl"), JSON.stringify(event) + "\n")
      } catch (err) {
        console.warn(`[store] não gravou evento de ${taskID}:`, (err as Error).message)
      }
    }
    return event
  }

  eventsSince(taskID: string, afterSeq: number): UiEvent[] {
    return (this.events.get(taskID) ?? []).filter((e) => e.seq > afterSeq)
  }

  /** Log completo para o replay: do arquivo quando há DATA_DIR (a memória guarda só os últimos). */
  allEvents(taskID: string): UiEvent[] {
    if (!this.dir) return this.eventsSince(taskID, 0)
    return readEvents(join(this.dir, taskID, "events.jsonl"))
  }

  private save(task: Task) {
    if (!this.dir) return
    const { sandbox: _, ...rest } = task
    const folder = join(this.dir, task.id)
    try {
      mkdirSync(folder, { recursive: true })
      // escreve e renomeia: um crash no meio não deixa task.json pela metade
      writeFileSync(join(folder, "task.json.tmp"), JSON.stringify(rest, null, 2))
      renameSync(join(folder, "task.json.tmp"), join(folder, "task.json"))
    } catch (err) {
      console.warn(`[store] não salvou ${task.id}:`, (err as Error).message)
    }
  }

  private load() {
    let restored = 0
    for (const id of readdirSync(this.dir!)) {
      const folder = join(this.dir!, id)
      if (!existsSync(join(folder, "task.json"))) continue
      try {
        const task = JSON.parse(readFileSync(join(folder, "task.json"), "utf8")) as Task
        const events = readEvents(join(folder, "events.jsonl"))
        if (!TERMINAL.includes(task.status)) {
          task.status = "stopped"
          task.error = task.error ?? "orquestrador reiniciado: a sandbox desta tarefa não existe mais"
          task.pendingPermissions = {}
        }
        this.tasks.set(task.id, task)
        this.events.set(task.id, events.slice(-MAX_EVENTS_PER_TASK))
        this.seqs.set(task.id, events.length ? events[events.length - 1]!.seq : 0)
        this.save(task)
        restored++
      } catch (err) {
        console.warn(`[store] ignorando ${id}:`, (err as Error).message)
      }
    }
    if (restored) console.log(`[store] ${restored} tarefa(s) restaurada(s) de ${this.dir}`)
  }
}

function readEvents(file: string): UiEvent[] {
  if (!existsSync(file)) return []
  const out: UiEvent[] = []
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // última linha truncada por um crash: descarta
    }
  }
  return out
}

/** Visão pública da tarefa: nunca vaza URL interna nem senha da sandbox. */
export function publicTask(task: Task) {
  const { sandbox, ...rest } = task
  return { ...rest, sandbox: sandbox ? { id: sandbox.id.slice(0, 12) } : undefined }
}
