// Layout "Palco": o grafo ocupa a tela; o resto aparece só quando importa.
//   - topo: um alerta por vez (permissão pendente > ASK/HOLD/VETO em aberto > erro)
//   - palco: grafo com balões + letreiro dos últimos acontecimentos
//   - clique num nó: painel lateral com o que o agente recebeu, disse e trocou no board
//   - rodapé: última fala do líder + campo para falar com a squad

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"
import { HARNESS_LABEL, api, type BoardMessage, type PermissionRequest } from "../api"
import { STATE_LABEL, agentColor, agentOfSession, boardLabel, buildSquad, openAlert, type AgentNode } from "../squad"
import { plainOneLine, type ChatPart, type TaskState } from "../useTaskStream"
import { StatusTag, clock, timeAgo } from "./common"
import { Graph } from "./Graph"
import { useNow } from "../clock"
import { Markdown, Thinking } from "./Markdown"
import { Office } from "./Office"
import { TaskFailure } from "./TaskFailure"

const QUIET_TOOLS = new Set(["read", "grep", "glob", "list", "board_read", "todoread"])

export function Stage({
  taskID,
  state,
  scene = "graph",
  readOnly = false,
  epoch = 0,
}: {
  taskID: string
  state: TaskState
  scene?: "graph" | "office"
  /** Replay: sem ações (permissões, parar turno, falar com a squad). */
  readOnly?: boolean
  /** Replay: muda a cada salto na linha do tempo; remonta a cena para não animar o salto. */
  epoch?: number
}) {
  const model = useMemo(() => buildSquad(state), [state.task?.sessionID, state.task?.agent, state.task?.status, state.members, state.permissions, state.sessionState])
  const [selected, setSelected] = useState<string>()
  const [selectedPost, setSelectedPost] = useState<string>()
  const node = selected ? model.byId.get(selected) : undefined
  const post = selectedPost ? state.board.find((b) => b.id === selectedPost) : undefined
  const narrow = useNarrow()
  // um painel por vez: agente ou post do board
  const pickAgent = (id: string) => {
    setSelectedPost(undefined)
    setSelected((s) => (s === id ? undefined : id))
  }
  const openPost = (id: string) => {
    setSelected(undefined)
    setSelectedPost((p) => (p === id ? undefined : id))
  }

  return (
    <div className="stage-shell">
      <AlertBar taskID={taskID} state={state} onSelect={pickAgent} readOnly={readOnly} />
      <div className="stage on-dark">
        {model.root ? (
          <div className={`stage-graph ${scene === "office" ? "office-scene" : ""} ${node || post ? "with-panel" : ""}`}>
            {scene === "office" ? (
              <Office key={epoch} state={state} selected={selected} selectedPost={post?.id} onSelect={pickAgent} onBoard={openPost} />
            ) : (
            <Graph
              key={epoch}
              state={state}
              width={narrow ? 320 : 900}
              perLine={narrow ? 1 : 6}
              bubbles
              className="fill"
              selected={selected}
              onSelect={pickAgent}
            />
            )}
          </div>
        ) : (
          <Booting state={state} />
        )}
        <Ticker state={state} />
        {model.root && !node && !post && (
          <div className="stage-hint label">
            {scene === "office" ? "Clique num agente ou num post-it do quadro" : "Clique num agente para ver o que ele está fazendo"}
          </div>
        )}
        {node && <AgentPanel state={state} node={node} onClose={() => setSelected(undefined)} onOpenPost={openPost} />}
        {post && <BoardPostPanel state={state} model={model} post={post} onOpenPost={openPost} onAgent={pickAgent} onClose={() => setSelectedPost(undefined)} />}
      </div>
      <LeadBar taskID={taskID} state={state} readOnly={readOnly} />
    </div>
  )
}

function useNarrow() {
  const query = "(max-width: 700px)"
  const [narrow, setNarrow] = useState(() => matchMedia(query).matches)
  useEffect(() => {
    const mq = matchMedia(query)
    const on = () => setNarrow(mq.matches)
    mq.addEventListener("change", on)
    return () => mq.removeEventListener("change", on)
  }, [])
  return narrow
}

