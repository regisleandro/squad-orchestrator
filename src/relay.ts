// Relay de eventos: assina o SSE (`GET /event`) do kilo serve de cada sandbox,
// classifica os eventos no vocabulário da UI e republica para os browsers
// inscritos em `GET /tasks/:id/events`.
//
// Mapeamento (formato dos eventos validado no schema do Kilo):
//   message.part.updated  part.type=tool, tool=task          -> squad.member (nasce/termina membro da squad;
//                                                               state.metadata.sessionId = sessão filha)
//   message.part.updated  part.type=tool, tool=board_post|board_read -> board.activity (+ refresh do board)
//   message.part.updated  part.type=tool (demais)            -> tool
//   message.part.updated  part.type=text|reasoning|...       -> message
//   message.updated                                          -> message (metadados da mensagem)
//   message.part.delta                                       -> message.delta
//   permission.asked / permission.replied                    -> permission.*
//   session.status { status.type: busy|idle|retry|offline }  -> session.status (+ status da tarefa)
//   session.idle / session.error / session.diff              -> idem
//
// Board em tempo real: `GET .../board` é pull. Estratégia do POC = híbrida: cada
// board_post/board_read no stream dispara um refresh (throttle 400ms) do snapshot,
// e há um polling de segurança a cada 15s enquanto a sessão está ocupada.

import { EventEmitter } from "node:events"
import { KiloClient } from "./kilo.js"
import type { TaskStore } from "./store.js"
import type { KiloEvent, Task, UiEvent, UiEventKind } from "./types.js"

const BOARD_TOOLS = new Set(["board_post", "board_read"])
// "sync" são envelopes duplicados do mesmo evento (para réplicas); o relay usa só o evento direto.
const IGNORED = new Set(["server.connected", "server.heartbeat", "sync"])

export class Relay {
  /** Emite `event:<taskID>` com UiEvent para os assinantes SSE. */
  readonly bus = new EventEmitter().setMaxListeners(0)
  private subs = new Map<string, { abort: AbortController; boardTimer?: NodeJS.Timeout; poll?: NodeJS.Timeout }>()

  constructor(private store: TaskStore) {}

  publish(taskID: string, kind: UiEventKind, data: unknown): UiEvent {
    const event = this.store.appendEvent(taskID, kind, data)
    this.bus.emit(`event:${taskID}`, event)
    return event
  }

  setStatus(taskID: string, status: Task["status"], error?: string) {
    if (this.store.get(taskID)?.status === status && !error) return
    const task = this.store.update(taskID, { status, ...(status === "running" ? { error: undefined } : error ? { error } : {}) })
    this.publish(taskID, "task.status", { status: task.status, error: task.error })
  }

  /** Começa a ouvir o kilo serve da tarefa. Resolve quando o stream abriu pela primeira vez. */
  attach(task: Task): Promise<void> {
    if (!task.sandbox) throw new Error("tarefa sem sandbox")
    this.detach(task.id)
    const client = new KiloClient(task.sandbox)
    const abort = new AbortController()
    const sub: { abort: AbortController; boardTimer?: NodeJS.Timeout; poll?: NodeJS.Timeout } = { abort }
    this.subs.set(task.id, sub)

    sub.poll = setInterval(() => {
      const t = this.store.get(task.id)
      if (t?.status === "running") this.refreshBoard(task.id)
    }, 15_000)

    return new Promise((resolve) => {
      let opened = false
      void client.subscribe(
        (event) => this.handle(task.id, event),
        abort.signal,
        (state) => {
          if (state === "open" && !opened) {
            opened = true
            resolve()
          }
          if (state === "closed" && !abort.signal.aborted) this.publish(task.id, "error", { message: "stream do kilo caiu; reconectando" })
        },
      )
    })
  }

  detach(taskID: string) {
    const sub = this.subs.get(taskID)
    if (!sub) return
    sub.abort.abort()
    clearTimeout(sub.boardTimer)
    clearInterval(sub.poll)
    this.subs.delete(taskID)
  }

  /** Busca o snapshot do board da sessão raiz e publica como board.snapshot. */
  async refreshBoard(taskID: string) {
    const task = this.store.get(taskID)
    if (!task?.sandbox || !task.sessionID) return
    try {
      const board = await new KiloClient(task.sandbox).board(task.sessionID, { limit: 50 })
      this.publish(taskID, "board.snapshot", board)
    } catch (err) {
      // kilo 7.8.1 devolve 200 com messages=[] antes do 1º board_post; 404 só se a sessão sumiu
      if (!String(err).includes("-> 404")) this.publish(taskID, "error", { message: `board: ${String(err)}` })
    }
  }

