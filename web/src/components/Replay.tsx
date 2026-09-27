// Replay do trabalho da squad (Palco e Escritório): baixa o log de eventos da tarefa e o
// reaplica no mesmo reducer do SSE ao vivo, num relógio virtual com velocidade e pulo de esperas.

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api, type Task, type UiEvent } from "../api"
import { agentColor } from "../squad"
import { replayStart, replayStep, type TaskState } from "../useTaskStream"
import { clock } from "./common"

const SPEEDS = [1, 2, 5, 10, 30]
/** Pulando esperas: silêncio maior que isto (em tempo real de tela) salta para o próximo evento. */
const IDLE_REAL_MS = 1200
const TICK_MS = 50

interface Cursor {
  state: TaskState
  idx: number // próximo evento a aplicar
  time: number // relógio virtual (mesma base de UiEvent.at)
}

export interface Replay {
  loading: boolean
  error?: string
  state?: TaskState
  /** Muda a cada salto na linha do tempo: o Palco remonta para não animar tudo de uma vez. */
  epoch: number
  now: () => number
  t0: number
  tEnd: number
  time: number
  playing: boolean
  speed: number
  skipIdle: boolean
  marks: Mark[]
  events: number
  applied: number
  toggle: () => void
  seek: (time: number) => void
  setSpeed: (s: number) => void
  setSkipIdle: (v: boolean) => void
}

interface Mark {
  at: number
  color: string
  title: string
}

export function useReplay(taskID: string): Replay {
  const [data, setData] = useState<{ task: Task; events: UiEvent[] }>()
  const [error, setError] = useState<string>()
  const [cursor, setCursor] = useState<Cursor>()
  const [epoch, setEpoch] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(5)
  const [skipIdle, setSkipIdle] = useState(true)
  const cur = useRef<Cursor | undefined>(undefined)

  const events = data?.events ?? []
  const t0 = events[0]?.at ?? 0
  const tEnd = events[events.length - 1]?.at ?? t0

  useEffect(() => {
    let off = false
    api
      .replay(taskID)
      .then((d) => {
        if (off) return
        const events = [...d.events].sort((a, b) => a.seq - b.seq)
        const start: Cursor = { state: replayStart(d.task), idx: 0, time: events[0]?.at ?? 0 }
        cur.current = start
        setData({ task: d.task, events })
        setCursor(start)
        setPlaying(events.length > 0)
      })
      .catch((e) => !off && setError(e.message))
    return () => {
      off = true
    }
  }, [taskID])

  const seek = useCallback(
    (time: number) => {
      if (!data) return
      let state = replayStart(data.task)
      let idx = 0
      while (idx < data.events.length && data.events[idx]!.at <= time) state = replayStep(state, data.events[idx++]!)
      cur.current = { state, idx, time }
      setCursor(cur.current)
      setEpoch((e) => e + 1)
    },
    [data],
  )

  useEffect(() => {
    if (!playing || !data) return
    let last = performance.now()
    const timer = setInterval(() => {
      const c = cur.current
      if (!c) return
      const t = performance.now()
      let time = c.time + (t - last) * speed
      last = t
      let { state, idx } = c
      const next = data.events[idx]
      if (skipIdle && next) {
        const prevAt = idx > 0 ? data.events[idx - 1]!.at : t0
        if (time - prevAt > IDLE_REAL_MS * speed && next.at > time) time = next.at
      }
      const before = idx
      while (idx < data.events.length && data.events[idx]!.at <= time) state = replayStep(state, data.events[idx++]!)
      if (idx >= data.events.length) {
        time = tEnd
        setPlaying(false)
      }
      cur.current = { state, idx, time }
      // re-render só quando algo mudou ou a cada ~250ms de relógio (para halos e "há Ns")
      if (idx !== before || idx >= data.events.length || Math.floor(time / 250) !== Math.floor(c.time / 250)) setCursor(cur.current)
    }, TICK_MS)
    return () => clearInterval(timer)
  }, [playing, data, speed, skipIdle, t0, tEnd])

  const toggle = useCallback(() => {
    const c = cur.current
    if (!playing && c && data && c.idx >= data.events.length) seek(t0) // terminou: recomeça
    setPlaying((p) => !p)
  }, [playing, data, seek, t0])

  const marks = useMemo(() => buildMarks(events), [events])
  const now = useCallback(() => cur.current?.time ?? Date.now(), [])

  return {
    loading: !data && !error,
    error,
    state: cursor?.state,
    epoch,
    now,
    t0,
    tEnd,
    time: cursor?.time ?? t0,
    playing,
    speed,
    skipIdle,
    marks,
    events: events.length,
    applied: cursor?.idx ?? 0,
    toggle,
    seek,
    setSpeed,
    setSkipIdle,
  }
}