function Booting({ state }: { state: TaskState }) {
  const status = state.task?.status
  const last = state.errors[state.errors.length - 1]
  return (
    <div className="stage-empty">
      {state.task && <StatusTag status={state.task.status} />}
      <div className="h3" style={{ marginTop: 16 }}>
        {status === "error" ? "A sandbox não subiu." : `Preparando a sandbox e o ${HARNESS_LABEL[state.task?.harness ?? "kilo"]}…`}
      </div>
      <div className="small muted" style={{ marginTop: 8 }}>
        {status === "error" ? (state.task?.error ?? last?.message) : "O palco aparece quando a sessão do líder iniciar."}
      </div>
      {last?.logs && (
        <details style={{ marginTop: 16, textAlign: "left" }}>
          <summary className="small muted">Logs da sandbox</summary>
          <pre className="mono stage-logs">{last.logs}</pre>
        </details>
      )}
    </div>
  )
}

/* ---------- Alerta único no topo ---------- */

function AlertBar({ taskID, state, onSelect, readOnly }: { taskID: string; state: TaskState; onSelect: (id: string) => void; readOnly: boolean }) {
  const model = useMemo(() => buildSquad(state), [state.task?.sessionID, state.members, state.permissions, state.sessionState])
  const permission = Object.values(state.permissions).sort((a, b) => a.askedAt - b.askedAt)[0]
  const others = Object.keys(state.permissions).length - 1

  if (permission) return <PermissionAlert taskID={taskID} state={state} request={permission} others={others} readOnly={readOnly} />

  const retrying = Object.entries(state.retry).sort((a, b) => b[1].at - a[1].at)[0]
  if (retrying) {
    const [sessionID, r] = retrying
    return (
      <div className="alert-bar veto" role="status">
        <span className="tag alert">Tentando de novo</span>
        <span className="small">
          <strong>{agentOfSession(state, sessionID)}</strong> não conseguiu falar com o modelo{r.attempt ? ` (tentativa ${r.attempt})` : ""}
        </span>
        <span className="alert-text small" title={r.message}>{r.message ?? "sem detalhe do harness"}</span>
        {!readOnly && (
          <button className="pill quiet small-pill" onClick={() => api.abort(taskID)}>
            Parar turno
          </button>
        )}
      </div>
    )
  }

  const board = openAlert(state, model)
  if (board) {
    const from = model.resolve(board.from)
    return (
      <div className={`alert-bar ${board.type === "VETO" ? "veto" : ""}`}>
        <span className={`tag ${board.type === "VETO" ? "alert" : "solid"}`}>{board.type}</span>
        <span className="small">
          <strong>{boardLabel(state, board.from, board.fromLabel)}</strong> → {boardLabel(state, board.to, board.toLabel)}
        </span>
        <span className="alert-text small">{board.body}</span>
        {from && (
          <button className="pill quiet small-pill" onClick={() => onSelect(from)}>
            Ver agente
          </button>
        )}
      </div>
    )
  }

  if (readOnly && state.task?.status === "error" && state.task.error) {
    return <TaskFailure taskID={taskID} message={state.task.error} readOnly />
  }
  return null
}

function PermissionAlert({
  taskID,
  state,
  request,
  others,
  readOnly,
}: {
  taskID: string
  state: TaskState
  request: PermissionRequest
  others: number
  readOnly: boolean
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  useEffect(() => {
    setBusy(false)
    setError(undefined)
  }, [request.id])
  const detail =
    (request.metadata?.command as string) ??
    (request.metadata?.filepath as string) ??
    (request.metadata?.url as string) ??
    request.patterns.join(" ")

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
    <div className="alert-bar permission" role="region" aria-label="Pedido de permissão">
      <span className="tag solid">
        <span className="dot waiting" style={{ borderColor: "var(--canvas)" }} />
        Permissão
      </span>
      <span className="small">
        <strong>{agentOfSession(state, request.sessionID)}</strong> quer rodar <strong>{request.permission}</strong>
      </span>
      <code className="mono alert-text">{detail}</code>
      {others > 0 && <span className="label">+{others} na fila</span>}
      {error && <span className="small" style={{ color: "var(--alert)" }}>{error}</span>}
      {!readOnly && <span className="alert-actions">
        <button className="pill small-pill" disabled={busy} onClick={() => reply("once")}>
          Permitir uma vez
        </button>
        {request.always.length > 0 && (
          <button className="pill quiet small-pill" disabled={busy} onClick={() => reply("always")} title={request.always.join(", ")}>
            Sempre
          </button>
        )}
        <button className="pill danger small-pill" disabled={busy} onClick={() => reply("reject")}>
          Recusar
        </button>
      </span>}
    </div>
  )
}

