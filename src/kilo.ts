// Cliente HTTP/SSE mínimo para o `kilo serve` de uma sandbox.
//
// Rotas validadas contra Kilo-Org/kilocode (packages/opencode/src/server/routes/instance/httpapi):
//   GET  /global/health                          -> { healthy: true, version }
//   GET  /event?directory=                       -> SSE (server.connected, heartbeat 10s, eventos da instância)
//   POST /session?directory=                     -> Session.Info  (body: { title?, agent?, permission? })
//   POST /session/:id/prompt_async?directory=    -> 204           (body: { agent?, model?, parts[] })
//   POST /session/:id/abort?directory=
//   GET  /session/:id/diff?directory=
//   GET  /session/status?directory=
//   GET  /permission?directory=                  -> pedidos pendentes
//   POST /permission/:requestID/reply?directory= -> { reply: once|always|reject, message?, interactive? }
//   GET  /kilocode/session/:id/board?directory=&before=&limit=  -> SessionBoard
//   POST /kilocode/session/:id/board/reset?directory=           -> body { revision }
// Auth: Basic kilo:<KILO_SERVER_PASSWORD> (usuário padrão "kilo", KILO_SERVER_USERNAME muda).
//
// Usamos fetch puro em vez de @kilocode/sdk para não acoplar a versão do SDK à do
// binário na imagem; trocar por `createKiloClient` do SDK é direto se preferir.

import type { KiloEvent, SandboxHandle } from "./types.js"

export type PermissionReply = "once" | "always" | "reject"

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

export interface SessionBoard {
  ownerSessionID: string
  revision: number
  messages: BoardMessage[]
  cursor?: string
  hasMore: boolean
}

export class KiloError extends Error {
  constructor(
    public status: number,
    public path: string,
    public body: string,
  ) {
    super(`kilo ${path} -> ${status}: ${body.slice(0, 300)}`)
  }
}

export class KiloClient {
  private auth: string

  constructor(private sandbox: SandboxHandle) {
    this.auth = "Basic " + Buffer.from(`kilo:${sandbox.password}`).toString("base64")
  }

  private url(path: string, query: Record<string, string | number | undefined> = {}) {
    const u = new URL(path, this.sandbox.baseUrl)
    if (this.sandbox.directory) u.searchParams.set("directory", this.sandbox.directory)
    for (const [k, v] of Object.entries(query)) if (v !== undefined) u.searchParams.set(k, String(v))
    return u
  }

  private async request<T>(method: string, path: string, body?: unknown, query?: Record<string, any>): Promise<T> {
    const res = await fetch(this.url(path, query), {
      method,
      headers: { Authorization: this.auth, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30_000),
    })
    const text = await res.text()
    if (!res.ok) throw new KiloError(res.status, path, text)
    return (text ? JSON.parse(text) : undefined) as T
  }

  async health(): Promise<{ healthy: true; version: string }> {
    return this.request("GET", "/global/health")
  }

  /** Faz polling do health até responder ou estourar o timeout. */
  async waitHealthy(timeoutMs = 90_000, intervalMs = 1_000, alive?: () => Promise<boolean>): Promise<string> {
    const deadline = Date.now() + timeoutMs
    let last: unknown
    while (Date.now() < deadline) {
      if (alive && !(await alive())) throw new Error("a sandbox encerrou antes do kilo serve subir (veja os logs)")
      try {
        const h = await this.health()
        if (h?.healthy) return h.version
      } catch (err) {
        last = err
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
    throw new Error(`kilo serve não ficou saudável em ${timeoutMs}ms: ${String(last)}`)
  }

  async createSession(input: { title?: string; agent?: string } = {}): Promise<{ id: string }> {
    return this.request("POST", "/session", input)
  }

  async promptAsync(sessionID: string, input: { text: string; agent?: string; model?: string }) {
    // Kilo exige provider/model; a ponte aceita só o id (ex.: "sonnet"), então repassamos assim.
    const model =
      parseModel(input.model) ??
      (input.model && this.sandbox.harness !== "kilo" ? { providerID: this.sandbox.harness, modelID: input.model } : undefined)
    await this.request("POST", `/session/${sessionID}/prompt_async`, {
      agent: input.agent,
      model,
      parts: [{ type: "text", text: input.text }],
    })
  }

  async abort(sessionID: string) {
    return this.request("POST", `/session/${sessionID}/abort`)
  }

  async diff(sessionID: string) {
    return this.request<unknown>("GET", `/session/${sessionID}/diff`)
  }

  async status() {
    return this.request<Record<string, unknown>>("GET", "/session/status")
  }

  async pendingPermissions() {
    return this.request<unknown[]>("GET", "/permission")
  }

  async replyPermission(requestID: string, reply: PermissionReply, message?: string) {
    // interactive: true sinaliza que um humano respondeu (o servidor recusa aprovação "de máquina" em alguns casos)
    return this.request<boolean>("POST", `/permission/${requestID}/reply`, { reply, message, interactive: true })
  }

  async board(sessionID: string, opts: { before?: string; limit?: number } = {}) {
    return this.request<SessionBoard>("GET", `/kilocode/session/${sessionID}/board`, undefined, opts)
  }

  async resetBoard(sessionID: string, revision: number) {
    return this.request<SessionBoard>("POST", `/kilocode/session/${sessionID}/board/reset`, { revision })
  }

  /**
   * Assina `GET /event` e chama `onEvent` para cada evento. Reconecta com backoff
   * até `signal` abortar. Resolve quando o signal aborta.
   */
  async subscribe(onEvent: (e: KiloEvent) => void, signal: AbortSignal, onState?: (s: "open" | "closed") => void) {
    let backoff = 500
    while (!signal.aborted) {
      try {
        const res = await fetch(this.url("/event"), {
          headers: { Authorization: this.auth, Accept: "text/event-stream" },
          signal,
        })
        if (!res.ok || !res.body) throw new KiloError(res.status, "/event", await res.text().catch(() => ""))
        onState?.("open")
        backoff = 500
        for await (const data of parseSse(res.body)) {
          try {
            onEvent(JSON.parse(data))
          } catch {
            // evento malformado: ignora
          }
        }
      } catch (err) {
        if (signal.aborted) break
      }
      onState?.("closed")
      if (signal.aborted) break
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 10_000)
    }
  }
}

function parseModel(model?: string) {
  if (!model) return undefined
  const idx = model.indexOf("/")
  if (idx <= 0) return undefined
  return { providerID: model.slice(0, idx), modelID: model.slice(idx + 1) }
}

/** Parser SSE: devolve o campo `data` de cada evento (linhas `data:` concatenadas). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let buffer = ""
  let data: string[] = []
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      if (line.endsWith("\r")) line = line.slice(0, -1)
      if (line === "") {
        if (data.length) yield data.join("\n")
        data = []
      } else if (line.startsWith("data:")) {
        data.push(line.slice(5).replace(/^ /, ""))
      }
    }
  }
}
