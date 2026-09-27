// Mock mínimo do `kilo serve` para testar o orquestrador sem Docker nem LLM.
// Implementa só as rotas que o orquestrador usa, com os mesmos formatos de evento.
// Uso: KILO_SERVER_PASSWORD=x PORT=4096 npx tsx scripts/mock-kilo.ts

import { createServer, type ServerResponse } from "node:http"

const PORT = Number(process.env.PORT ?? 4096)
const PASSWORD = process.env.KILO_SERVER_PASSWORD ?? ""
const clients = new Set<ServerResponse>()
const board: any[] = []
let revision = 0
let seq = 0
const BOOT_MS = Number(process.env.MOCK_BOOT_MS ?? 0)
const BOOTED_AT = Date.now()
const pending = new Map<string, { sessionID: string; resume: () => void }>()

const emit = (type: string, properties: Record<string, unknown>) => {
  const data = JSON.stringify({ id: `evt_${++seq}`, type, properties })
  for (const c of clients) c.write(`data: ${data}\n\n`)
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const json = (res: ServerResponse, status: number, body: unknown) =>
  res.writeHead(status, { "Content-Type": "application/json" }).end(body === undefined ? "" : JSON.stringify(body))

// Velocidade da simulação (MOCK_SPEED=0.1 deixa 10x mais rápido; o smoke usa isso).
const SPEED = Number(process.env.MOCK_SPEED ?? 1)
const wait = (ms: number) => sleep(ms * SPEED)
let partSeq = 0

function textPart(sessionID: string, messageID: string, agent: string, role: "user" | "assistant", text: string) {
  emit("message.updated", { sessionID, info: { id: messageID, sessionID, role, agent } })
  const id = `prt_${++partSeq}`
  emit("message.part.updated", { sessionID, part: { id, messageID, sessionID, type: "text", text }, time: Date.now() })
  return id
}

async function streamText(sessionID: string, agent: string, text: string) {
  const messageID = `msg_${++partSeq}`
  const id = textPart(sessionID, messageID, agent, "assistant", "")
  for (const word of text.split(/(?<= )/)) {
    emit("message.part.delta", { sessionID, messageID, partID: id, field: "text", delta: word })
    await wait(40)
  }
}

function toolPart(sessionID: string, callID: string, tool: string, status: string, input: Record<string, unknown>, metadata?: Record<string, unknown>) {
  emit("message.part.updated", {
    sessionID,
    part: { id: `prt_${callID}`, sessionID, type: "tool", tool, callID, state: { status, input, metadata, title: input.description } },
    time: Date.now(),
  })
}

async function post(from: string, fromLabel: string, to: string, type: string, body: string) {
  toolPart(from, `bp_${board.length}`, "board_post", "running", { to, type })
  await wait(300)
  board.push({ id: `brd_${board.length + 1}`, timestamp: Date.now(), from, to, fromLabel, toLabel: to === "main" ? "squad-lead" : to, type, body })
  toolPart(from, `bp_${board.length - 1}`, "board_post", "completed", { to, type })
}

function member(root: string, agent: string, description: string, status: string, round = 1) {
  const suffix = round > 1 ? `_${round}` : ""
  const child = `ses_${agent}${suffix}`
  toolPart(root, `call_${agent}${suffix}`, "task", status, { subagent_type: agent, description }, { sessionId: child, parentSessionId: root })
  return child
}

async function askPermission(sessionID: string, command: string) {
  const permID = `per_${++partSeq}`
  await new Promise<void>((resume) => {
    pending.set(permID, { sessionID, resume })
    emit("permission.asked", { id: permID, sessionID, permission: "bash", patterns: [command], metadata: { command }, always: [command.split(" ")[0] + " *"] })
  })
}

async function runSquad(sessionID: string, text: string, first: boolean) {
  emit("session.status", { sessionID, status: { type: "busy" } })
  // MOCK_RETRY=n simula n falhas na chamada ao modelo antes de seguir (loop "tentando de novo")
  for (let i = 1; i <= Number(process.env.MOCK_RETRY ?? 0); i++) {
    emit("session.status", { sessionID, status: { type: "retry", attempt: i, message: "Rate limit reached for gpt-x (mock)", next: Date.now() + 2000 } })
    await wait(1500)
  }
  emit("session.status", { sessionID, status: { type: "busy" } })
  textPart(sessionID, `msg_u${++partSeq}`, "squad-lead", "user", text)
  await wait(400)
  if (!first) {
    await streamText(sessionID, "squad-lead", `Entendido. Vou considerar isso: "${text}".`)
    emit("session.status", { sessionID, status: { type: "idle" } })
    return
  }
  await streamText(sessionID, "squad-lead", "Explorei o repo. Plano: o architect desenha a mudança, o developer implementa, qa escreve os testes e o reviewer revisa o diff.")
  await post(sessionID, "squad-lead", "ALL", "INFO", "Plano: 1) desenho 2) implementação 3) testes 4) revisão. Postem ASK se travarem.")

  const arch = member(sessionID, "architect", "Desenhar a paginação do endpoint /orders", "running")
  await streamText(arch, "architect", "Li o roteador e a camada de dados. Proposta: cursor opaco com limit padrão 20.")
  toolPart(arch, "a1", "read", "completed", { filePath: "src/routes/orders.ts" })
  await wait(1200)
  await post(arch, "architect", "main", "RESULT", "Usar cursor opaco (base64 do id). Alterar src/routes/orders.ts e src/db/orders.ts; manter limit padrão 20.")
  member(sessionID, "architect", "Desenhar a paginação do endpoint /orders", "completed")

  const dev = member(sessionID, "developer", "Implementar paginação por cursor", "running")
  const qa = member(sessionID, "qa", "Escrever testes de paginação", "running")
  await streamText(dev, "developer", "Implementando o middleware de paginação a partir do desenho do architect.")
  toolPart(dev, "d1", "edit", "completed", { filePath: "src/routes/orders.ts" })
  await wait(800)
  await post(dev, "developer", "main", "ASK", "O cursor deve expirar? Vou assumir que não.")
  await wait(600)
  await post(sessionID, "squad-lead", dev, "INFO", "Não expira. Siga.")
  await streamText(qa, "qa", "Escrevendo testes para página vazia, cursor inválido e limite máximo.")
  toolPart(qa, "q1", "write", "completed", { filePath: "test/orders.pagination.test.ts" })
  await askPermission(qa, "npm install --save-dev supertest")
  await wait(600)
  await post(qa, "qa", "main", "HOLD", "2 testes falhando: cursor inválido retorna 500 em vez de 400.")
  await wait(900)
  toolPart(dev, "d2", "edit", "completed", { filePath: "src/routes/orders.ts" })
  await post(dev, "developer", "main", "RESULT", "Paginação implementada; cursor inválido agora retorna 400.")
  member(sessionID, "developer", "Implementar paginação por cursor", "completed")
  await post(qa, "qa", "main", "RESULT", "npm test: 42 passando, 0 falhando.")
  member(sessionID, "qa", "Escrever testes de paginação", "completed")

  const rev = member(sessionID, "reviewer", "Revisar o diff da paginação", "running")
  await streamText(rev, "reviewer", "Revisando o diff com foco em SQL e casos de borda.")
  await wait(1000)
  await post(rev, "reviewer", "main", "VETO", "src/db/orders.ts:41 monta SQL com concatenação do cursor. Use parâmetro.")
  await wait(500)
  // segunda rodada do mesmo agente: na UI reaproveita o nó do developer (×2)
  const dev2 = member(sessionID, "developer", "Trocar concatenação por parâmetro no SQL", "running", 2)
  await streamText(dev2, "developer", "Trocando a concatenação por query parametrizada.")
  toolPart(dev2, "d3", "edit", "completed", { filePath: "src/db/orders.ts" })
  await post(dev2, "developer", "main", "RESULT", "SQL parametrizado em src/db/orders.ts:41.")
  member(sessionID, "developer", "Trocar concatenação por parâmetro no SQL", "completed", 2)
  await wait(500)
  await post(rev, "reviewer", "main", "RESULT", "Corrigido pelo developer. Aprovado.")
  member(sessionID, "reviewer", "Revisar o diff da paginação", "completed")

  emit("session.diff", { sessionID, diff: DIFF })
  await streamText(sessionID, "squad-lead", "Pronto. Paginação por cursor em /orders, testes passando e revisão aprovada. Commit feito na branch da tarefa.")
  emit("session.status", { sessionID, status: { type: "idle" } })
  emit("session.idle", { sessionID })
}

const DIFF = [
  { file: "src/routes/orders.ts", additions: 24, deletions: 3, status: "modified", patch: "@@ -10,6 +10,27 @@\n-router.get('/orders', list)\n+router.get('/orders', paginate(list))" },
  { file: "src/db/orders.ts", additions: 11, deletions: 2, status: "modified", patch: "@@ -38,4 +38,13 @@\n+  where: cursor ? { id: { gt: decode(cursor) } } : undefined," },
  { file: "test/orders.pagination.test.ts", additions: 58, deletions: 0, status: "added", patch: "+describe('GET /orders pagination', () => {" },
]
const started = new Set<string>()

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://x")
  if (PASSWORD) {
    const expected = "Basic " + Buffer.from(`kilo:${PASSWORD}`).toString("base64")
    if (req.headers.authorization !== expected) return json(res, 401, { error: "unauthorized" })
  }
  let body: any = {}
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c)
  if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString())
  const p = url.pathname
  let m: RegExpMatchArray | null

  // MOCK_BOOT_MS simula o tempo de clone + boot do kilo serve dentro do container
  if (p === "/global/health")
    return Date.now() - BOOTED_AT < BOOT_MS ? json(res, 503, { error: "booting" }) : json(res, 200, { healthy: true, version: "mock-0.0.0" })
  if (p === "/event") {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.write(`data: ${JSON.stringify({ id: "evt_0", type: "server.connected", properties: {} })}\n\n`)
    clients.add(res)
    req.on("close", () => clients.delete(res))
    return
  }
  if (p === "/session" && req.method === "POST") {
    const id = "ses_root_" + Date.now()
    emit("session.created", { sessionID: id })
    return json(res, 200, { id, title: body.title })
  }
  if ((m = p.match(/^\/session\/([^/]+)\/prompt_async$/))) {
    const first = !started.has(m[1]!)
    started.add(m[1]!)
    void runSquad(m[1]!, body.parts?.[0]?.text ?? "", first)
    return res.writeHead(204).end()
  }
  if ((m = p.match(/^\/permission\/([^/]+)\/reply$/))) {
    const entry = pending.get(m[1]!)
    if (!entry) return json(res, 404, { error: "not found" })
    pending.delete(m[1]!)
    emit("permission.replied", { sessionID: entry.sessionID, requestID: m[1], reply: body.reply })
    entry.resume()
    return json(res, 200, true)
  }
  if ((m = p.match(/^\/kilocode\/session\/([^/]+)\/board$/))) {
    return json(res, 200, { ownerSessionID: m[1], revision, messages: board, hasMore: false })
  }
  if ((m = p.match(/^\/kilocode\/session\/([^/]+)\/board\/reset$/))) {
    board.length = 0
    revision++
    return json(res, 200, { ownerSessionID: m[1], revision, messages: [], hasMore: false })
  }
  if ((m = p.match(/^\/session\/([^/]+)\/diff$/))) return json(res, 200, DIFF)
  if ((m = p.match(/^\/session\/([^/]+)\/abort$/))) return json(res, 200, true)
  json(res, 404, { error: `mock: ${req.method} ${p}` })
}).listen(PORT, () => console.log(`mock kilo serve em :${PORT}`))