/* ---------- Letreiro ---------- */

interface TickerLine {
  at: number
  text: string
  color: string
  kind?: "veto" | "ask"
}

function Ticker({ state }: { state: TaskState }) {
  const lines = useMemo(() => {
    const lead = state.task?.agent ?? "líder"
    const out: TickerLine[] = []
    for (const m of Object.values(state.members)) {
      const parent = m.parentSessionID ? agentOfSession(state, m.parentSessionID) : lead
      const parentColor = agentColor(parent, !m.parentSessionID || m.parentSessionID === state.task?.sessionID)
      out.push({ at: m.startedAt, text: `${parent} delegou para ${m.agent}: ${m.description}`, color: parentColor })
      if (m.endedAt) out.push({ at: m.endedAt, text: m.status === "error" ? `${m.agent} falhou` : `${m.agent} entregou`, color: agentColor(m.agent) })
    }
    for (const b of state.board) {
      out.push({
        at: b.timestamp,
        text: `${boardLabel(state, b.from, b.fromLabel)} → ${boardLabel(state, b.to, b.toLabel)} · ${b.type}: ${b.body}`,
        color: senderColor(state, b.from, b.fromLabel),
        kind: b.type === "VETO" ? "veto" : b.type === "ASK" || b.type === "HOLD" ? "ask" : undefined,
      })
    }
    // Agente único (Codex, ou "code"/"claude" sem squad): sem delegações nem board, o letreiro
    // mostra os passos do próprio agente.
    if (!Object.keys(state.members).length && !state.board.length) {
      const color = agentColor(lead, true)
      for (const id of state.partOrder) {
        const p = state.parts[id]
        if (!p?.at || p.type !== "tool" || !p.tool || QUIET_TOOLS.has(p.tool)) continue
        const failed = p.toolStatus === "error"
        out.push({ at: p.at, text: `${lead} · ${p.tool}${p.toolTitle ? ` · ${p.toolTitle}` : ""}${failed ? " (falhou)" : ""}`, color, kind: failed ? "veto" : undefined })
      }
    }
    for (const p of Object.values(state.permissions))
      out.push({
        at: p.askedAt,
        text: `${agentOfSession(state, p.sessionID)} pediu permissão para ${p.permission}`,
        kind: "ask",
        color: agentColor(agentOfSession(state, p.sessionID), p.sessionID === state.task?.sessionID),
      })
    return out.sort((a, b) => a.at - b.at).slice(-5)
  }, [state.members, state.board, state.permissions, state.task, state.parts, state.partOrder])

  if (!lines.length) return null
  return (
    <ol className="ticker" aria-label="Últimos acontecimentos">
      {lines.map((l, i) => (
        <li key={`${l.at}-${i}`} className={l.kind ?? ""} style={{ opacity: 0.45 + (0.55 * (i + 1)) / lines.length }}>
          <span className="ticker-time">{clock(l.at)}</span>
          <span className="swatch" style={{ background: l.color }} />
          <span className="ticker-text">{l.text}</span>
        </li>
      ))}
    </ol>
  )
}

function senderColor(state: TaskState, id: string, label?: string) {
  const isLead = id === "main" || id === state.task?.sessionID
  return agentColor(boardLabel(state, id, label), isLead)
}

/* ---------- Painel do agente ---------- */

