// API HTTP pública do orquestrador (a única coisa que o browser enxerga).
//
//   GET    /harnesses                             -> harnesses habilitados + capacidades (para a UI)
//   POST   /tasks                                 { repoUrl, branch?, prompt, harness?, agent?, model? } -> 202 Task
//   GET    /tasks                                 -> Task[]
//   GET    /tasks/:id                             -> Task
//   GET    /tasks/:id/events                      -> SSE de UiEvent (suporta Last-Event-ID / ?after=)
//   GET    /tasks/:id/replay                      -> { task, events } log completo, para o replay da UI
//   POST   /tasks/:id/prompt                      { text, agent? }       follow-up, "/goal pause", etc.
//   POST   /tasks/:id/permissions/:permissionID   { reply: once|always|reject, message? }
//   GET    /tasks/:id/board                       ?before=&limit=         snapshot do board do Swarm
//   POST   /tasks/:id/board/reset                 { revision }
//   GET    /tasks/:id/diff
//   POST   /tasks/:id/abort
//   DELETE /tasks/:id                             encerra a sandbox
//   GET    /health
//
// Auth do POC: `Authorization: Bearer <API_TOKEN>` (ou ?token= para EventSource,
// que não manda header). Owner fixo "poc-user"; troque por OIDC/JWT no lugar de `authenticate`.

import type { IncomingMessage, ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"
import type { Config } from "./config.js"
import { HARNESS_INFO, isHarness } from "./harness.js"
import { KiloError, type PermissionReply } from "./kilo.js"
import { HttpError, type Orchestrator } from "./orchestrator.js"
import type { Relay } from "./relay.js"
import { publicTask, type TaskStore } from "./store.js"
import type { Task, UiEvent } from "./types.js"

type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; user: string }
type Handler = (ctx: Ctx) => Promise<unknown> | unknown

interface Route {
  method: string
  pattern: RegExp
  keys: string[]
  handler: Handler
}

