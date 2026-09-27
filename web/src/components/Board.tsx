import { useEffect, useRef } from "react"
import { api } from "../api"
import type { TaskState } from "../useTaskStream"
import { agentColor } from "../squad"
import { clock } from "./common"
import { Markdown } from "./Markdown"

export function Board({ taskID, state, onBoard }: { taskID: string; state: TaskState; onBoard: (b: { messages: any[]; revision: number }) => void }) {
  const endRef = useRef<HTMLDivElement>(null)
  const root = state.task?.sessionID
  const messages = [...state.board].sort((a, b) => a.timestamp - b.timestamp)
  const live = state.boardLive && Date.now() - state.boardLive.at < 4000

  // Carga inicial (o stream só manda snapshot quando alguém posta).
  useEffect(() => {
    if (!root) return
    api.board(taskID).then(onBoard).catch(() => {})
  }, [taskID, root])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [messages.length])

  const reset = async () => {
    if (!confirm("Limpar as mensagens visíveis do board? As conversas e tarefas em andamento continuam.")) return
    const board = await api.resetBoard(taskID, state.boardRevision)
    onBoard(board)
  }

  const memberAgent = (id: string) => Object.values(state.members).find((m) => m.sessionID === id)?.agent
  const labelOf = (id: string, label?: string) => {
    if (id === "main" || id === root) return label ?? state.task?.agent ?? "líder"
    if (id === "ALL") return "todos"
    return memberAgent(id) ?? (label && label !== id ? label : id.slice(0, 12))
  }

  return (
    <>
      <div className="col-head">
        <span className="label" style={{ display: "flex", alignItems: "center", gap: 8 }}>
          Board do Swarm {live && <span className="dot running" />}
        </span>
        <button className="pill quiet" style={{ padding: "4px 12px", fontSize: 12 }} onClick={reset} disabled={!messages.length}>
          Limpar
        </button>
      </div>
      <div className="col-body">
        {messages.length === 0 && (
          <div className="empty">
            Quando os membros usarem <span className="mono">board_post</span>, as mensagens aparecem aqui.
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`post ${m.type === "VETO" ? "veto" : ""}`}>
            <div className="post-head">
              <span className={`tag ${m.type === "VETO" ? "alert" : m.type === "ASK" || m.type === "HOLD" ? "solid" : ""}`}>{m.type}</span>
              <span className="small">
                <strong style={{ color: agentColor(labelOf(m.from, m.fromLabel), m.from === "main" || m.from === root) }}>{labelOf(m.from, m.fromLabel)}</strong> → {labelOf(m.to, m.toLabel)}
              </span>
              <span className="small muted" style={{ marginLeft: "auto" }}>
                {clock(m.timestamp)}
              </span>
            </div>
            <Markdown className="post-body" text={m.body} />
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </>
  )
}
