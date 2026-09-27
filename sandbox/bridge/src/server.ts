// Ponte de harness: roda dentro da sandbox no lugar do `kilo serve` quando a tarefa pede
// Claude Code ou Codex, e responde o mesmo subconjunto HTTP/SSE que o orquestrador usa
// (ver src/kilo.ts do orquestrador). Assim o orquestrador, o relay e a UI não mudam de
// protocolo; só a tabela de capacidades por harness diz o que degrada.
//
//   GET  /global/health                       POST /session
//   GET  /event (SSE)                         POST /session/:id/prompt_async
//   GET  /session/status                      POST /session/:id/abort
//   GET  /session/:id/diff                    GET  /permission
//   POST /permission/:id/reply                GET  /kilocode/session/:id/board
//   POST /kilocode/session/:id/board/reset
//
// Env: HARNESS=claude-code|codex, KILO_SERVER_PASSWORD, REPO_DIR, SQUAD_DIR, PORT (4096),
// BRIDGE_FAKE=1 troca os SDKs por roteiros gravados (demo e testes sem LLM).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { ClaudeRunner } from "./claude.ts"
import { CodexRunner } from "./codex.ts"
import { GitDiff } from "./diff.ts"
import { Hub, newID, type PermissionReply } from "./hub.ts"
import type { Runner, RunnerContext } from "./runner.ts"
import { Policy, loadSquad } from "./squad.ts"

const HARNESS = process.env.HARNESS ?? "claude-code"
const PORT = Number(process.env.PORT ?? 4096)
const PASSWORD = process.env.KILO_SERVER_PASSWORD ?? ""
const USERNAME = process.env.KILO_SERVER_USERNAME ?? "kilo"
const REPO_DIR = process.env.REPO_DIR ?? process.cwd()
const SQUAD_DIR = process.env.SQUAD_DIR ?? process.env.KILO_CONFIG_DIR ?? "/opt/squad"
const VERSION = `bridge-0.1.0 (${HARNESS})`

if (HARNESS !== "claude-code" && HARNESS !== "codex") {
  console.error(`[bridge] HARNESS inválido: ${HARNESS} (use claude-code ou codex)`)
  process.exit(1)
}

const hub = new Hub()
const squad = loadSquad(SQUAD_DIR)
const policy = Policy.fromKiloConfig(SQUAD_DIR)
const diff = new GitDiff(REPO_DIR)
await diff.init()
const sessions = new Map<string, Runner>()
const fakes = process.env.BRIDGE_FAKE === "1" ? await import("./fakes.ts") : undefined

function createRunner(ctx: RunnerContext): Runner {
  if (HARNESS === "codex") return new CodexRunner(ctx, fakes?.fakeCodex)
  return new ClaudeRunner(ctx, fakes?.fakeClaudeQuery)
}

const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body))

async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8"))
}

/** Aceita o formato do Kilo ({ providerID, modelID }) ou uma string. */
function modelOf(model: unknown): string | undefined {
  if (!model) return undefined
  if (typeof model === "string") return model.includes("/") ? model.slice(model.indexOf("/") + 1) : model
  const m = model as { modelID?: string }
  return m.modelID || undefined
}

const expectedAuth = "Basic " + Buffer.from(`${USERNAME}:${PASSWORD}`).toString("base64")

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://bridge")
  const p = url.pathname
  if (PASSWORD && req.headers.authorization !== expectedAuth) return json(res, 401, { error: "unauthorized" })
  let m: RegExpMatchArray | null
  try {
    if (p === "/global/health") return json(res, 200, { healthy: true, version: VERSION })

    if (p === "/event") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" })
      res.write(`data: ${JSON.stringify({ type: "server.connected", properties: {} })}\n\n`)
      hub.clients.add(res)
      const ping = setInterval(() => res.write(`data: ${JSON.stringify({ type: "server.heartbeat", properties: {} })}\n\n`), 10_000)
      req.on("close", () => {
        clearInterval(ping)
        hub.clients.delete(res)
      })
      return
    }

    if (p === "/session" && req.method === "POST") {
      const body = await readJson(req)
      const id = newID("ses")
      const agent = String(body.agent ?? "squad-lead")
      sessions.set(id, createRunner({ hub, sessionID: id, agent, repoDir: REPO_DIR, squad, policy, diff }))
      hub.emit("session.created", { sessionID: id, info: { id, title: body.title, agent } })
      return json(res, 200, { id, title: body.title, agent })
    }

    if (p === "/session/status") return json(res, 200, hub.sessionStatus)

    if ((m = p.match(/^\/session\/([^/]+)\/prompt_async$/)) && req.method === "POST") {
      const runner = sessions.get(m[1]!)
      if (!runner) return json(res, 404, { error: "sessão não encontrada" })
      const body = await readJson(req)
      const text = (body.parts ?? []).map((part: any) => part.text ?? "").join("\n").trim()
      if (!text) return json(res, 400, { error: "prompt vazio" })
      runner.prompt({ text, agent: body.agent, model: modelOf(body.model) })
      return res.writeHead(204).end()
    }

    if ((m = p.match(/^\/session\/([^/]+)\/abort$/)) && req.method === "POST") {
      await sessions.get(m[1]!)?.abort()
      return json(res, 200, true)
    }

    if ((m = p.match(/^\/session\/([^/]+)\/diff$/))) return json(res, 200, await diff.compute())

    if (p === "/permission") return json(res, 200, hub.pendingPermissions())

    if ((m = p.match(/^\/permission\/([^/]+)\/reply$/)) && req.method === "POST") {
      const body = await readJson(req)
      const reply = String(body.reply) as PermissionReply
      if (!["once", "always", "reject"].includes(reply)) return json(res, 400, { error: "reply inválido" })
      return hub.reply(m[1]!, reply) ? json(res, 200, true) : json(res, 404, { error: "pedido não encontrado" })
    }

    if ((m = p.match(/^\/kilocode\/session\/([^/]+)\/board$/))) {
      const limit = url.searchParams.get("limit")
      return json(res, 200, hub.boardSnapshot(m[1]!, { before: url.searchParams.get("before") ?? undefined, limit: limit ? Number(limit) : undefined }))
    }

    if ((m = p.match(/^\/kilocode\/session\/([^/]+)\/board\/reset$/)) && req.method === "POST") {
      const body = await readJson(req)
      return json(res, 200, hub.resetBoard(m[1]!, Number(body.revision ?? 0)))
    }

    json(res, 404, { error: `bridge: ${req.method} ${p}` })
  } catch (err) {
    console.error("[bridge]", err)
    if (!res.headersSent) json(res, 500, { error: err instanceof Error ? err.message : String(err) })
  }
})

server.listen(PORT, "0.0.0.0", () => console.log(`[bridge] ${VERSION} em :${PORT}, repo ${REPO_DIR}, squad ${Object.keys(squad).join(", ") || "(vazia)"}`))

for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(signal, () => {
    for (const r of sessions.values()) r.close()
    process.exit(0)
  })
