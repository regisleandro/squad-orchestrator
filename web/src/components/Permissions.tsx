import { useState } from "react"
import { api, type PermissionRequest } from "../api"
import type { TaskState } from "../useTaskStream"

export function Permissions({ taskID, state }: { taskID: string; state: TaskState }) {
  const pending = Object.values(state.permissions).sort((a, b) => a.askedAt - b.askedAt)
  if (!pending.length) return null
  const agentOf = (sessionID: string) =>
    sessionID === state.task?.sessionID
      ? (state.task?.agent ?? "líder")
      : (Object.values(state.members).find((m) => m.sessionID === sessionID)?.agent ?? "membro")

  return (
    <div className="glass-stack" role="region" aria-label="Pedidos de permissão">
      {pending.map((p) => (
        <PermissionCard key={p.id} taskID={taskID} request={p} agent={agentOf(p.sessionID)} />
      ))}
    </div>
  )
}

function PermissionCard({ taskID, request, agent }: { taskID: string; request: PermissionRequest; agent: string }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const detail =
    (request.metadata?.command as string) ??
    (request.metadata?.filepath as string) ??
    (request.metadata?.url as string) ??
    request.patterns.join("\n")

  const reply = async (r: "once" | "always" | "reject") => {
    setBusy(true)
    setError(undefined)
    try {
      await api.replyPermission(taskID, request.id, r)
    } catch (e: any) {
      setError(e.message)
      setBusy(false)
    }
  }

  return (
    <div className="glass">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span className="tag solid">
          <span className="dot waiting" style={{ borderColor: "var(--canvas)" }} />
          Permissão
        </span>
        <span className="label">{agent}</span>
      </div>
      <div className="h3" style={{ marginTop: 12 }}>
        Liberar <strong>{request.permission}</strong>?
      </div>
      <pre className="mono">{detail}</pre>
      {error && <div className="small" style={{ color: "var(--alert)", marginBottom: 8 }}>{error}</div>}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button className="pill" disabled={busy} onClick={() => reply("once")}>
          Permitir uma vez
        </button>
        {request.always.length > 0 && (
          <button className="pill quiet" disabled={busy} onClick={() => reply("always")} title={request.always.join(", ")}>
            Sempre
          </button>
        )}
        <button className="pill danger" disabled={busy} onClick={() => reply("reject")}>
          Recusar
        </button>
      </div>
    </div>
  )
}
