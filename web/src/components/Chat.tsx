import { useEffect, useRef, useState, type KeyboardEvent } from "react"
import { api } from "../api"
import { agentColor } from "../squad"
import type { TaskState } from "../useTaskStream"
import { Markdown, Thinking } from "./Markdown"
import { describeFailure } from "../taskFailure"

export function Chat({ taskID, state, scope = "all" }: { taskID: string; state: TaskState; scope?: "lead" | "all" }) {
  const root = state.task?.sessionID
  const endRef = useRef<HTMLDivElement>(null)
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()

  const parts = state.partOrder
    .map((id) => state.parts[id]!)
    .filter((p) => p && (scope === "all" || !root || p.sessionID === root))
  const agentOf = (sessionID: string) =>
    sessionID === root
      ? (state.task?.agent ?? "líder")
      : (Object.values(state.members).find((m) => m.sessionID === sessionID)?.agent ?? "membro")
  const lastText = parts.length ? parts[parts.length - 1]!.text.length : 0

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [parts.length, lastText])

  const send = async () => {
    const value = text.trim()
    if (!value) return
    setSending(true)
    setError(undefined)
    try {
      await api.prompt(taskID, value)
      setText("")
    } catch (e: any) {
      setError(e.message)
    } finally {
      setSending(false)
    }
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void send()
  }

  const canSend = !!root && state.task?.status !== "stopped" && state.task?.publication?.status !== "publishing"

  return (
    <>
      <div className="col-body">
        {state.task && (
          <div className="msg user">
            <div className="msg-meta">
              <span className="label">Você · pedido inicial</span>
            </div>
            <div className="msg-text">{state.task.prompt}</div>
          </div>
        )}

        {parts.map((p) => {
          if (p.type === "tool") {
            const who = scope === "all" ? `${agentOf(p.sessionID)} · ` : ""
            const label =
              who + (p.tool === "task" ? `delegou · ${p.toolTitle ?? ""}` : `${p.tool}${p.toolTitle ? ` · ${p.toolTitle}` : ""}`)
            return (
              <div key={p.id} className="tool-line">
                <span className={`dot ${p.toolStatus === "completed" ? "completed" : p.toolStatus === "error" ? "error" : "running"}`} />
                <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
              </div>
            )
          }
          if (p.type === "reasoning" && p.text.trim()) {
            return (
              <div key={p.id} className="msg">
                {scope === "all" && (
                  <div className="msg-meta">
                    <span className="label" style={{ color: agentColor(agentOf(p.sessionID), p.sessionID === root) }}>{agentOf(p.sessionID)}</span>
                  </div>
                )}
                <Thinking text={p.text} />
              </div>
            )
          }
          if (p.type !== "text" || !p.text.trim()) return null
          const info = p.messageID ? state.messages[p.messageID] : undefined
          const isUser = info?.role === "user"
          if (isUser && p.text.trim() === state.task?.prompt.trim()) return null // já mostrado acima
          return (
            <div key={p.id} className={`msg ${isUser ? "user" : ""}`}>
              <div className="msg-meta">
                <span className="label" style={isUser ? undefined : { color: agentColor(agentOf(p.sessionID), p.sessionID === root) }}>
                  {isUser ? (p.sessionID === root ? "Você" : `${agentOf(p.sessionID)} · instrução recebida`) : agentOf(p.sessionID)}
                </span>
              </div>
              {isUser ? <div className="msg-text">{p.text}</div> : <Markdown className="msg-text" text={p.text} />}
            </div>
          )
        })}

        {state.errors.map((e, i) => (
          <div key={i} className="msg">
            <span className="tag alert">Erro</span>
            <div className="msg-text small" style={{ marginTop: 6 }}>
              {describeFailure(e.message).title}
            </div>
            <div className="small muted">{describeFailure(e.message).action}</div>
            <details className="failure-details"><summary>Detalhes técnicos</summary><pre>{e.message}</pre></details>
            {e.logs && (
              <details style={{ marginTop: 8 }}>
                <summary className="small muted">Logs da sandbox</summary>
                <pre className="mono" style={{ whiteSpace: "pre-wrap", background: "var(--surface)", border: "1px solid var(--bone)", padding: 12, borderRadius: 4 }}>
                  {e.logs}
                </pre>
              </details>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <div className="composer">
        <textarea
          className="textarea"
          rows={1}
          placeholder={canSend ? "Mensagem para a squad (⌘ + Enter)" : "Aguardando a sessão iniciar…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={!canSend}
        />
        <button className="pill" onClick={send} disabled={!canSend || sending || !text.trim()}>
          Enviar
        </button>
      </div>
      {error && (
        <div className="small" style={{ color: "var(--alert)", padding: "0 24px 12px" }}>
          {error}
        </div>
      )}
    </>
  )
}