function AgentPanel({ state, node, onClose, onOpenPost }: { state: TaskState; node: AgentNode; onClose: () => void; onOpenPost: (id: string) => void }) {
  const endRef = useRef<HTMLDivElement>(null)
  const isLead = node.depth === 0
  const now = useNow()()
  const sessions = new Set(node.sessions)
  const parts = state.partOrder
    .map((id) => state.parts[id]!)
    .filter((p) => p && sessions.has(p.sessionID) && (p.type !== "tool" || !QUIET_TOOLS.has(p.tool ?? "")) && (p.type === "tool" || p.text.trim()))
    .filter((p) => p.type === "text" || p.type === "reasoning" || p.type === "tool")
    .slice(-40)
  const posts = [...state.board]
    .filter((b) => {
      const ids = [b.from, b.to]
      return ids.some((id) => sessions.has(id) || (isLead && id === "main") || id === node.agent) || (b.to === "ALL" && !isLead)
    })
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-8)
  const activity = node.sessions
    .map((s) => state.activity[s])
    .filter(Boolean)
    .sort((a, b) => b!.at - a!.at)[0]
  const lastText = parts.length ? parts[parts.length - 1]!.text.length : 0

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" })
  }, [node.id, parts.length, lastText])

  return (
    <aside className="agent-panel" aria-label={`Agente ${node.agent}`}>
      <div className="agent-panel-head">
        <div>
          <div className="h3">
            <span className="swatch" style={{ background: agentColor(node.agent, isLead), width: 10, height: 10 }} />
            {node.agent}
          </div>
          <div className="label" style={{ marginTop: 4 }}>
            {isLead ? "Líder" : `${node.members.length} ${node.members.length === 1 ? "delegação" : "delegações"}`} · {STATE_LABEL[node.state] ?? node.state}
          </div>
        </div>
        <button className="pill quiet small-pill" onClick={onClose} aria-label="Fechar painel">
          Fechar
        </button>
      </div>
      <div className="agent-panel-top">
        {activity && (
          <div className="panel-block">
            <div className="label">Agora</div>
            <div className="small" style={{ marginTop: 6 }}>
              {activity.text} <span className="muted">· há {timeAgo(activity.at, now)}</span>
            </div>
          </div>
        )}

        {isLead ? (
          <div className="panel-block">
            <div className="label">Pedido</div>
            <div className="small" style={{ marginTop: 6 }}>{state.task?.prompt}</div>
          </div>
        ) : (
          <div className="panel-block">
            <div className="label">Recebeu</div>
            {node.members.map((m, i) => (
              <div key={m.callID} className="small round">
                <span className="muted">{node.members.length > 1 ? `${i + 1}ª · ` : ""}</span>
                {m.description}
                <span className="muted">
                  {" · "}
                  {m.endedAt ? `${m.status === "error" ? "falhou" : "entregou"} em ${Math.max(1, Math.round((m.endedAt - m.startedAt) / 1000))}s` : `há ${timeAgo(m.startedAt, now)}`}
                </span>
              </div>
            ))}
          </div>
        )}

      </div>
      <div className="agent-panel-body">
        {posts.length > 0 && (
          <div className="panel-block">
            <div className="label">Board</div>
            {posts.map((b) => (
              <div
                key={b.id}
                className={`panel-post link ${b.type === "VETO" ? "veto" : ""}`}
                role="button"
                tabIndex={0}
                title="Ver o post e o que foi feito"
                onClick={() => onOpenPost(b.id)}
                onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onOpenPost(b.id)}
              >
                <span className={`tag ${b.type === "VETO" ? "alert" : b.type === "ASK" || b.type === "HOLD" ? "solid" : ""}`}>{b.type}</span>
                <span className="small">
                  <strong style={{ color: senderColor(state, b.from, b.fromLabel) }}>{boardLabel(state, b.from, b.fromLabel)}</strong> → {boardLabel(state, b.to, b.toLabel)}: {b.body}
                </span>
              </div>
            ))}
          </div>
        )}

        <div className="panel-block">
          <div className="label">Conversa</div>
          {parts.length === 0 && <div className="small muted" style={{ marginTop: 6 }}>Nada ainda.</div>}
          {parts.map((p) => (
            <PanelPart key={p.id} part={p} state={state} />
          ))}
          <div ref={endRef} />
        </div>
      </div>
    </aside>
  )
}

function PanelPart({ part, state }: { part: ChatPart; state: TaskState }) {
  if (part.type === "tool") {
    const label = part.tool === "task" ? `delegou · ${part.toolTitle ?? ""}` : `${part.tool}${part.toolTitle ? ` · ${part.toolTitle}` : ""}`
    return (
      <div className="tool-line">
        <span className={`dot ${part.toolStatus === "completed" ? "completed" : part.toolStatus === "error" ? "error" : "running"}`} />
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{label}</span>
      </div>
    )
  }
  if (part.type === "reasoning") {
    return (
      <div className="panel-msg">
        <Thinking text={part.text} />
      </div>
    )
  }
  const isUser = part.messageID ? state.messages[part.messageID]?.role === "user" : false
  return (
    <div className={`panel-msg ${isUser ? "user" : ""}`}>
      {isUser && <div className="label">Instrução recebida</div>}
      <Markdown className="small" text={part.text} />
    </div>
  )
}

