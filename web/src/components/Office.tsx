// Modo Escritório: a squad em pixel art (motor em ../office/engine.ts).
import { useEffect, useMemo, useRef } from "react"
import { OfficeEngine, type OfficeInput } from "../office/engine"
import { agentColor, buildSquad } from "../squad"
import type { TaskState } from "../useTaskStream"
import { useNow } from "../clock"

export function Office({
  state,
  selected,
  selectedPost,
  onSelect,
  onBoard,
}: {
  state: TaskState
  selected?: string
  selectedPost?: string
  onSelect: (id: string) => void
  onBoard: (messageID: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const engineRef = useRef<OfficeEngine | undefined>(undefined)
  const selectRef = useRef(onSelect)
  selectRef.current = onSelect
  const boardRef = useRef(onBoard)
  boardRef.current = onBoard
  const now = useNow()

  const model = useMemo(() => buildSquad(state), [state.task?.sessionID, state.task?.agent, state.members, state.permissions, state.sessionState])

  useEffect(() => {
    const engine = new OfficeEngine(
      canvasRef.current!,
      (id) => selectRef.current(id),
      (id) => boardRef.current(id),
    )
    engineRef.current = engine
    engine.start()
    return () => engine.stop()
  }, [])

  useEffect(() => {
    const engine = engineRef.current
    if (!engine) return
    const colors = new Map(model.nodes.map((n) => [n.id, agentColor(n.agent, n.id === model.root)]))
    const retrying = new Map<string, number>()
    for (const [sid, r] of Object.entries(state.retry)) {
      const id = model.resolve(sid)
      if (id) retrying.set(id, r.attempt ?? 1)
    }
    const activity = new Map<string, string>()
    for (const n of model.nodes) {
      const last = n.sessions.map((s) => state.activity[s]).filter(Boolean).sort((a, b) => b!.at - a!.at)[0]
      if (last) activity.set(n.id, last.text)
    }
    const input: OfficeInput = {
      root: model.root,
      nodes: model.nodes,
      colors,
      resolve: model.resolve,
      board: state.board,
      working: new Set(model.nodes.filter((n) => n.state === "running" || n.state === "busy").map((n) => n.id)),
      waiting: new Set(model.nodes.filter((n) => n.state === "waiting").map((n) => n.id)),
      retrying,
      activity,
      selected,
      selectedPost,
      now,
      stats: {
        members: model.nodes.length - 1,
        done: model.nodes.filter((n) => n.id !== model.root && n.state === "completed").length,
        posts: state.board.length,
        vetos: state.board.filter((b) => b.type === "VETO").length,
      },
    }
    engine.update(input)
  }, [model, state.board, state.retry, state.activity, selected, selectedPost, now])

  return <canvas ref={canvasRef} className="office" role="img" aria-label="Escritório da squad em pixel art" />
}
