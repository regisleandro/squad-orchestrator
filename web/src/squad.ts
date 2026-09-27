// Modelo da squad para o grafo e o painel: um nó por agente.
// O líder pode delegar várias vezes ao mesmo agente (ex.: developer de novo depois de um VETO);
// cada delegação cria uma sessão filha nova no Kilo, mas na tela todas viram o mesmo nó,
// que guarda as rodadas (sessões) em `members`/`sessions`.

import type { BoardMessage, SquadMember } from "./api"
import type { TaskState } from "./useTaskStream"

export interface AgentNode {
  id: string // sessionID raiz para o líder, "agent:<nome>" para os demais
  agent: string
  parentId?: string
  depth: number
  sessions: string[]
  members: SquadMember[] // rodadas, da mais antiga para a mais nova
  state: string // running | waiting | completed | error | pending | busy | idle | retry
}

export interface SquadModel {
  root?: string
  nodes: AgentNode[]
  byId: Map<string, AgentNode>
  /** sessionID (ou "main", ou nome do agente) → id do nó */
  resolve: (id: string) => string | undefined
}

export function buildSquad(state: TaskState): SquadModel {
  const root = state.task?.sessionID
  const byId = new Map<string, AgentNode>()
  const bySession = new Map<string, string>()
  const byAgent = new Map<string, string>()
  const resolve = (id: string) => {
    if (!root) return undefined
    if (id === "main" || id === root) return root
    return bySession.get(id) ?? byAgent.get(id)
  }
  if (!root) return { root, nodes: [], byId, resolve }

  const waiting = new Set(Object.values(state.permissions).map((p) => p.sessionID))
  const lead: AgentNode = {
    id: root,
    agent: state.task?.agent ?? "líder",
    depth: 0,
    sessions: [root],
    members: [],
    state: state.task?.status === "stopped" ? "stopped" : state.task?.status === "error" ? "error" : waiting.has(root) ? "waiting" : (state.sessionState[root] ?? "busy"),
  }
  byId.set(root, lead)
  bySession.set(root, root)

  const members = Object.values(state.members).sort((a, b) => a.startedAt - b.startedAt)
  // Resolve o pai de cada rodada; repete porque um neto pode chegar antes do filho no stream.
  const pending = members.filter((m) => m.sessionID)
  for (let guard = 0; pending.length && guard < 10; guard++) {
    for (let i = 0; i < pending.length; ) {
      const m = pending[i]!
      const parentId = resolve(m.parentSessionID ?? root)
      if (!parentId) {
        i++
        continue
      }
      pending.splice(i, 1)
      const id = `agent:${m.agent}`
      let node = byId.get(id)
      if (!node) {
        node = { id, agent: m.agent, parentId, depth: byId.get(parentId)!.depth + 1, sessions: [], members: [], state: "pending" }
        byId.set(id, node)
        byAgent.set(m.agent, id)
      }
      node.sessions.push(m.sessionID!)
      node.members.push(m)
      bySession.set(m.sessionID!, id)
    }
  }

  // Estado do nó: esperando você > trabalhando > estado da rodada mais recente.
  for (const node of byId.values()) {
    if (node.id === root) continue
    const latest = node.members[node.members.length - 1]!
    node.state = node.sessions.some((s) => waiting.has(s))
      ? "waiting"
      : node.members.some((m) => m.status === "running")
        ? "running"
        : latest.status
  }

  return { root, nodes: [...byId.values()], byId, resolve }
}

export function agentOfSession(state: TaskState, sessionID: string) {
  if (sessionID === state.task?.sessionID) return state.task?.agent ?? "líder"
  return Object.values(state.members).find((m) => m.sessionID === sessionID)?.agent ?? "membro"
}

export function boardLabel(state: TaskState, id: string, label?: string) {
  if (id === "main" || id === state.task?.sessionID) return state.task?.agent ?? "líder"
  if (id === "ALL") return "todos"
  const agent = Object.values(state.members).find((m) => m.sessionID === id)?.agent
  return agent ?? (label && label !== id ? label : id.slice(0, 12))
}

export const STATE_LABEL: Record<string, string> = {
  running: "trabalhando",
  busy: "trabalhando",
  waiting: "aguardando você",
  completed: "entregou",
  error: "falhou",
  pending: "na fila",
  idle: "ocioso",
  retry: "tentando de novo",
  stopped: "encerrado",
}

/** Mensagem que ainda pede atenção: ASK/HOLD/VETO sem resposta posterior do destinatário nem nova mensagem do remetente. */
export function openAlert(state: TaskState, model: SquadModel): BoardMessage | undefined {
  const msgs = [...state.board].sort((a, b) => a.timestamp - b.timestamp)
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (!["ASK", "HOLD", "VETO"].includes(m.type)) continue
    const from = model.resolve(m.from)
    const to = m.to === "ALL" ? undefined : model.resolve(m.to)
    const answered = msgs.slice(i + 1).some((n) => {
      const nf = model.resolve(n.from)
      return nf === from || (to !== undefined && nf === to)
    })
    return answered ? undefined : m
  }
  return undefined
}

// Cor de identidade por agente (tema Arena). Só identifica quem é; estado usa âmbar/coral.
const AGENT_COLORS: Record<string, string> = {
  "squad-lead": "#e6e6e6",
  orchestrator: "#e6e6e6",
  code: "#e6e6e6",
  claude: "#e6e6e6",
  codex: "#e6e6e6",
  architect: "#8052ff",
  developer: "#63a1ff",
  qa: "#59d499",
  reviewer: "#f2a0ff",
}
const EXTRA = ["#56c2ff", "#c4b5fd", "#7ee0c3", "#ffa3a3", "#ffd28a", "#a3e635"]

export function agentColor(agent: string | undefined, isLead = false) {
  if (isLead || !agent) return "#e6e6e6"
  if (AGENT_COLORS[agent]) return AGENT_COLORS[agent]
  let h = 0
  for (const c of agent) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return EXTRA[h % EXTRA.length]!
}