/* ---------- Post do board ---------- */

/** Folga entre o relógio do harness (timestamp do post) e o do orquestrador (quando a parte chegou). */
const CLOCK_SLACK_MS = 1500

function BoardPostPanel({
  state,
  model,
  post,
  onOpenPost,
  onAgent,
  onClose,
}: {
  state: TaskState
  model: ReturnType<typeof buildSquad>
  post: BoardMessage
  onOpenPost: (id: string) => void
  onAgent: (id: string) => void
  onClose: () => void
}) {
  const posts = useMemo(() => [...state.board].sort((a, b) => a.timestamp - b.timestamp), [state.board])
  const index = posts.findIndex((b) => b.id === post.id)
  // o `from` é a sessão de quem postou; se ela não for desta squad, cai para o nome do agente
  const author = model.resolve(post.from) ?? (post.fromLabel ? model.resolve(post.fromLabel) : undefined)
  const authorNode = author ? model.byId.get(author) : undefined
  const target = post.to === "ALL" ? undefined : (model.resolve(post.to) ?? (post.toLabel ? model.resolve(post.toLabel) : undefined))
  const veto = post.type === "VETO"
  const replyTo = post.reply_to ? posts.find((b) => b.id === post.reply_to) : undefined
  const replies = posts.filter((b) => b.reply_to === post.id)

  // O que o autor fez desde o post anterior dele até este: mensagens, thinking e ferramentas.
  const work = useMemo(() => {
    if (!authorNode) return []
    const sessions = new Set(authorNode.sessions)
    const prev = [...posts.slice(0, Math.max(0, index))].reverse().find((b) => (model.resolve(b.from) ?? model.resolve(b.fromLabel ?? "")) === author)
    const from = prev ? prev.timestamp + CLOCK_SLACK_MS : -Infinity
    const until = post.timestamp + CLOCK_SLACK_MS
    return state.partOrder
      .map((id) => state.parts[id]!)
      .filter((p) => p && sessions.has(p.sessionID) && (p.at ?? 0) > from && (p.at ?? 0) <= until)
      .filter((p) => (p.type === "tool" ? p.tool !== "board_post" && !QUIET_TOOLS.has(p.tool ?? "") : (p.type === "text" || p.type === "reasoning") && p.text.trim()))
      .slice(-30)
  }, [authorNode, author, posts, index, post.timestamp, state.parts, state.partOrder, model])

  const who = (id: string, label?: string) => (
    <strong style={{ color: senderColor(state, id, label) }}>{boardLabel(state, id, label)}</strong>
  )

  return (
    <aside className="agent-panel" aria-label={`Post ${post.type} do board`}>
      <div className="agent-panel-head">
        <div>
          <div className="h3">
            <span className={`tag ${veto ? "alert" : post.type === "ASK" || post.type === "HOLD" ? "solid" : ""}`}>{post.type}</span>
            Post do board
          </div>
          <div className="label" style={{ marginTop: 4 }}>
            {index + 1} de {posts.length} · {clock(post.timestamp)}
          </div>
        </div>
        <span className="panel-nav">
          <button className="pill quiet small-pill" disabled={index <= 0} onClick={() => onOpenPost(posts[index - 1]!.id)} aria-label="Post anterior">
            ‹
          </button>
          <button className="pill quiet small-pill" disabled={index >= posts.length - 1} onClick={() => onOpenPost(posts[index + 1]!.id)} aria-label="Próximo post">
            ›
          </button>
          <button className="pill quiet small-pill" onClick={onClose} aria-label="Fechar painel">
            Fechar
          </button>
        </span>
      </div>
      <div className="agent-panel-top">
        <div className="panel-block">
          <div className="small">
            {who(post.from, post.fromLabel)} → {post.to === "ALL" ? <strong>todos</strong> : who(post.to, post.toLabel)}
          </div>
          {replyTo && (
            <div className="small muted panel-reply link" role="button" tabIndex={0} onClick={() => onOpenPost(replyTo.id)} onKeyDown={(e) => e.key === "Enter" && onOpenPost(replyTo.id)}>
              em resposta a {replyTo.type} de {boardLabel(state, replyTo.from, replyTo.fromLabel)}: {plainOneLine(replyTo.body).slice(0, 80)}
            </div>
          )}
          <div className={`post-full ${veto ? "veto" : ""}`}>
            <Markdown className="small" text={post.body} />
          </div>
          <div className="panel-actions">
            {author && (
              <button className="pill quiet small-pill" onClick={() => onAgent(author)}>
                Ver {authorNode?.agent ?? "autor"}
              </button>
            )}
            {target && target !== author && (
              <button className="pill quiet small-pill" onClick={() => onAgent(target)}>
                Ver {model.byId.get(target)?.agent ?? "destino"}
              </button>
            )}
          </div>
        </div>
      </div>
      <div className="agent-panel-body">
        {replies.length > 0 && (
          <div className="panel-block">
            <div className="label">Respostas</div>
            {replies.map((b) => (
              <div
                key={b.id}
                className={`panel-post link ${b.type === "VETO" ? "veto" : ""}`}
                role="button"
                tabIndex={0}
                onClick={() => onOpenPost(b.id)}
                onKeyDown={(e) => e.key === "Enter" && onOpenPost(b.id)}
              >
                <span className={`tag ${b.type === "VETO" ? "alert" : ""}`}>{b.type}</span>
                <span className="small">
                  {who(b.from, b.fromLabel)}: {plainOneLine(b.body).slice(0, 120)}
                </span>
              </div>
            ))}
          </div>
        )}
        <div className="panel-block">
          <div className="label">O que {authorNode?.agent ?? "o autor"} fez até postar</div>
          {work.length === 0 && <div className="small muted" style={{ marginTop: 6 }}>Nada registrado entre o post anterior deste agente e este.</div>}
          {work.map((p) => (
            <PanelPart key={p.id} part={p} state={state} />
          ))}
        </div>
      </div>
    </aside>
  )
}

