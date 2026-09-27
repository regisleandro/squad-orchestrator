import { useEffect, useRef, useState, type FormEvent } from "react"
import { api, type PublicationPreview, type PullRequestResult, type Task } from "../api"

const STEPS = { checking: "Conferindo a revisão…", committing: "Criando commit…", pushing: "Enviando a branch…", creating: "Criando PR no GitHub…", done: "PR publicado" }

export function PublicationPanel({ task, onClose }: { task: Task; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [preview, setPreview] = useState<PublicationPreview>()
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draft, setDraft] = useState(true)
  const [reviewed, setReviewed] = useState(false)
  const [loading, setLoading] = useState(true)
  const [publishing, setPublishing] = useState(false)
  const [error, setError] = useState<string>()
  const [result, setResult] = useState<PullRequestResult>()
  const busy = publishing || task.publication?.status === "publishing"
  const published = result ?? task.publication?.result
  const mounted = useRef(false)

  const load = async () => {
    setLoading(true)
    setReviewed(false)
    setError(undefined)
    try {
      const next = await api.publicationPreview(task.id)
      if (!mounted.current) return
      setPreview(next)
      setTitle((previous) => previous || next.title)
      setBody((previous) => previous || next.body)
    } catch (err) {
      if (mounted.current) { setPreview(undefined); setError(err instanceof Error ? err.message : "Não foi possível carregar a revisão.") }
    } finally {
      if (mounted.current) setLoading(false)
    }
  }

  useEffect(() => {
    mounted.current = true
    dialog.current?.showModal()
    void load()
    return () => { mounted.current = false }
  }, [task.id])

  const publish = async (event: FormEvent) => {
    event.preventDefault()
    if (!preview || !reviewed || busy) return
    setPublishing(true)
    setError(undefined)
    try {
      const value = await api.publish(task.id, { title, body, version: preview.version, reviewed, draft })
      if (mounted.current) setResult(value)
    } catch (err) {
      if (mounted.current) { setError(err instanceof Error ? err.message : "Não foi possível publicar o PR."); setReviewed(false) }
    } finally {
      if (mounted.current) setPublishing(false)
    }
  }

  return (
    <dialog className="publication-dialog" ref={dialog} aria-labelledby="publication-title" onCancel={(e) => { if (busy) e.preventDefault(); else onClose() }}>
      <div className="col-head">
        <h2 className="label" id="publication-title">{published ? "PR publicado" : "Revisar e publicar PR"}</h2>
        <button className="pill quiet small-pill" type="button" onClick={onClose} disabled={busy}>Fechar</button>
      </div>
      <form className="publication-form" onSubmit={publish}>
        <div className="publication-content">
          {published ? <div role="status">
            <h3>PR #{published.number} {published.draft ? "em rascunho" : "criado"}</h3>
            <p className="small muted">{published.branch} → {published.baseBranch}</p>
            <a className="pill" href={published.url} target="_blank" rel="noopener noreferrer">Abrir PR no GitHub ↗</a>
          </div> : <>
            <p className="small muted">Confira todas as mudanças e a validação antes de enviar a branch ao GitHub.</p>
            {loading && <p role="status" className="small">Carregando diff e acesso ao repositório…</p>}
            {error && <div className="publication-error" role="alert"><p>{error}</p><button type="button" className="pill quiet small-pill" onClick={load} disabled={busy || loading}>Atualizar revisão</button></div>}
            {preview && <>
              <dl className="publication-branches"><div><dt>Branch da tarefa</dt><dd>{preview.branch}</dd></div><div><dt>Destino</dt><dd>{preview.baseBranch}</dd></div></dl>
              <details className="publication-diff" open>
                <summary>Diff completo · {preview.files} {preview.files === 1 ? "arquivo" : "arquivos"}</summary>
                <pre tabIndex={0} aria-label="Diff completo para revisão">{preview.diff}</pre>
              </details>
              <p className="small muted">{preview.hasUncommitted ? "Há mudanças sem commit. A publicação criará um commit com o título abaixo." : `${preview.commits.length} commit(s) já criado(s) pelo agente. A publicação enviará esses commits.`}</p>
              <div className="field"><label className="small" htmlFor="pr-title">Título do PR e do novo commit</label><input className="input" id="pr-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={256} required disabled={busy} /></div>
              <div className="field"><label className="small" htmlFor="pr-body">Descrição e validação</label><textarea className="textarea" id="pr-body" value={body} onChange={(e) => setBody(e.target.value)} rows={8} maxLength={60000} required disabled={busy} /></div>
              <label className="publication-check"><input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} disabled={busy} /><span>Criar PR em rascunho</span></label>
              <label className="publication-check"><input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} disabled={busy || loading} /><span>Revisei o diff e confirmei a validação dos testes.</span></label>
            </>}
          </>}
        </div>
        {!published && <footer className="publication-footer">
          <span className="small muted" role="status">{busy ? STEPS[task.publication?.step ?? "checking"] : "Publicação somente após sua confirmação."}</span>
          <button type="submit" className="pill" disabled={!preview || !reviewed || !title.trim() || !body.trim() || busy || loading}>{busy ? "Publicando…" : preview?.hasUncommitted ? "Commitar e publicar PR" : "Publicar PR"}</button>
        </footer>}
      </form>
    </dialog>
  )
}
