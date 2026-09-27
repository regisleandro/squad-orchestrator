import { useEffect, useState } from "react"
import { api } from "../api"

// O formato de /session/:id/diff varia entre versões do Kilo; mostramos arquivo, +/- e o patch se vier.
interface FileDiff {
  file: string
  additions?: number
  deletions?: number
  patch?: string
  before?: string
  after?: string
}

export function DiffDrawer({ taskID, onClose }: { taskID: string; onClose: () => void }) {
  const [files, setFiles] = useState<FileDiff[]>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    api
      .diff(taskID)
      .then((d: any) => setFiles(Array.isArray(d) ? d : (d?.files ?? [])))
      .catch((e) => setError(e.message))
  }, [taskID])

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer" aria-label="Diff da sessão">
        <div className="col-head">
          <span className="label">Mudanças · {files?.length ?? "…"} arquivos</span>
          <button className="pill quiet" style={{ padding: "4px 12px" }} onClick={onClose}>
            Fechar
          </button>
        </div>
        <div className="col-body">
          {error && <div style={{ color: "var(--alert)" }}>{error}</div>}
          {files?.length === 0 && <div className="empty">Nenhuma mudança ainda.</div>}
          {files?.map((f) => (
            <div key={f.file} className="diff-file">
              <div className="diff-file-head">
                <span>{f.file}</span>
                <span>
                  +{f.additions ?? 0} −{f.deletions ?? 0}
                </span>
              </div>
              {(f.patch ?? f.after) && <pre>{f.patch ?? f.after}</pre>}
            </div>
          ))}
        </div>
      </aside>
    </>
  )
}
