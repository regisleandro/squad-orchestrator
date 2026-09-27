import { StrictMode, useEffect, useState, type FormEvent } from "react"
import { createRoot } from "react-dom/client"
import { ApiError, api, getToken, setToken } from "./api"
import { TaskList } from "./components/TaskList"
import { TaskView } from "./components/TaskView"
import "./styles.css"

// Roteamento por hash: #/ e #/tasks/:id
function useRoute() {
  const [hash, setHash] = useState(location.hash)
  useEffect(() => {
    const on = () => setHash(location.hash)
    addEventListener("hashchange", on)
    return () => removeEventListener("hashchange", on)
  }, [])
  const match = hash.match(/^#\/tasks\/([\w-]+)/)
  return { taskID: match?.[1], go: (path: string) => (location.hash = path) }
}

function App() {
  const { taskID, go } = useRoute()
  const [auth, setAuth] = useState<"checking" | "ok" | "needed">("checking")

  useEffect(() => {
    api
      .listTasks()
      .then(() => setAuth("ok"))
      .catch((e) => setAuth(e instanceof ApiError && e.status === 401 ? "needed" : "ok"))
  }, [])

  if (auth === "checking") return null
  if (auth === "needed") return <TokenGate onDone={() => setAuth("ok")} />

  return (
    <>
      {!taskID && (
        <header className="topbar">
          <a className="brand" href="#/">
            <span className="brand-mark" />
            <span className="label" style={{ color: "var(--ink)" }}>
              Squad Arena
            </span>
          </a>
          <span className="label">Kilo · Claude Code · Codex · self-hosted</span>
        </header>
      )}
      {taskID ? <TaskView taskID={taskID} onBack={() => go("/")} /> : <TaskList onOpen={(id) => go(`/tasks/${id}`)} />}
    </>
  )
}

function TokenGate({ onDone }: { onDone: () => void }) {
  const [value, setValue] = useState(getToken())
  const [error, setError] = useState<string>()
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setToken(value)
    try {
      await api.listTasks()
      onDone()
    } catch {
      setError("Token recusado pelo orquestrador.")
    }
  }
  return (
    <div className="page" style={{ maxWidth: 480 }}>
      <span className="label">Acesso</span>
      <h1 className="h2" style={{ margin: "16px 0 24px" }}>
        Informe o API_TOKEN do orquestrador
      </h1>
      <form className="card form" onSubmit={submit}>
        <input className="input mono" type="password" value={value} onChange={(e) => setValue(e.target.value)} autoFocus />
        {error && <div className="small" style={{ color: "var(--alert)" }}>{error}</div>}
        <div>
          <button className="pill" type="submit">
            Entrar →
          </button>
        </div>
      </form>
    </div>
  )
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
