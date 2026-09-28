// Smoke test ponta a ponta contra o orquestrador já rodando (driver external + mock, ou docker real).
// Cria uma tarefa, segue o SSE, aprova a primeira permissão e espera a sessão ficar idle.
// Uso: ORCH_URL=http://127.0.0.1:8080 API_TOKEN=... REPO_URL=https://github.com/octocat/Hello-World npx tsx scripts/smoke.ts
// HARNESS=kilo|claude-code|codex|aic escolhe o harness (padrão: o do orquestrador).

import { parseSse } from "../src/kilo.js"

const base = process.env.ORCH_URL ?? "http://127.0.0.1:8080"
const token = process.env.API_TOKEN ?? ""
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
const timeoutMs = Number(process.env.SMOKE_TIMEOUT_MS ?? 60_000)

const created = await fetch(`${base}/tasks`, {
  method: "POST",
  headers,
  body: JSON.stringify({
    repoUrl: process.env.REPO_URL ?? "https://github.com/octocat/Hello-World",
    branch: process.env.REPO_BRANCH ?? "master",
    prompt: process.env.PROMPT ?? "Adicione uma seção 'Como rodar' ao README",
    harness: process.env.HARNESS || undefined,
  }),
})
const task = await created.json()
console.log("POST /tasks ->", created.status, task.id, task.status, task.harness ?? "", task.error ?? "")
if (created.status !== 202) process.exit(1)

const seen = new Set<string>()
const abort = new AbortController()
const timer = setTimeout(() => abort.abort(), timeoutMs)
let result = "timeout"

try {
  const res = await fetch(`${base}/tasks/${task.id}/events`, { headers, signal: abort.signal })
  for await (const data of parseSse(res.body!)) {
    const e = JSON.parse(data)
    if (!e.kind) continue // snapshot inicial
    seen.add(e.kind)
    console.log(`#${e.seq} ${e.kind}`, JSON.stringify(e.data).slice(0, 140))
    if (e.kind === "permission.asked") {
      const r = await fetch(`${base}/tasks/${task.id}/permissions/${e.data.id}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ reply: "once" }),
      })
      console.log("  -> aprovado", r.status, await r.text())
    }
    if (e.kind === "task.status" && (e.data.status === "idle" || e.data.status === "error")) {
      result = e.data.status
      break
    }
  }
} catch (err) {
  if (!abort.signal.aborted) throw err
}
clearTimeout(timer)
abort.abort()

const board = await fetch(`${base}/tasks/${task.id}/board`, { headers })
console.log("GET board ->", board.status, (await board.text()).slice(0, 200))
const finalTask = await (await fetch(`${base}/tasks/${task.id}`, { headers })).json()
console.log("membros da squad:", Object.values(finalTask.members).map((m: any) => `${m.agent}:${m.status}`))
console.log("tipos de evento vistos:", [...seen].sort().join(", "))

if (process.env.SMOKE_KEEP !== "1") await fetch(`${base}/tasks/${task.id}`, { method: "DELETE", headers })
console.log("resultado:", result)
process.exit(result === "idle" ? 0 : 1)
