// Tipos do domínio do orquestrador.

import type { Harness } from "./harness.js"

export type TaskStatus =
  | "queued" // aceita, aguardando provisionamento
  | "provisioning" // container subindo + git clone
  | "starting" // aguardando /global/health do kilo serve
  | "running" // sessão da squad trabalhando
  | "waiting_permission" // pedido de permissão aberto aguardando humano
  | "idle" // sessão ociosa (turno concluído), sandbox ainda viva
  | "error"
  | "stopped" // sandbox destruída

export interface SandboxHandle {
  id: string // containerID (docker) ou "external"
  baseUrl: string // URL interna do kilo serve (nunca exposta ao browser)
  password: string // KILO_SERVER_PASSWORD gerada por tarefa
  directory: string // diretório do repo dentro da sandbox (query ?directory=)
  harness: Harness // quem responde na porta: kilo serve ou a ponte (Claude Code / Codex)
}

export interface Task {
  id: string
  owner: string
  repoUrl: string
  branch: string // "" = branch padrão do repo
  prompt: string
  harness: Harness
  agent: string
  model?: string
  status: TaskStatus
  error?: string
  sandbox?: SandboxHandle
  sessionID?: string // sessão raiz (orquestradora) = dona do board do Swarm
  members: Record<string, SquadMember> // sessões filhas (subagentes `task`)
  pendingPermissions: Record<string, PermissionRequest>
  createdAt: number
  updatedAt: number
  lastActivityAt: number
}

export interface SquadMember {
  sessionID?: string
  callID: string
  agent: string
  description: string
  status: "pending" | "running" | "completed" | "error"
  startedAt: number
  endedAt?: number
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

export interface CreateTaskInput {
  repoUrl: string
  branch?: string
  prompt: string
  harness?: Harness
  agent?: string
  model?: string
}

/** Evento cru emitido por `GET /event` do kilo serve. */
export interface KiloEvent {
  id?: string
  type: string
  properties?: Record<string, any>
  data?: Record<string, any>
}

/**
 * Evento normalizado republicado para o browser. `kind` é o que a UI usa para
 * decidir onde renderizar (timeline, grafo da squad, board, modal de permissão).
 */
export type UiEventKind =
  | "task.status"
  | "message" // mensagem/parte de texto da sessão
  | "message.delta" // streaming de texto
  | "tool" // tool call genérica
  | "squad.member" // tool `task` = nascimento/fim de um membro da squad
  | "board.activity" // tool board_post/board_read
  | "board.snapshot" // estado atual do board (GET .../board)
  | "permission.asked"
  | "permission.replied"
  | "session.status"
  | "session.diff"
  | "error"
  | "raw" // qualquer outro evento do Kilo, repassado como está

export interface UiEvent {
  seq: number // monotônico por tarefa; usado como SSE id / Last-Event-ID
  taskID: string
  kind: UiEventKind
  at: number
  data: unknown
}
