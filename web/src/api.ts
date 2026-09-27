// Cliente da API do orquestrador. Em dev, /api é proxiado pelo Vite (vite.config.ts).

export type TaskStatus =
  | "queued"
  | "provisioning"
  | "starting"
  | "running"
  | "waiting_permission"
  | "idle"
  | "error"
  | "stopped"

export type Harness = "kilo" | "claude-code" | "codex"

export interface HarnessInfo {
  id: Harness
  label: string
  defaultAgent: string
  agents: { value: string; label: string }[]
  capabilities: { squad: boolean; board: boolean; permissions: boolean }
  note?: string
  modelHint: string
}

export const HARNESS_LABEL: Record<Harness, string> = { kilo: "Kilo Code", "claude-code": "Claude Code", codex: "Codex" }

export interface SquadMember {
  callID: string
  sessionID?: string
  agent: string
  description: string
  status: "pending" | "running" | "completed" | "error"
  startedAt: number
  endedAt?: number
  parentSessionID?: string
}

export interface PermissionRequest {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  always: string[]
  askedAt: number
}

export interface Task {
  id: string
  repoUrl: string
  branch: string
  prompt: string
  harness?: Harness // ausente em tarefas de orquestradores antigos = kilo
  agent: string
  model?: string
  status: TaskStatus
  error?: string
  sessionID?: string
  members: Record<string, SquadMember>
  pendingPermissions: Record<string, PermissionRequest>
  createdAt: number
  updatedAt: number
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

export interface SessionBoard {
  ownerSessionID: string
  revision: number
  messages: BoardMessage[]
  hasMore: boolean
}

export interface UiEvent {
  seq: number
  taskID: string
  kind: string
  at: number
  data: any
}

const BASE = import.meta.env.VITE_API_BASE ?? "/api"
const TOKEN_KEY = "squad.apiToken"

export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? import.meta.env.VITE_API_TOKEN ?? ""
  } catch {
    return import.meta.env.VITE_API_TOKEN ?? ""
  }
}

export function setToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token)
  } catch {
    // sem storage: token vale só nesta aba
  }
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  const data = text ? JSON.parse(text) : undefined
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText)
  return data as T
}

export const api = {
  harnesses: () => request<{ default: Harness; harnesses: HarnessInfo[] }>("GET", "/harnesses"),
  listTasks: () => request<Task[]>("GET", "/tasks"),
  getTask: (id: string) => request<Task>("GET", `/tasks/${id}`),
  createTask: (input: { repoUrl: string; branch?: string; prompt: string; harness?: Harness; agent?: string; model?: string }) =>
    request<Task>("POST", "/tasks", input),
  prompt: (id: string, text: string) => request("POST", `/tasks/${id}/prompt`, { text }),
  replyPermission: (id: string, permissionID: string, reply: "once" | "always" | "reject") =>
    request("POST", `/tasks/${id}/permissions/${permissionID}`, { reply }),
  replay: (id: string) => request<{ task: Task; events: UiEvent[] }>("GET", `/tasks/${id}/replay`),
  board: (id: string) => request<SessionBoard>("GET", `/tasks/${id}/board?limit=50`),
  resetBoard: (id: string, revision: number) => request<SessionBoard>("POST", `/tasks/${id}/board/reset`, { revision }),
  diff: (id: string) => request<unknown>("GET", `/tasks/${id}/diff`),
  abort: (id: string) => request("POST", `/tasks/${id}/abort`),
  destroy: (id: string) => request("DELETE", `/tasks/${id}`),
}

/** EventSource não manda header, então o token vai na query (o orquestrador aceita ?token=). */
export function eventsUrl(id: string) {
  return `${BASE}/tasks/${id}/events?token=${encodeURIComponent(getToken())}`
}
