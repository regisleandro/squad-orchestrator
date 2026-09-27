import assert from "node:assert/strict"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { Relay } from "../src/relay"
import { TaskStore } from "../src/store"
import { replayStart, replayStep } from "../web/src/useTaskStream"
import { describeFailure } from "../web/src/taskFailure"
import { buildSquad } from "../web/src/squad"
import { TaskFailure } from "../web/src/components/TaskFailure"

const message = "This request requires more credits, or fewer max_tokens. You requested up to 32000 tokens, but can only afford 8333. Visit https://openrouter.ai/settings/credits"
const store = new TaskStore()
const task = store.create("test", { repoUrl: "https://example.com/repo", prompt: "Faça o pedido", agent: "squad-lead", harness: "kilo" })
store.update(task.id, { sessionID: "root", status: "running" })
const relay = new Relay(store)
relay.publish(task.id, "raw", { type: "session.bound", sessionID: "root" })
// Usa o mesmo mapeamento que recebe os eventos do SSE, sem chamar LLM ou Docker.
const handle = (type: string, properties: object) => (relay as any).handle(task.id, { type, properties })
handle("session.error", { sessionID: "child", error: { data: { message: "erro de um membro" } } })
assert.equal(task.status, "running")
handle("session.error", { sessionID: "root", error: { data: { message } } })
handle("session.status", { sessionID: "root", status: { type: "idle" } })
handle("session.idle", { sessionID: "root" })
assert.equal(task.status, "error")
assert.equal(task.error, message)

let state = replayStart(task)
for (const event of store.allEvents(task.id)) state = replayStep(state, event)
assert.equal(state.task?.status, "error")
assert.equal(state.task?.error, message)
assert.equal(buildSquad(state).nodes[0]?.state, "error")
// Replays antigos registravam idle após o erro: a interface corrige esse histórico.
state = replayStep(state, { seq: state.lastSeq + 1, taskID: task.id, at: Date.now(), kind: "task.status", data: { status: "idle" } })
assert.equal(state.task?.status, "error")

handle("session.status", { sessionID: "root", status: { type: "busy" } })
assert.equal(task.status, "running")
assert.equal(task.error, undefined)
const resumed = store.allEvents(task.id).slice(-2)
for (const event of resumed) state = replayStep(state, event)
assert.equal(state.task?.status, "running")
assert.equal(state.task?.error, undefined)
handle("session.idle", { sessionID: "root" })
assert.equal(task.status, "idle")
store.update(task.id, { status: "stopped" })
handle("session.idle", { sessionID: "root" })
assert.equal(task.status, "stopped")
let stopped = { ...state, task: { ...state.task!, status: "stopped" as const } }
for (const event of store.allEvents(task.id)) stopped = replayStep(stopped, { ...event, seq: stopped.lastSeq + 1 })
assert.equal(stopped.task?.status, "stopped")

const explanation = describeFailure(message)
assert.equal(explanation.title, "Créditos insuficientes para iniciar o turno")
assert.match(explanation.description, /32\.000.*8\.333/)
assert.equal(explanation.link?.href, "https://openrouter.ai/settings/credits")
assert.equal(describeFailure("insufficient balance").link, undefined)
assert.match(describeFailure("unable to get local issuer certificate").title, /conexão segura/)
assert.match(describeFailure("401 invalid API key").title, /credencial/)
assert.match(describeFailure("429 too many requests").title, /Limite/)
const html = renderToStaticMarkup(createElement(TaskFailure, { taskID: task.id, message, canResume: true }))
assert.match(html, /role="alert"/)
assert.match(html, /Retomar após corrigir/)
assert.match(html, /Detalhes técnicos/)
const replayHtml = renderToStaticMarkup(createElement(TaskFailure, { taskID: task.id, message }))
assert.doesNotMatch(replayHtml, /Retomar após corrigir/)
console.log("PASS: falha preservada, erro de subagente, replay antigo, retomada, conclusão, tarefa encerrada e mensagens de recuperação")