/* ---------- Barra do líder ---------- */

function LeadBar({ taskID, state, readOnly }: { taskID: string; state: TaskState; readOnly: boolean }) {
  const root = state.task?.sessionID
  const [text, setText] = useState("")
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()

  let said: string | undefined
  let fullMessage: string | undefined
  for (let i = state.partOrder.length - 1; i >= 0 && !said; i--) {
    const p = state.parts[state.partOrder[i]!]
    if (!p || p.sessionID !== root || p.type !== "text" || !p.text.trim()) continue
    if (p.messageID && state.messages[p.messageID]?.role === "user") continue
    said = plainOneLine(p.text)
    fullMessage = p.messageID
      ? state.partOrder.map((id) => state.parts[id]).filter((part) => part?.messageID === p.messageID && part.type === "text").map((part) => part.text).join("\n\n")
      : p.text
  }

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
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }
  const canSend = !!root && state.task?.status !== "stopped" && state.task?.publication?.status !== "publishing"
  const summary = state.task?.status === "error" ? "Turno interrompido. Confira a falha acima para continuar." : said ?? (state.task?.status === "idle" ? "Turno concluído. Você pode enviar uma nova instrução." : root ? "Planejando…" : state.task?.prompt)
  const leadLabel = <span className="label" style={{ color: agentColor(state.task?.agent, true) }}>{state.task?.agent ?? "líder"}</span>

  return (
    <div className="lead-bar">
      {fullMessage ? (
        <details className="lead-result">
          <summary className="lead-said" aria-label="Expandir ou recolher a última mensagem do líder">
            {leadLabel}
            <span className="small lead-said-text">{summary}</span>
            <span className="lead-result-action small"><span className="when-closed">Ler resultado completo ↓</span><span className="when-open">Recolher ↑</span></span>
          </summary>
          <div className="lead-result-body" tabIndex={0} aria-label="Mensagem completa do líder"><Markdown text={fullMessage} /></div>
        </details>
      ) : <div className="lead-said">{leadLabel}<span className="small lead-said-text">{summary}</span></div>}
      {!readOnly && <div className="lead-compose">
        <input
          className="input"
          aria-label="Mensagem para a squad"
          placeholder={canSend ? "Fale com a squad (Enter envia)" : "Aguardando a sessão iniciar…"}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          disabled={!canSend}
        />
        <button className="pill" onClick={send} disabled={!canSend || sending || !text.trim()}>
          Enviar
        </button>
      </div>}
      {error && <div className="small" style={{ color: "var(--alert)" }}>{error}</div>}
    </div>
  )
}
