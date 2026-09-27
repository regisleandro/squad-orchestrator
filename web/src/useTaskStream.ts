// Estado da tela da tarefa, reconstruído a partir do SSE do orquestrador.
// EventSource reconecta sozinho mandando Last-Event-ID; o orquestrador faz replay do que faltou.

import { useEffect, useReducer } from "react"
import { eventsUrl, type BoardMessage, type PermissionRequest, type SquadMember, type Task, type UiEvent } from "./api"

export interface ChatPart {
  id: string
  messageID?: string
  sessionID: string
  type: string // text | reasoning | tool | ...
  text: string
  tool?: string
  toolStatus?: string
  toolTitle?: string
  at?: number // quando a parte apareceu pela primeira vez
}

export interface MessageInfo {
  id: string
  sessionID: string
  role: "user" | "assistant"
  agent?: string
}

export interface ActivityLine {
  at: number
  text: string
}

export interface TaskState {
  task?: Task
  connected: boolean
  lastSeq: number
  messages: Record<string, MessageInfo>
  partOrder: string[]
  parts: Record<string, ChatPart>
  members: Record<string, SquadMember>
  permissions: Record<string, PermissionRequest>
  board: BoardMessage[]
  boardRevision: number
  boardLive: { sessionID: string; tool: string; at: number } | null
  activity: Record<string, ActivityLine> // última atividade por sessão (para os cards da squad)
  sessionState: Record<string, string> // busy | idle | retry
  retry: Record<string, { attempt?: number; message?: string; next?: number; at: number }> // por sessão, enquanto em retry
  diffCount: number
  errors: { at: number; message: string; logs?: string }[]
}

const initial: TaskState = {
  connected: false,
  lastSeq: 0,
  messages: {},
  partOrder: [],
  parts: {},
  members: {},
  permissions: {},
  board: [],
  boardRevision: 0,
  boardLive: null,
  activity: {},
  sessionState: {},
  retry: {},
  diffCount: 0,
  errors: [],
}

type Action =
  | { type: "reset" }
  | { type: "connected"; value: boolean }
  | { type: "snapshot"; task: Task }
  | { type: "event"; event: UiEvent }
  | { type: "board"; messages: BoardMessage[]; revision: number }

function reduce(state: TaskState, action: Action): TaskState {
  switch (action.type) {
    case "reset":
      return initial
    case "connected":
      return { ...state, connected: action.value }
    case "snapshot":
      return {
        ...state,
        task: action.task,
        members: { ...action.task.members, ...state.members },
        permissions: action.task.pendingPermissions,
      }
    case "board":
      return { ...state, board: action.messages, boardRevision: action.revision }
    case "event":
      if (action.event.seq <= state.lastSeq) return state
      return { ...applyEvent(state, action.event), lastSeq: action.event.seq }
  }
}

/** Estado inicial do replay: a tarefa como estava antes do primeiro evento. */
export function replayStart(task: Task): TaskState {
  return {
    ...initial,
    connected: true,
    task: { ...task, status: "queued", error: undefined, publication: undefined, sessionID: undefined, members: {}, pendingPermissions: {} },
  }
}

/** Aplica um evento do log (o mesmo reducer do SSE ao vivo). */
export function replayStep(state: TaskState, event: UiEvent): TaskState {
  return reduce(state, { type: "event", event })
}

