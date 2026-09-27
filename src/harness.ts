// Harnesses suportados e o que cada um entrega da experiência da squad.
//
// Todos falam o mesmo protocolo com o orquestrador (o subconjunto HTTP/SSE do `kilo serve`):
//   kilo        -> `kilo serve` direto (squad nativa, board do Swarm, permissões do kilo.jsonc)
//   claude-code -> ponte em sandbox/bridge com o Claude Agent SDK (subagentes = a mesma squad,
//                  board emulado via MCP in-process, permissões via canUseTool + kilo.jsonc)
//   codex       -> ponte com o @openai/codex-sdk (um agente só, sem board, sem aprovação interativa)
// A UI usa `capabilities` para avisar o que não existe naquele harness.

export const HARNESSES = ["kilo", "claude-code", "codex"] as const
export type Harness = (typeof HARNESSES)[number]

export interface HarnessInfo {
  id: Harness
  label: string
  /** Agente primário padrão e os que fazem sentido oferecer na UI. */
  defaultAgent: string
  agents: { value: string; label: string }[]
  capabilities: {
    squad: boolean // subagentes aparecem como membros no grafo
    board: boolean // board do Swarm (nativo ou emulado)
    permissions: boolean // pedidos de aprovação chegam à UI
  }
  /** O que degrada, em uma frase, para a UI mostrar. */
  note?: string
  modelHint: string
}

export const HARNESS_INFO: Record<Harness, HarnessInfo> = {
  kilo: {
    id: "kilo",
    label: "Kilo Code",
    defaultAgent: "squad-lead",
    agents: [
      { value: "squad-lead", label: "squad-lead (squad própria)" },
      { value: "orchestrator", label: "orchestrator (nativo do Kilo)" },
      { value: "code", label: "code (agente único)" },
    ],
    capabilities: { squad: true, board: true, permissions: true },
    modelHint: "provider/model, ex.: anthropic/claude-sonnet-5",
  },
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    defaultAgent: "squad-lead",
    agents: [
      { value: "squad-lead", label: "squad-lead (mesma squad, como subagentes)" },
      { value: "claude", label: "claude (Claude Code puro)" },
    ],
    capabilities: { squad: true, board: true, permissions: true },
    note: "Board emulado pela ponte (MCP); a squad roda como subagentes do Claude Code.",
    modelHint: "sonnet, opus ou um id completo",
  },
  codex: {
    id: "codex",
    label: "Codex",
    defaultAgent: "codex",
    agents: [{ value: "codex", label: "codex (agente único)" }],
    capabilities: { squad: false, board: false, permissions: false },
    note: "Agente único: sem subagentes, sem board e sem pedidos de permissão (o container é o isolamento).",
    modelHint: "id do modelo da OpenAI, ex.: gpt-5-codex",
  },
}

export function isHarness(value: unknown): value is Harness {
  return typeof value === "string" && (HARNESSES as readonly string[]).includes(value)
}
