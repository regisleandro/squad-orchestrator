import { useState } from "react"
import { api } from "../api"
import { describeFailure } from "../taskFailure"

export function TaskFailure({ taskID, message, canResume = false, readOnly = false }: { taskID: string; message: string; canResume?: boolean; readOnly?: boolean }) {
  const failure = describeFailure(message)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const resume = async () => {
    if (sending) return
    setSending(true)
    setError(undefined)
    try {
      await api.prompt(taskID, "Retome o pedido anterior a partir do ponto em que parou.")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Não foi possível retomar a tarefa.")
    } finally {
      setSending(false)
    }
  }
  return (
    <section className="task-failure" aria-label="Falha na tarefa">
      <div role="alert" aria-atomic="true">
        <span className="label failure-status">Turno interrompido</span>
        <h2 className="failure-title">{failure.title}</h2>
        <p className="small">{failure.description}</p>
        <p className="small muted">{failure.action}</p>
        {!canResume && !readOnly && <p className="small muted">A sandbox está indisponível. Crie uma nova tarefa para continuar.</p>}
      </div>
      <div className="failure-actions">
        {failure.link && <a className="pill quiet small-pill" href={failure.link.href} target="_blank" rel="noopener noreferrer">{failure.link.label} ↗</a>}
        {canResume && <button className="pill small-pill" disabled={sending} onClick={resume}>{sending ? "Retomando…" : "Retomar após corrigir"}</button>}
        {!canResume && !readOnly && <a className="pill quiet small-pill" href="#/">Voltar às tarefas</a>}
      </div>
      {error && <p className="small failure-status" role="alert">{error}</p>}
      <details className="failure-details">
        <summary>Detalhes técnicos</summary>
        <pre>{message}</pre>
      </details>
    </section>
  )
}