function applyEvent(s: TaskState, e: UiEvent): TaskState {
  const d = e.data ?? {}
  switch (e.kind) {
    case "task.publication":
      return s.task ? { ...s, task: { ...s.task, publication: d } } : s
    case "task.status":
      if (!s.task) return s
      // Um snapshot encerrado é autoritativo, mesmo ao receber eventos antigos.
      if (s.task.status === "stopped") return s
      // Logs antigos encerravam turnos que falharam com idle. Preserva a falha.
      if (d.status === "idle" && s.task.status === "error") return s
      return { ...s, task: { ...s.task, status: d.status, error: d.status === "running" ? undefined : d.error ?? s.task.error } }

    case "message": {
      if (d.info) {
        const info = d.info
        return { ...s, messages: { ...s.messages, [info.id]: { id: info.id, sessionID: info.sessionID, role: info.role, agent: info.agent } } }
      }
      if (d.part) return upsertPart(s, d.part, e.at)
      return s
    }

    case "message.delta": {
      const part = s.parts[d.partID]
      if (!part || d.field !== "text") return s
      const next = { ...part, text: part.text + d.delta }
      return {
        ...s,
        parts: { ...s.parts, [d.partID]: next },
        activity: { ...s.activity, [part.sessionID]: { at: e.at, text: lastLine(next.text) } },
      }
    }

    case "tool":
      return d.part ? upsertPart(s, d.part, e.at) : s

    case "squad.member":
      return { ...s, members: { ...s.members, [d.callID]: d } }

    case "board.activity":
      return {
        ...s,
        boardLive: { sessionID: d.sessionID, tool: d.tool, at: e.at },
        activity: {
          ...s.activity,
          [d.sessionID]: { at: e.at, text: d.tool === "board_post" ? `postou no board (${d.input?.type ?? "INFO"})` : "leu o board" },
        },
      }

    case "board.snapshot":
      return { ...s, board: d.messages ?? [], boardRevision: d.revision ?? 0 }

    case "permission.asked":
      return { ...s, permissions: { ...s.permissions, [d.id]: d } }

    case "permission.replied": {
      const { [d.requestID]: _, ...rest } = s.permissions
      return { ...s, permissions: rest }
    }

    case "session.status": {
      const type = d.status?.type ?? "idle"
      const { [d.sessionID]: _, ...others } = s.retry
      // retry = o Kilo falhou ao chamar o modelo e vai tentar de novo; a mensagem diz por quê
      const retry = type === "retry" ? { ...others, [d.sessionID]: { attempt: d.status.attempt, message: d.status.message, next: d.status.next, at: e.at } } : others
      const root = d.sessionID === s.task?.sessionID
      const failed = root && s.task?.status === "error" && type === "idle"
      return {
        ...s,
        task: root && type === "busy" && s.task?.status !== "stopped" ? { ...s.task!, status: "running", error: undefined } : s.task,
        sessionState: { ...s.sessionState, [d.sessionID]: failed ? "error" : type },
        retry,
      }
    }

    case "session.diff":
      return { ...s, diffCount: Array.isArray(d.diff) ? d.diff.length : s.diffCount }

    case "error": {
      const message = d.message ?? d.error?.data?.message ?? d.error?.name ?? "erro"
      const root = d.sessionID && d.sessionID === s.task?.sessionID
      return {
        ...s,
        task: root ? { ...s.task!, status: s.task!.status === "stopped" ? "stopped" : "error", error: message } : s.task,
        sessionState: root ? { ...s.sessionState, [d.sessionID]: "error" } : s.sessionState,
        errors: [...s.errors.slice(-9), { at: e.at, message, logs: d.logs }],
      }
    }

    case "raw":
      // O Kilo remove mensagens temporárias como "Initializing snapshot…".
      // Também trata logs antigos, que já persistiram essa remoção como raw.
      if (d.type === "message.part.removed") {
        const partID = d.properties?.partID
        const part = s.parts[partID]
        if (!part) return s
        const { [partID]: _, ...parts } = s.parts
        const partOrder = s.partOrder.filter((id) => id !== partID)
        const activity = { ...s.activity }
        // Se o texto removido é a última atividade, restaura a anterior da sessão.
        if (activity[part.sessionID]?.at === part.at || activity[part.sessionID]?.text === lastLine(part.text)) {
          delete activity[part.sessionID]
          for (let i = partOrder.length - 1; i >= 0; i--) {
            const previous = parts[partOrder[i]!]
            if (previous.sessionID !== part.sessionID) continue
            const text = previous.type === "tool"
              ? `${previous.tool}${previous.toolTitle ? ` · ${previous.toolTitle}` : ""}`
              : lastLine(previous.text)
            if (!text) continue
            activity[part.sessionID] = { at: previous.at ?? e.at, text }
            break
          }
        }
        return { ...s, parts, partOrder, activity }
      }
      // A sessão raiz só existe depois que a sandbox sobe; quem abriu a tarefa antes disso
      // recebeu um snapshot sem sessionID e precisa aprender com o evento session.bound.
      if (d.type === "session.bound" && s.task) return { ...s, task: { ...s.task, sessionID: d.sessionID } }
      return s

    default:
      return s
  }
}