export function createRouter(deps: { cfg: Config; store: TaskStore; relay: Relay; orch: Orchestrator }) {
  const { cfg, store, relay, orch } = deps
  const routes: Route[] = []
  const add = (method: string, path: string, handler: Handler) => {
    const keys: string[] = []
    const pattern = new RegExp(
      "^" +
        path.replace(/:(\w+)/g, (_, k) => {
          keys.push(k)
          return "([^/]+)"
        }) +
        "$",
    )
    routes.push({ method, pattern, keys, handler })
  }

  const loadTask = (ctx: Ctx): Task => {
    const task = store.get(ctx.params.id!)
    if (!task || task.owner !== ctx.user) throw new HttpError(404, "tarefa não encontrada")
    return task
  }

  add("GET", "/health", () => ({ ok: true }))

  add("GET", "/harnesses", () => ({
    default: cfg.defaultHarness,
    harnesses: cfg.harnesses.map((h) => HARNESS_INFO[h]),
  }))

  add("POST", "/tasks", async (ctx) => {
    const body = await readJson(ctx.req)
    const repoUrl = String(body.repoUrl ?? "").trim()
    const prompt = String(body.prompt ?? "").trim()
    if (!/^(https:\/\/|git@)[\w.@:/~-]+$/.test(repoUrl)) throw new HttpError(400, "repoUrl inválida (https:// ou git@)")
    if (!prompt) throw new HttpError(400, "prompt obrigatório")
    const branch = body.branch ? String(body.branch) : undefined
    if (branch && !/^[\w./-]+$/.test(branch)) throw new HttpError(400, "branch inválida")
    const harness = body.harness === undefined || body.harness === "" ? cfg.defaultHarness : body.harness
    if (!isHarness(harness) || !cfg.harnesses.includes(harness))
      throw new HttpError(400, `harness inválido; habilitados: ${cfg.harnesses.join(", ")}`)
    const defaultAgent = harness === "kilo" ? cfg.squadLeadAgent : HARNESS_INFO[harness].defaultAgent
    const task = store.create(ctx.user, {
      repoUrl,
      branch,
      prompt,
      harness,
      agent: body.agent ? String(body.agent) : defaultAgent,
      model: body.model ? String(body.model) : undefined,
    })
    relay.publish(task.id, "task.status", { status: task.status })
    orch.enqueue(task)
    ctx.res.statusCode = 202
    return publicTask(task)
  })

  add("GET", "/tasks", (ctx) => store.list(ctx.user).map(publicTask))

  add("GET", "/tasks/:id", (ctx) => publicTask(loadTask(ctx)))

  add("GET", "/tasks/:id/events", (ctx) => {
    const task = loadTask(ctx)
    const { req, res } = ctx
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    })
    const send = (e: UiEvent) => res.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`)
    // Replay: o que o cliente perdeu (reconexão) ou tudo desde o início.
    const after = Number(req.headers["last-event-id"] ?? ctx.url.searchParams.get("after") ?? 0)
    res.write(`event: snapshot\ndata: ${JSON.stringify(publicTask(task))}\n\n`)
    for (const e of store.eventsSince(task.id, after)) send(e)
    const listener = (e: UiEvent) => send(e)
    relay.bus.on(`event:${task.id}`, listener)
    const ping = setInterval(() => res.write(": ping\n\n"), 15_000)
    req.on("close", () => {
      clearInterval(ping)
      relay.bus.off(`event:${task.id}`, listener)
    })
    return STREAMING
  })

  // Replay: o log inteiro de uma vez (o SSE fica aberto e não diz quando o histórico acabou).
  add("GET", "/tasks/:id/replay", (ctx) => {
    const task = loadTask(ctx)
    return { task: publicTask(task), events: store.allEvents(task.id) }
  })

  add("POST", "/tasks/:id/prompt", async (ctx) => {
    const task = loadTask(ctx)
    const body = await readJson(ctx.req)
    const text = String(body.text ?? "").trim()
    if (!text) throw new HttpError(400, "text obrigatório")
    await orch.prompt(task, text, body.agent ? String(body.agent) : undefined)
    return { ok: true }
  })

  add("POST", "/tasks/:id/permissions/:permissionID", async (ctx) => {
    const task = loadTask(ctx)
    const body = await readJson(ctx.req)
    const reply = String(body.reply ?? "") as PermissionReply
    if (!["once", "always", "reject"].includes(reply)) throw new HttpError(400, "reply deve ser once|always|reject")
    const { kilo } = orch.kilo(task)
    const ok = await kilo.replyPermission(ctx.params.permissionID!, reply, body.message ? String(body.message) : undefined)
    return { ok }
  })

  add("GET", "/tasks/:id/board", async (ctx) => {
    const task = loadTask(ctx)
    const { kilo, sessionID } = orch.kilo(task)
    const limit = ctx.url.searchParams.get("limit")
    return kilo.board(sessionID, {
      before: ctx.url.searchParams.get("before") ?? undefined,
      limit: limit ? Number(limit) : undefined,
    })
  })

  add("POST", "/tasks/:id/board/reset", async (ctx) => {
    const task = loadTask(ctx)
    const body = await readJson(ctx.req)
    const { kilo, sessionID } = orch.kilo(task)
    const board = await kilo.resetBoard(sessionID, Number(body.revision ?? 0))
    relay.publish(task.id, "board.snapshot", board)
    return board
  })

  add("GET", "/tasks/:id/diff", async (ctx) => {
    const task = loadTask(ctx)
    const { kilo, sessionID } = orch.kilo(task)
    return kilo.diff(sessionID)
  })

  add("POST", "/tasks/:id/abort", async (ctx) => {
    await orch.abort(loadTask(ctx))
    return { ok: true }
  })

  add("DELETE", "/tasks/:id", async (ctx) => {
    await orch.destroy(loadTask(ctx))
    return { ok: true }
  })

  const authenticate = (req: IncomingMessage, url: URL): string | undefined => {
    if (!cfg.apiToken) return "poc-user"
    const header = req.headers.authorization ?? ""
    const token = header.startsWith("Bearer ") ? header.slice(7) : (url.searchParams.get("token") ?? "")
    const a = Buffer.from(token)
    const b = Buffer.from(cfg.apiToken)
    return a.length === b.length && timingSafeEqual(a, b) ? "poc-user" : undefined
  }

  return async function handle(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost")
    // CORS aberto no POC para a UI rodar em outra porta; restrinja em produção.
    res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*")
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Last-Event-ID")
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
    if (req.method === "OPTIONS") return void res.writeHead(204).end()

    try {
      const route = routes.find((r) => r.method === req.method && r.pattern.test(url.pathname))
      if (!route) throw new HttpError(404, "rota não encontrada")
      const user = url.pathname === "/health" ? "anon" : authenticate(req, url)
      if (!user) throw new HttpError(401, "não autorizado")
      const match = route.pattern.exec(url.pathname)!
      const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(match[i + 1]!)]))
      const result = await route.handler({ req, res, url, params, user })
      if (result === STREAMING) return
      json(res, res.statusCode || 200, result ?? { ok: true })
    } catch (err) {
      if (res.headersSent) return void res.end()
      if (err instanceof HttpError) return json(res, err.status, { error: err.message })
      if (err instanceof KiloError) return json(res, err.status >= 500 ? 502 : err.status, { error: err.message })
      console.error(err)
      json(res, 500, { error: "erro interno" })
    }
  }
}

const STREAMING = Symbol("streaming")

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body))
}

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > 256 * 1024) throw new HttpError(413, "payload grande demais")
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"))
  } catch {
    throw new HttpError(400, "JSON inválido")
  }
}