/** Marcos na linha do tempo: delegações, board, permissões e erros. */
function buildMarks(events: UiEvent[]): Mark[] {
  const out: Mark[] = []
  const seen = new Set<string>()
  for (const e of events) {
    const d = e.data ?? {}
    if (e.kind === "squad.member" && d.callID && !seen.has(d.callID)) {
      seen.add(d.callID)
      out.push({ at: e.at, color: agentColor(d.agent), title: `delegou para ${d.agent}: ${d.description ?? ""}` })
    } else if (e.kind === "board.activity" && d.tool === "board_post" && d.status === "completed") {
      const type = d.input?.type ?? "INFO"
      out.push({ at: e.at, color: type === "VETO" ? "var(--alert)" : "var(--mist)", title: `board · ${type}` })
    } else if (e.kind === "permission.asked") {
      out.push({ at: e.at, color: "var(--wait)", title: `permissão: ${d.permission ?? ""}` })
    } else if (e.kind === "error") {
      out.push({ at: e.at, color: "var(--alert)", title: `erro: ${d.message ?? ""}` })
    }
  }
  return out
}

function duration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, "0")
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`
}

export function ReplayBar({ replay, onExit }: { replay: Replay; onExit: () => void }) {
  const { t0, tEnd, time } = replay
  const span = Math.max(1, tEnd - t0)
  const pct = (at: number) => `${(((at - t0) / span) * 100).toFixed(2)}%`

  return (
    <div className="replay-bar" role="region" aria-label="Replay">
      <span className="tag solid replay-tag">Replay</span>
      <button className="pill small-pill replay-play" onClick={replay.toggle} disabled={!replay.events} aria-label={replay.playing ? "Pausar" : "Reproduzir"}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          {replay.playing ? (
            <path d="M2.5 1.5h2.5v9H2.5zM7 1.5h2.5v9H7z" fill="currentColor" />
          ) : (
            <path d="M3 1.5v9l7.5-4.5z" fill="currentColor" />
          )}
        </svg>
      </button>
      <button className="pill quiet small-pill" onClick={() => replay.seek(t0)} disabled={!replay.events} title="Voltar ao início" aria-label="Voltar ao início">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
          <rect x="1" y="2" width="1.6" height="8" fill="currentColor" />
          <path d="M11 2v8L4 6z" fill="currentColor" />
        </svg>
      </button>
      <span className="replay-time mono small">
        {duration(time - t0)} <span className="muted">/ {duration(span)}</span>
      </span>
      <div className="replay-track">
        <div className="replay-marks" aria-hidden>
          {replay.marks.map((m, i) => (
            <span key={i} className="replay-mark" style={{ left: pct(m.at), background: m.color }} title={`${clock(m.at)} · ${m.title}`} />
          ))}
        </div>
        <input
          type="range"
          className="replay-range"
          min={t0}
          max={tEnd || t0 + 1}
          step={100}
          value={time}
          onChange={(e) => replay.seek(Number(e.target.value))}
          aria-label="Posição no replay"
          aria-valuetext={duration(time - t0)}
        />
      </div>
      <span className="chat-scope" role="group" aria-label="Velocidade">
        {SPEEDS.map((s) => (
          <button key={s} className={replay.speed === s ? "on" : ""} onClick={() => replay.setSpeed(s)}>
            {s}×
          </button>
        ))}
      </span>
      <label className="replay-skip small muted" title="Salta os períodos em que ninguém fez nada (esperando o modelo, por exemplo)">
        <input type="checkbox" checked={replay.skipIdle} onChange={(e) => replay.setSkipIdle(e.target.checked)} />
        Pular esperas
      </label>
      <span className="replay-clock label" title="Hora original do acontecimento">{clock(time)}</span>
      <button className="pill quiet small-pill" onClick={onExit}>
        Voltar ao vivo
      </button>
    </div>
  )
}
