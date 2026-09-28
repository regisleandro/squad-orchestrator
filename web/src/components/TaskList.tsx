import { useEffect, useState, type FormEvent } from "react"
import { HARNESS_LABEL, api, type Harness, type HarnessInfo, type Task } from "../api"
import { StatusDot, STATUS_LABEL, repoName, timeAgo } from "./common"
import { describeFailure } from "../taskFailure"

// Usado só se o orquestrador for antigo e não tiver GET /harnesses.
const FALLBACK: HarnessInfo[] = [
  {
    id: "kilo",
    label: "Kilo Code",
    defaultAgent: "squad-lead",
    agents: [
      { value: "squad-lead", label: "squad-lead (squad própria)" },
      { value: "orchestrator", label: "orchestrator (nativo do Kilo)" },
      { value: "code", label: "code (agente único)" },
    ],
    capabilities: { squad: true, board: true, permissions: true },
    modelHint: "provider/model",
  },
]

/** Uma linha sobre o que o harness entrega da squad, para escolher sabendo o que muda. */
function capabilityLine(h: HarnessInfo) {
  const { squad, board, permissions } = h.capabilities
  const who = h.id === "kilo" || h.id === "aic" ? "Squad nativa" : squad ? "Squad como subagentes" : "Agente único"
  const extras = [board && "board", permissions && "permissões"].filter(Boolean)
  return extras.length ? `${who}, ${extras.join(" e ")}.` : `${who}, sem board nem aprovações.`
}

export function TaskList({ onOpen }: { onOpen: (id: string) => void }) {
  const [tasks, setTasks] = useState<Task[]>([])
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [repoUrl, setRepoUrl] = useState("")
  const [branch, setBranch] = useState("")
  const [prompt, setPrompt] = useState("")
  const [harnesses, setHarnesses] = useState<HarnessInfo[]>(FALLBACK)
  const [harness, setHarness] = useState<Harness>("kilo")
  const [agent, setAgent] = useState(FALLBACK[0]!.defaultAgent)
  const [model, setModel] = useState("")
  const info = harnesses.find((h) => h.id === harness) ?? harnesses[0]!

  useEffect(() => {
    api
      .harnesses()
      .then((r) => {
        if (!r.harnesses.length) return
        setHarnesses(r.harnesses)
        const first = r.harnesses.find((h) => h.id === r.default) ?? r.harnesses[0]!
        setHarness(first.id)
        setAgent(first.defaultAgent)
      })
      .catch(() => {})
  }, [])

  const pickHarness = (h: HarnessInfo) => {
    setHarness(h.id)
    setAgent(h.defaultAgent)
  }

  useEffect(() => {
    let alive = true
    const load = () =>
      api
        .listTasks()
        .then((t) => alive && (setTasks(t), setError(undefined)))
        .catch((e) => alive && setError(e.message))
    load()
    const timer = setInterval(load, 4000)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    setError(undefined)
    try {
      const task = await api.createTask({ repoUrl, branch: branch || undefined, prompt, harness, agent, model: model || undefined })
      onOpen(task.id)
    } catch (err: any) {
      setError(err.message)
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <span className="label">Agentic Squad · POC</span>
      <h1 className="display" style={{ marginTop: 16 }}>
        Uma squad por tarefa,
        <br />
        uma sandbox por squad.
      </h1>

      <div className="home-grid">
        <form className="card form" onSubmit={submit}>
          <div className="label">Nova tarefa</div>
          <div className="field">
            <span className="small muted" id="harness-label">Harness</span>
            <div className="harness-pick" role="radiogroup" aria-labelledby="harness-label">
              {harnesses.map((h) => (
                <button
                  key={h.id}
                  type="button"
                  role="radio"
                  aria-checked={h.id === harness}
                  className={h.id === harness ? "on" : ""}
                  onClick={() => pickHarness(h)}
                >
                  <span className="harness-name">{h.label}</span>
                  <span className="harness-caps">{capabilityLine(h)}</span>
                </button>
              ))}
            </div>
            {info.note && <span className="small muted">{info.note}</span>}
          </div>
          <div className="field">
            <label className="small muted" htmlFor="repo">Repositório</label>
            <input
              id="repo"
              className="input"
              placeholder="https://github.com/org/repo"
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              required
            />
          </div>
          <div className="row">
            <div className="field" style={{ flex: 1 }}>
              <label className="small muted" htmlFor="branch">Branch</label>
              <input id="branch" className="input" placeholder="padrão do repo" value={branch} onChange={(e) => setBranch(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1.4 }}>
              <label className="small muted" htmlFor="agent">Agente líder</label>
              <select id="agent" className="input" value={agent} onChange={(e) => setAgent(e.target.value)} disabled={info.agents.length < 2}>
                {info.agents.map((a) => (
                  <option key={a.value} value={a.value}>
                    {a.label}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label className="small muted" htmlFor="prompt">O que a squad deve fazer</label>
            <textarea
              id="prompt"
              className="textarea"
              rows={5}
              placeholder="Ex.: adicione paginação no endpoint /orders com testes"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              required
            />
          </div>
          <div className="field">
            <label className="small muted" htmlFor="model">Modelo (opcional)</label>
            <input id="model" className="input mono" placeholder={info.modelHint} value={model} onChange={(e) => setModel(e.target.value)} />
          </div>
          {error && <div className="small" style={{ color: "var(--alert)" }}>{error}</div>}
          <div>
            <button className="pill" type="submit" disabled={busy}>
              {busy ? "Criando…" : "Iniciar squad →"}
            </button>
          </div>
        </form>

        <section>
          <div className="label" style={{ paddingBottom: 8, borderBottom: "1px solid var(--ink)" }}>
            Tarefas · {tasks.length}
          </div>
          {tasks.length === 0 && <p className="muted small">Nenhuma tarefa ainda. Crie a primeira ao lado.</p>}
          {tasks.map((t) => (
            <a
              key={t.id}
              className="task-row"
              href={`#/tasks/${t.id}`}
              onClick={(e) => {
                e.preventDefault()
                onOpen(t.id)
              }}
            >
              <StatusDot status={t.status} />
              <div style={{ minWidth: 0 }}>
                <div className="task-title">{t.prompt}</div>
                <div className="small muted">
                  {HARNESS_LABEL[t.harness ?? "kilo"]} · {repoName(t.repoUrl)} · {t.branch || "branch padrão"} · {Object.keys(t.members).length} membros
                </div>
                {t.error && <div className="small failure-status">{describeFailure(t.error).title}</div>}
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="label">{STATUS_LABEL[t.status]}</div>
                <div className="small muted">há {timeAgo(t.createdAt)}</div>
              </div>
            </a>
          ))}
        </section>
      </div>
    </div>
  )
}