function upsertPart(s: TaskState, raw: any, at: number): TaskState {
  const isTool = raw.type === "tool"
  const part: ChatPart = {
    id: raw.id,
    messageID: raw.messageID,
    sessionID: raw.sessionID,
    type: raw.type,
    text: raw.text ?? s.parts[raw.id]?.text ?? "",
    tool: raw.tool,
    toolStatus: raw.state?.status,
    toolTitle: raw.state?.title ?? raw.state?.input?.description ?? summarizeInput(raw.state?.input),
    at: s.parts[raw.id]?.at ?? at,
  }
  const exists = raw.id in s.parts
  const activityText = isTool ? `${raw.tool}${part.toolTitle ? ` · ${part.toolTitle}` : ""}` : lastLine(part.text)
  return {
    ...s,
    parts: { ...s.parts, [raw.id]: part },
    partOrder: exists ? s.partOrder : [...s.partOrder, raw.id],
    activity: activityText ? { ...s.activity, [part.sessionID]: { at, text: activityText } } : s.activity,
  }
}

function summarizeInput(input: any): string | undefined {
  if (!input) return undefined
  const v = input.command ?? input.filePath ?? input.path ?? input.pattern ?? input.url
  return typeof v === "string" ? v : undefined
}

function lastLine(text: string) {
  const lines = text.trim().split("\n").map(inlinePlain).filter(Boolean)
  return (lines[lines.length - 1] ?? "").slice(0, 140)
}

/** Markdown de uma linha para texto puro (grafo, escritório, letreiro e barra do líder mostram uma linha só). */
export function inlinePlain(line: string) {
  return line
    .replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, "")
    .replace(/^\s*(```.*|---+|\*\*\*+)\s*$/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*?)[*_](?=[^*\w]|$)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .trim()
}

/** Texto markdown inteiro numa linha, para espaços de uma linha só. */
export function plainOneLine(text: string) {
  return text.split("\n").map(inlinePlain).filter(Boolean).join(" · ")
}

export function useTaskStream(taskID: string) {
  const [state, dispatch] = useReducer(reduce, initial)

  useEffect(() => {
    dispatch({ type: "reset" })
    const es = new EventSource(eventsUrl(taskID))
    es.onopen = () => dispatch({ type: "connected", value: true })
    es.onerror = () => dispatch({ type: "connected", value: false })
    es.addEventListener("snapshot", (m) => dispatch({ type: "snapshot", task: JSON.parse((m as MessageEvent).data) }))
    // O orquestrador manda `event: <kind>`; escutamos todos pelos nomes conhecidos + "message" padrão.
    const kinds = [
      "task.status",
      "task.publication",
      "message",
      "message.delta",
      "tool",
      "squad.member",
      "board.activity",
      "board.snapshot",
      "permission.asked",
      "permission.replied",
      "session.status",
      "session.diff",
      "error",
      "raw",
    ]
    // "error" também dispara em falha de conexão (sem data): ignora esses.
    const onEvent = (m: MessageEvent) => {
      if (typeof m.data === "string" && m.data) dispatch({ type: "event", event: JSON.parse(m.data) })
    }
    for (const k of kinds) es.addEventListener(k, onEvent as EventListener)
    return () => es.close()
  }, [taskID])

  return { state, dispatch }
}
