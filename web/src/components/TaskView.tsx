import { useEffect, useState } from "react"
import { HARNESS_LABEL, api } from "../api"
import { NowContext } from "../clock"
import { useTaskStream } from "../useTaskStream"
import { Board } from "./Board"
import { Chat } from "./Chat"
import { DiffDrawer } from "./DiffDrawer"
import { Permissions } from "./Permissions"
import { ReplayBar, useReplay } from "./Replay"
import { Squad } from "./Squad"
import { TaskFailure } from "./TaskFailure"
import { Stage } from "./Stage"
import { PublicationPanel } from "./PublicationPanel"
import { StatusTag, repoName } from "./common"

export function TaskView({ taskID, onBack }: { taskID: string; onBack: () => void }) {
  const { state, dispatch } = useTaskStream(taskID)
  const [showDiff, setShowDiff] = useState(false)
  const [showPublication, setShowPublication] = useState(false)
  const [scope, setScope] = useState<"lead" | "all">("all")
  const [view, setView] = useState<"stage" | "office" | "details">(() => {
    try {
      const saved = localStorage.getItem("squad.view")
      return saved === "details" || saved === "office" ? saved : "stage"
    } catch {
      return "stage"
    }
  })
  const [replaying, setReplaying] = useState(false)
  const pickView = (v: "stage" | "office" | "details") => {
    setView(v)
    if (v === "details") setReplaying(false) // replay só no Palco e no Escritório
    try {
      localStorage.setItem("squad.view", v)
    } catch {
      // sem storage: vale só nesta aba
    }
  }
  const task = state.task
  const publishing = task?.publication?.status === "publishing"
  const live = task && !["stopped", "error", "queued", "provisioning", "starting"].includes(task.status)

  // Carga inicial do board (o stream só manda snapshot quando alguém posta).
  const root = task?.sessionID
  useEffect(() => {
    if (!root) return
    api
      .board(taskID)
      .then((b) => dispatch({ type: "board", messages: b.messages, revision: b.revision }))
      .catch(() => {})
  }, [taskID, root])

  const stop = async () => {
    if (confirm("Encerrar a sandbox desta tarefa? O container é destruído.")) await api.destroy(taskID)
  }

  return (
    <div className="task-shell">
      <header className="task-header">
        <a
          className="brand"
          href="#/"
          onClick={(e) => {
            e.preventDefault()
            onBack()
          }}
        >
          <span className="brand-mark" />
          <span className="label" style={{ color: "var(--ink)" }}>
            Tarefas
          </span>
        </a>
        <span className="muted">/</span>
        {task ? (
          <>
            <span className="small">
              <strong>{repoName(task.repoUrl)}</strong> <span className="muted">· {task.branch || "branch padrão"}</span>
            </span>
            <span className="tag" title="Harness que roda a squad nesta tarefa">{HARNESS_LABEL[task.harness ?? "kilo"]}</span>
            <StatusTag status={task.status} />
            {!state.connected && <span className="tag">Reconectando…</span>}
          </>
        ) : (
          <span className="muted small">Carregando…</span>
        )}
        <span className="spacer" />
        <span className="chat-scope" role="tablist" aria-label="Visualização">
          <button className={view === "stage" ? "on" : ""} onClick={() => pickView("stage")}>
            Palco
          </button>
          <button className={view === "office" ? "on" : ""} onClick={() => pickView("office")}>
            Escritório
          </button>
          <button className={view === "details" ? "on" : ""} onClick={() => pickView("details")}>
            Detalhes
          </button>
        </span>
        {view !== "details" && (
          <button
            className={`pill ${replaying ? "" : "quiet"}`}
            onClick={() => setReplaying((r) => !r)}
            disabled={!task?.sessionID}
            title="Reproduz o trabalho da squad desde o início"
          >
            {replaying ? "Sair do replay" : "Replay"}
          </button>
        )}
        <button className="pill quiet" onClick={() => setShowDiff(true)} disabled={!task?.sessionID}>
          Ver diff{state.diffCount ? ` · ${state.diffCount}` : ""}
        </button>
        {task?.publication?.result ? <a className="pill" href={task.publication.result.url} target="_blank" rel="noopener noreferrer">Ver PR #{task.publication.result.number} ↗</a> : (
          <button className="pill" onClick={() => setShowPublication(true)} disabled={!task?.sandbox || task.sandbox.id === "external" || task.status !== "idle" || replaying || publishing} title={task?.status !== "idle" ? "Disponível quando o turno concluir sem falhas" : "Revisar mudanças e publicar no GitHub"}>
            {publishing ? "Publicando PR…" : task?.publication?.status === "error" ? "Revisar publicação" : "Publicar PR"}
          </button>
        )}
        <button className="pill quiet" onClick={() => api.abort(taskID)} disabled={!live || publishing}>
          Parar turno
        </button>
        <button className="pill danger" onClick={stop} disabled={!task || task.status === "stopped" || publishing}>
          Encerrar
        </button>
      </header>

      {!replaying && task?.error && ["error", "stopped"].includes(task.status) && (
        <TaskFailure key={taskID} taskID={taskID} message={task.error} canResume={!!task.sessionID && task.status === "error"} />
      )}

      {view !== "details" && replaying ? (
        <ReplayStage taskID={taskID} scene={view === "office" ? "office" : "graph"} onExit={() => setReplaying(false)} />
      ) : view !== "details" ? (
        <Stage taskID={taskID} state={state} scene={view === "office" ? "office" : "graph"} />
      ) : (
      <div className="columns">
        <section className="col">
          <div className="col-head">
            <span className="label">Conversa</span>
            <span className="chat-scope" role="tablist" aria-label="Mostrar mensagens de">
              <button className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>
                Todos
              </button>
              <button className={scope === "lead" ? "on" : ""} onClick={() => setScope("lead")}>
                Líder
              </button>
            </span>
          </div>
          <Chat taskID={taskID} state={state} scope={scope} />
        </section>
        <section className="col on-dark">
          <Squad state={state} />
        </section>
        <section className="col">
          <Board taskID={taskID} state={state} onBoard={(b) => dispatch({ type: "board", messages: b.messages, revision: b.revision })} />
        </section>
      </div>
      )}

      {view === "details" && <Permissions taskID={taskID} state={state} />}
      {showDiff && <DiffDrawer taskID={taskID} onClose={() => setShowDiff(false)} />}
      {showPublication && task && <PublicationPanel key={task.id} task={task} onClose={() => setShowPublication(false)} />}
    </div>
  )
}

function ReplayStage({ taskID, scene, onExit }: { taskID: string; scene: "graph" | "office"; onExit: () => void }) {
  const replay = useReplay(taskID)
  return (
    <NowContext.Provider value={replay.now}>
      {replay.state ? (
        <Stage taskID={taskID} state={replay.state} scene={scene} readOnly epoch={replay.epoch} />
      ) : (
        <div className="stage-shell">
          <div className="stage-empty small muted">{replay.error ? `Não deu para carregar o replay: ${replay.error}` : "Carregando o histórico…"}</div>
        </div>
      )}
      <ReplayBar replay={replay} onExit={onExit} />
    </NowContext.Provider>
  )
}