  private scheduleBoardRefresh(taskID: string) {
    const sub = this.subs.get(taskID)
    if (!sub) return
    // Throttle (não debounce): uma rajada de posts não adia o refresh indefinidamente.
    if (sub.boardTimer) return
    sub.boardTimer = setTimeout(() => {
      sub.boardTimer = undefined
      void this.refreshBoard(taskID)
    }, 400)
  }

  private handle(taskID: string, event: KiloEvent) {
    if (!event?.type || IGNORED.has(event.type)) return
    const task = this.store.get(taskID)
    if (!task) return
    this.store.touch(taskID)
    const p: Record<string, any> = event.properties ?? event.data ?? {}

    switch (event.type) {
      case "message.updated": // info da mensagem (role, agente, modelo, custo)
        return void this.publish(taskID, "message", p)

      case "message.part.delta":
        return void this.publish(taskID, "message.delta", p)

      case "message.part.updated": {
        const part = p.part ?? {}
        if (part.type !== "tool") return void this.publish(taskID, "message", p)
        if (part.tool === "task") return this.handleTaskTool(task, part)
        if (BOARD_TOOLS.has(part.tool)) {
          this.publish(taskID, "board.activity", {
            sessionID: part.sessionID,
            tool: part.tool,
            status: part.state?.status,
            input: part.state?.input,
          })
          if (part.state?.status === "completed") this.scheduleBoardRefresh(taskID)
          return
        }
        return void this.publish(taskID, "tool", p)
      }

      case "permission.asked": {
        task.pendingPermissions[p.id] = {
          id: p.id,
          sessionID: p.sessionID,
          permission: p.permission,
          patterns: p.patterns ?? [],
          metadata: p.metadata ?? {},
          always: p.always ?? [],
          askedAt: Date.now(),
        }
        this.publish(taskID, "permission.asked", task.pendingPermissions[p.id])
        return this.setStatus(taskID, "waiting_permission")
      }

      case "permission.replied": {
        delete task.pendingPermissions[p.requestID]
        this.publish(taskID, "permission.replied", p)
        if (task.status === "waiting_permission" && Object.keys(task.pendingPermissions).length === 0) {
          this.setStatus(taskID, "running")
        }
        return
      }

      case "session.status": {
        this.publish(taskID, "session.status", p)
        if (p.sessionID !== task.sessionID) return
        const type = p.status?.type
        if (type === "busy" && task.status !== "waiting_permission") this.setStatus(taskID, "running")
        if (type === "idle" && !["error", "stopped"].includes(task.status)) this.setStatus(taskID, "idle")
        return
      }

      case "session.idle":
        this.publish(taskID, "session.status", { sessionID: p.sessionID, status: { type: "idle" } })
        if (p.sessionID === task.sessionID) {
          if (!["error", "stopped"].includes(task.status)) this.setStatus(taskID, "idle")
          this.scheduleBoardRefresh(taskID)
        }
        return

      case "session.error":
        this.publish(taskID, "error", p)
        if (p.sessionID === task.sessionID && task.status !== "stopped") {
          this.setStatus(taskID, "error", p.message ?? p.error?.data?.message ?? p.error?.name ?? "O turno falhou")
        }
        return

      case "session.diff":
        return void this.publish(taskID, "session.diff", p)

      default:
        return void this.publish(taskID, "raw", event)
    }
  }

  /** Tool `task` = um membro da squad sendo delegado (subagente com sessão filha). */
  private handleTaskTool(task: Task, part: any) {
    const state = part.state ?? {}
    const input = state.input ?? {}
    const prev = task.members[part.callID]
    const member = {
      callID: part.callID,
      sessionID: state.metadata?.sessionId ?? prev?.sessionID,
      agent: input.subagent_type ?? prev?.agent ?? "?",
      description: input.description ?? prev?.description ?? "",
      status: state.status ?? "pending",
      startedAt: prev?.startedAt ?? Date.now(),
      endedAt: state.status === "completed" || state.status === "error" ? Date.now() : undefined,
    }
    task.members[part.callID] = member
    this.publish(task.id, "squad.member", { ...member, parentSessionID: part.sessionID })
  }
}
