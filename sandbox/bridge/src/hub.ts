// Barramento de eventos da ponte. Tudo o que os runners (Claude Code, Codex) produzem
// sai daqui no mesmo formato do `GET /event` do kilo serve, para que o relay do
// orquestrador e a UI não precisem saber qual harness está rodando.

import type { ServerResponse } from "node:http"
import { randomBytes } from "node:crypto"

export type PermissionReply = "once" | "always" | "reject"

export interface PendingPermission {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
}

export interface BoardMessage {
  id: string
  timestamp: number
  from: string
  to: string
  fromLabel?: string
  toLabel?: string
  type: "INFO" | "ASK" | "RESULT" | "HOLD" | "VETO"
  body: string
  reply_to?: string
}

export const newID = (prefix: string) => `${prefix}_${randomBytes(8).toString("hex")}`

export class Hub {
  readonly clients = new Set<ServerResponse>()
  private seq = 0
  private pending = new Map<string, { request: PendingPermission; resolve: (r: PermissionReply) => void }>()
  readonly sessionStatus: Record<string, { type: string }> = {}

  // Board do Swarm emulado (só o Claude Code usa, via MCP in-process). Mesmo formato do Kilo.
  board: BoardMessage[] = []
  boardRevision = 0

  emit(type: string, properties: Record<string, unknown>) {
    const data = JSON.stringify({ id: `evt_${++this.seq}`, type, properties })
    for (const c of this.clients) c.write(`data: ${data}\n\n`)
  }

  status(sessionID: string, type: "busy" | "idle" | "retry", extra: Record<string, unknown> = {}) {
    this.sessionStatus[sessionID] = { type }
    this.emit("session.status", { sessionID, status: { type, ...extra } })
    if (type === "idle") this.emit("session.idle", { sessionID })
  }

  message(sessionID: string, id: string, role: "user" | "assistant", agent: string) {
    this.emit("message.updated", { sessionID, info: { id, sessionID, role, agent } })
  }

  /** Parte de texto (ou reasoning) completa; a UI substitui o texto se o id já existir. */
  text(sessionID: string, messageID: string, partID: string, text: string, type: "text" | "reasoning" = "text") {
    this.emit("message.part.updated", { sessionID, part: { id: partID, messageID, sessionID, type, text }, time: Date.now() })
  }

  /** Mensagem de usuário numa sessão (prompt da tarefa, follow-up ou instrução recebida por um membro). */
  userText(sessionID: string, agent: string, text: string) {
    const messageID = newID("msg")
    this.message(sessionID, messageID, "user", agent)
    this.text(sessionID, messageID, newID("prt"), text)
  }

  tool(
    sessionID: string,
    callID: string,
    tool: string,
    status: "pending" | "running" | "completed" | "error",
    input: Record<string, unknown>,
    extra: { output?: string; metadata?: Record<string, unknown>; title?: string } = {},
  ) {
    this.emit("message.part.updated", {
      sessionID,
      part: {
        id: `prt_${callID}`,
        sessionID,
        type: "tool",
        tool,
        callID,
        state: { status, input, output: extra.output, metadata: extra.metadata, title: extra.title },
      },
      time: Date.now(),
    })
  }

  error(sessionID: string, message: string, name = "HarnessError") {
    this.emit("session.error", { sessionID, error: { name, data: { message } } })
  }

  /** Abre um pedido de permissão e espera a UI responder (POST /permission/:id/reply). */
  ask(request: Omit<PendingPermission, "id">, signal?: AbortSignal): Promise<PermissionReply> {
    const id = newID("per")
    const full = { id, ...request }
    return new Promise((resolve) => {
      const done = (reply: PermissionReply) => {
        if (!this.pending.delete(id)) return
        this.emit("permission.replied", { sessionID: full.sessionID, requestID: id, reply })
        resolve(reply)
      }
      this.pending.set(id, { request: full, resolve: done })
      signal?.addEventListener("abort", () => done("reject"), { once: true })
      this.emit("permission.asked", full)
    })
  }

  reply(id: string, reply: PermissionReply): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    entry.resolve(reply)
    return true
  }

  pendingPermissions(): PendingPermission[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  rejectAll() {
    for (const p of [...this.pending.values()]) p.resolve("reject")
  }

  postBoard(msg: Omit<BoardMessage, "id" | "timestamp">): BoardMessage {
    const full = { id: `brd_${this.board.length + 1}`, timestamp: Date.now(), ...msg }
    this.board.push(full)
    return full
  }

  boardSnapshot(ownerSessionID: string, opts: { before?: string; limit?: number } = {}) {
    let messages = this.board
    if (opts.before) {
      const idx = messages.findIndex((m) => m.id === opts.before)
      if (idx >= 0) messages = messages.slice(0, idx)
    }
    const limit = opts.limit ?? 50
    const page = messages.slice(-limit)
    return { ownerSessionID, revision: this.boardRevision, messages: page, cursor: page[0]?.id, hasMore: messages.length > page.length }
  }

  resetBoard(ownerSessionID: string, revision: number) {
    if (revision === this.boardRevision) {
      this.board = []
      this.boardRevision++
    }
    return this.boardSnapshot(ownerSessionID)
  }
}
