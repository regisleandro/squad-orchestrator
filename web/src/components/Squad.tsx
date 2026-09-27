import type { SquadMember } from "../api"
import type { TaskState } from "../useTaskStream"
import { StatusDot, timeAgo } from "./common"
import { Graph } from "./Graph"
import { agentColor } from "../squad"

const STATE_LABEL: Record<string, string> = {
  pending: "Na fila",
  running: "Trabalhando",
  completed: "Entregou",
  error: "Falhou",
  waiting: "Aguardando você",
  busy: "Trabalhando",
  idle: "Ocioso",
  retry: "Tentando de novo",
}

export function Squad({ state }: { state: TaskState }) {
  const root = state.task?.sessionID
  const members = Object.values(state.members).sort((a, b) => a.startedAt - b.startedAt)
  const waitingSessions = new Set(Object.values(state.permissions).map((p) => p.sessionID))
  const childrenOf = (sessionID?: string) => members.filter((m) => (m.parentSessionID ?? root) === sessionID)

  const leadState = root && waitingSessions.has(root) ? "waiting" : root ? (state.sessionState[root] ?? "busy") : "pending"
  const active = members.filter((m) => m.status === "running").length

  return (
    <>
      <div className="col-head">
        <span className="label">Squad</span>
        <span className="label">
          {members.length} membros · {active} ativos
        </span>
      </div>
      <div className="col-body">
        <Graph state={state} perLine={1} />
        <div className="label" style={{ margin: "8px 0 12px" }}>Detalhes</div>
        <div className="member lead">
          <div className="member-head">
            <span className="member-name">
              <StatusDot status={leadState} />
              {state.task?.agent ?? "líder"}
            </span>
            <span className="label">Líder · {STATE_LABEL[leadState] ?? leadState}</span>
          </div>
          <div className="small muted" style={{ marginTop: 8 }}>
            {(root && state.activity[root]?.text) || "Planejando…"}
          </div>
        </div>

        {members.length === 0 ? (
          <div className="empty" style={{ marginTop: 16 }}>
            Os membros aparecem aqui quando o líder delegar trabalho com a tool <span className="mono">task</span>.
          </div>
        ) : (
          <div className="tree">
            <MemberTree list={childrenOf(root)} childrenOf={childrenOf} state={state} waiting={waitingSessions} />
          </div>
        )}
      </div>
    </>
  )
}

function MemberTree(props: {
  list: SquadMember[]
  childrenOf: (sessionID?: string) => SquadMember[]
  state: TaskState
  waiting: Set<string>
}) {
  const { list, childrenOf, state, waiting } = props
  return (
    <>
      {list.map((m) => {
        const st = m.sessionID && waiting.has(m.sessionID) ? "waiting" : m.status
        const kids = m.sessionID ? childrenOf(m.sessionID) : []
        const activity = m.sessionID ? state.activity[m.sessionID] : undefined
        return (
          <div key={m.callID}>
            <div className="member">
              <div className="member-head">
                <span className="member-name">
                  <StatusDot status={st} />
                  <span style={{ color: agentColor(m.agent) }}>{m.agent}</span>
                </span>
                <span className="label">{STATE_LABEL[st] ?? st}</span>
              </div>
              <div className="small" style={{ marginTop: 8 }}>
                {m.description}
              </div>
              <div className="small muted" style={{ marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {activity ? activity.text : "—"}
                {" · "}
                {m.endedAt ? `levou ${Math.max(1, Math.round((m.endedAt - m.startedAt) / 1000))}s` : `há ${timeAgo(m.startedAt)}`}
              </div>
            </div>
            {kids.length > 0 && (
              <div className="tree">
                <MemberTree {...props} list={kids} />
              </div>
            )}
          </div>
        )
      })}
    </>
  )
}
