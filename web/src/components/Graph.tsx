// Grafo animado da squad: um crachá por agente (líder no topo, subagentes abaixo de quem os delegou),
// na cor de identidade do agente (tema Arena). Arestas ativas levam partículas do pai para o filho.
// Delegar de novo ao mesmo agente reaproveita o nó (o contador ×N mostra as rodadas).
// O espaçamento cresce com a quantidade de nós e o SVG escala para caber; linhas com mais de
// MAX_PER_LINE nós (ou `perLine`) quebram em mais linhas, intercaladas.
// Animações derivadas do stream:
//   - delegação (tool `task` iniciando): pulso do pai para o filho, rótulo "task"
//   - entrega (membro concluiu): pulso do filho para o pai, rótulo "ok"
//   - mensagem no board: pulso do remetente para o destinatário (ALL = todos), rótulo = tipo (INFO/ASK/...)
//   - atividade recente (texto/tool): contorno piscando no crachá por ~2,5s; o crachá mostra a ação atual
//   - balões (opcional): trecho da mensagem ou da tarefa recebida ao lado do nó por alguns segundos

import { useEffect, useMemo, useRef, useState } from "react"
import type { BoardMessage, SquadMember } from "../api"
import { STATE_LABEL, agentColor, buildSquad, type AgentNode, type SquadModel } from "../squad"
import type { TaskState } from "../useTaskStream"
import { useNow } from "../clock"

const HW = 88 // meia largura do crachá
const HH = 26 // meia altura do crachá
const COL = 208 // espaço horizontal mínimo por nó
const ROW = 118
const ROW_BUBBLES = 170 // mais altura entre níveis para caberem balões empilhados
const LINE = 72 // deslocamento da segunda linha quando uma profundidade quebra
const MAX_PER_LINE = 6
const TOP = 40
const TOP_BUBBLES = 92 // espaço para balões acima do líder
const ALERT = "#ff6363"
const PULSE_MS = 1400
const BUBBLE_MS = 5000

interface Placed extends AgentNode {
  x: number
  y: number
  color: string
}

interface Pulse {
  key: string
  from: string
  to: string
  label: string
  kind: "delegate" | "result" | "board" | "veto"
}

interface Bubble {
  key: string
  node: string
  tag: string
  text: string
  kind: "board" | "veto" | "delegate"
}

export function Graph({
  state,
  width = 440,
  selected,
  onSelect,
  bubbles: showBubbles = false,
  perLine = MAX_PER_LINE,
  className = "",
}: {
  state: TaskState
  width?: number
  selected?: string
  onSelect?: (nodeId: string) => void
  bubbles?: boolean
  perLine?: number // máximo de nós por linha antes de quebrar (menor em telas estreitas)
  className?: string
}) {
  const model = useMemo(() => buildSquad(state), [state.task?.sessionID, state.task?.agent, state.task?.status, state.members, state.permissions, state.sessionState])
  const { nodes, W, height } = useMemo(() => layout(model, width, showBubbles ? TOP_BUBBLES : TOP, showBubbles ? ROW_BUBBLES : ROW, perLine), [model, width, showBubbles, perLine])
  const byId = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])
  const { pulses, bubbles } = useFlow(model, state.board, byId)
  const clockNow = useNow()
  const [now, setNow] = useState(clockNow)

  // relógio para expirar os halos de atividade (no replay, o relógio virtual)
  useEffect(() => {
    const t = setInterval(() => setNow(clockNow()), 250)
    return () => clearInterval(t)
  }, [clockNow])

  if (!model.root) {
    return <div className="empty">O grafo aparece quando a sessão da squad iniciar.</div>
  }

  return (
    <svg
      className={`graph ${className}`}
      viewBox={`0 0 ${W} ${height}`}
      style={className.includes("fill") ? undefined : { aspectRatio: `${W} / ${height}` }}
      role="img"
      aria-label="Grafo da squad"
    >
      {/* arestas de delegação; as ativas levam partículas na cor de quem recebe */}
      {nodes.map((n) => {
        const parent = n.parentId && byId.get(n.parentId)
        if (!parent) return null
        const d = treePath(parent, n)
        const live = n.state === "running" || n.state === "waiting"
        return (
          <g key={`e-${n.id}`}>
            <path className={`edge ${live ? "live" : ""}`} d={d} style={{ stroke: n.color }} />
            {live &&
              [0, 0.6, 1.2].map((begin) => (
                <circle key={begin} className="spark" r={2.5} style={{ fill: n.color }}>
                  <animateMotion dur="1.8s" begin={`${begin}s`} repeatCount="indefinite" path={d} />
                </circle>
              ))}
          </g>
        )
      })}

      {/* pulsos na cor de quem envia (VETO em coral) */}
      {pulses.map((p) => {
        const a = byId.get(p.from)
        const b = byId.get(p.to)
        if (!a || !b) return null
        const d = a.depth === b.depth ? arcPath(a, b) : a.depth < b.depth ? treePath(a, b) : reverse(treePath(b, a))
        const color = p.kind === "veto" ? ALERT : a.color
        return (
          <g key={p.key} className={`pulse ${p.kind}`}>
            <path className="pulse-trail" d={d} style={{ stroke: color }} />
            <g>
              <circle r={4.5} style={{ fill: p.kind === "result" ? undefined : color, stroke: color }} />
              <text x={10} y={4} style={{ fill: color }}>
                {p.label}
              </text>
              <animateMotion dur={`${PULSE_MS}ms`} path={d} fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.4 0 0.2 1" />
            </g>
          </g>
        )
      })}

      {/* crachás */}
      {nodes.map((n) => {
        const act = n.sessions
          .map((sid) => state.activity[sid])
          .filter(Boolean)
          .sort((x, y) => y!.at - x!.at)[0]
        const fresh = act && now - act.at < 2500
        const working = n.state === "running" || n.state === "busy"
        const rounds = n.members.length
        const line = working && act ? act.text : (STATE_LABEL[n.state] ?? n.state)
        return (
          <g
            key={n.id}
            transform={`translate(${n.x} ${n.y})`}
            className={`node ${n.state} ${n.depth === 0 ? "lead" : ""} ${selected === n.id ? "selected" : ""} ${onSelect ? "clickable" : ""}`}
            onClick={onSelect ? () => onSelect(n.id) : undefined}
            role={onSelect ? "button" : undefined}
            aria-label={onSelect ? `Abrir ${n.agent}` : undefined}
          >
            {working && <rect className="glow" x={-HW - 5} y={-HH - 5} width={HW * 2 + 10} height={HH * 2 + 10} rx={19} style={{ fill: n.color, opacity: 0.22, filter: "blur(8px)" }} />}
            {selected === n.id && <rect className="ring" x={-HW - 5} y={-HH - 5} width={HW * 2 + 10} height={HH * 2 + 10} rx={19} />}
            <rect className="bg" x={-HW} y={-HH} width={HW * 2} height={HH * 2} rx={14} style={working ? { stroke: n.color, strokeOpacity: 0.6 } : undefined} />
            {fresh && <rect className="halo" x={-HW} y={-HH} width={HW * 2} height={HH * 2} rx={14} style={{ stroke: n.color }} />}
            <circle cx={-HW + 24} r={12} style={{ fill: n.color }} />
            <text className="initial" x={-HW + 24} dy="0.35em" textAnchor="middle">
              {n.state === "completed" ? "✓" : n.agent.slice(0, 2).toUpperCase()}
            </text>
            <text className="name" x={-HW + 44} y={-3}>
              {n.agent}
              {rounds > 1 && (
                <tspan className="rounds" dx={6}>
                  ×{rounds}
                </tspan>
              )}
            </text>
            <text className="act" x={-HW + 44} y={13}>
              {clip(line, 20)}
            </text>
          </g>
        )
      })}

      {/* balões por cima de tudo, acima do nó; empilham quando colidem */}
      {showBubbles &&
        placeBubbles(latestPerNode(bubbles), byId, W).map(({ b, x, y, w, text }) => (
          <g key={b.key} className={`bubble ${b.kind}`} transform={`translate(${x} ${y})`}>
            <rect width={w} height={BUBBLE_H} rx={BUBBLE_H / 2} style={b.kind === "delegate" ? { stroke: byId.get(b.node)?.color } : undefined} />
            <text x={14} y={18}>
              <tspan className="bubble-tag" style={{ fill: b.kind === "veto" ? ALERT : byId.get(b.node)?.color }}>
                {b.tag}
              </tspan>
              <tspan dx={8}>{text}</tspan>
            </text>
          </g>
        ))}
    </svg>
  )
}

const BUBBLE_H = 28

function placeBubbles(list: Bubble[], byId: Map<string, Placed>, W: number) {
  const out: { b: Bubble; x: number; y: number; w: number; text: string }[] = []
  // os outros crachás também são obstáculos (o balão do próprio nó fica acima dele)
  const cards = [...byId.values()].map((n) => ({ id: n.id, x: n.x - HW, y: n.y - HH, w: HW * 2, h: HH * 2 }))
  const sorted = list.map((b) => ({ b, n: byId.get(b.node) })).filter((e): e is { b: Bubble; n: Placed } => !!e.n)
  sorted.sort((a, c) => a.n.y - c.n.y || a.n.x - c.n.x)
  for (const { b, n } of sorted) {
    const text = clip(b.text, 44)
    const w = Math.min(340, 22 + b.tag.length * 7.5 + 8 + text.length * 6.3)
    const x = Math.max(4, Math.min(W - w - 4, n.x - w / 2))
    let y = n.y - HH - 10 - BUBBLE_H
    const hits = (yy: number) =>
      cards.some((c) => c.id !== n.id && x < c.x + c.w && c.x < x + w && yy < c.y + c.h && c.y < yy + BUBBLE_H) ||
      out.some((o) => x < o.x + o.w + 6 && o.x < x + w + 6 && yy < o.y + BUBBLE_H + 4 && o.y < yy + BUBBLE_H + 4)
    while (hits(y)) y -= BUBBLE_H + 6
    out.push({ b, x, y, w, text })
  }
  return out
}

function clip(text: string, max: number) {
  return text.length > max ? text.slice(0, max - 1) + "…" : text
}

function latestPerNode(bubbles: Bubble[]) {
  const map = new Map<string, Bubble>()
  for (const b of bubbles) map.set(b.node, b)
  return [...map.values()]
}

/** Posiciona os nós por profundidade; filhos seguem a ordem horizontal dos pais. */
function layout(model: SquadModel, minWidth: number, top: number, rowGap: number, maxPerLine: number): { nodes: Placed[]; W: number; height: number } {
  if (!model.root) return { nodes: [], W: minWidth, height: top * 2 }
  const rows = new Map<number, AgentNode[]>()
  for (const n of model.nodes) rows.set(n.depth, [...(rows.get(n.depth) ?? []), n])
  const widest = Math.max(1, ...[...rows.values()].map((r) => Math.ceil(r.length / Math.ceil(r.length / maxPerLine))))
  const W = Math.max(minWidth, (widest + 1) * COL)

  const placed = new Map<string, Placed>()
  let y = top
  const depths = [...rows.keys()].sort((a, b) => a - b)
  for (const depth of depths) {
    const row = rows.get(depth)!
    if (depth > 0) {
      const order = new Map(row.map((n, i) => [n.id, i]))
      row.sort((a, b) => (placed.get(a.parentId!)?.x ?? 0) - (placed.get(b.parentId!)?.x ?? 0) || order.get(a.id)! - order.get(b.id)!)
    }
    const lines = Math.ceil(row.length / maxPerLine)
    const perLine = Math.ceil(row.length / lines)
    row.forEach((n, i) => {
      const line = i % lines // intercala: vizinhos vão para linhas diferentes
      const idx = Math.floor(i / lines)
      const count = Math.ceil((row.length - line) / lines) // nós nesta linha
      const step = W / (perLine + 1)
      const offset = lines > 1 ? ((line % 2) - 0.5) * step * 0.5 : 0
      const x = (W - step * (count - 1)) / 2 + idx * step + offset
      placed.set(n.id, { ...n, x, y: y + line * LINE, color: agentColor(n.agent, depth === 0) })
    })
    y += (lines - 1) * LINE + rowGap
  }
  const nodes = [...placed.values()]
  const height = Math.max(...nodes.map((n) => n.y)) + HH + 24
  return { nodes, W, height }
}

function treePath(a: Placed, b: Placed) {
  const y1 = a.y + HH
  const y2 = b.y - HH - 2
  const mid = (y1 + y2) / 2
  return `M ${a.x} ${y1} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${y2}`
}

function arcPath(a: Placed, b: Placed) {
  const mx = (a.x + b.x) / 2
  const lift = Math.min(70, Math.abs(a.x - b.x) / 2 + 20)
  return `M ${a.x} ${a.y - HH} Q ${mx} ${Math.min(a.y, b.y) - HH - lift} ${b.x} ${b.y - HH}`
}

/** Inverte um path "M x y C ..." de uma única curva cúbica. */
function reverse(d: string) {
  const n = d.match(/-?[\d.]+/g)!.map(Number)
  const [x1, y1, c1x, c1y, c2x, c2y, x2, y2] = n
  return `M ${x2} ${y2} C ${c2x} ${c2y}, ${c1x} ${c1y}, ${x1} ${y1}`
}

/** Gera pulsos e balões a partir das mudanças de estado (membros e board) desde o último render. */
function useFlow(model: SquadModel, board: BoardMessage[], byId: Map<string, Placed>) {
  const [pulses, setPulses] = useState<Pulse[]>([])
  const [bubbles, setBubbles] = useState<Bubble[]>([])
  const seenMembers = useRef(new Map<string, string>())
  const seenBoard = useRef(new Set<string>())
  const first = useRef(true)
  const root = model.root

  useEffect(() => {
    if (!root) return
    const add: Pulse[] = []
    const say: Bubble[] = []
    const members: SquadMember[] = model.nodes.flatMap((n) => n.members)
    for (const m of members) {
      const prev = seenMembers.current.get(m.callID)
      const node = model.resolve(m.sessionID!)
      const parent = model.resolve(m.parentSessionID ?? root)
      if (!first.current && node && parent) {
        if (!prev && (m.status === "running" || m.status === "pending")) {
          add.push({ key: `d-${m.callID}`, from: parent, to: node, label: "task", kind: "delegate" })
          if (m.description) say.push({ key: `bd-${m.callID}`, node, tag: "TAREFA", text: m.description, kind: "delegate" })
        }
        if (prev && prev !== "completed" && m.status === "completed")
          add.push({ key: `r-${m.callID}`, from: node, to: parent, label: "ok", kind: "result" })
      }
      seenMembers.current.set(m.callID, m.status)
    }
    for (const msg of [...board].sort((a, b) => a.timestamp - b.timestamp)) {
      if (seenBoard.current.has(msg.id)) continue
      seenBoard.current.add(msg.id)
      if (first.current) continue
      const from = model.resolve(msg.from)
      if (!from) continue
      const targets = msg.to === "ALL" ? [...byId.keys()].filter((id) => id !== from) : [model.resolve(msg.to)].filter((t): t is string => !!t)
      const kind = msg.type === "VETO" ? "veto" : "board"
      for (const to of targets) add.push({ key: `b-${msg.id}-${to}`, from, to, label: msg.type, kind })
      say.push({ key: `bb-${msg.id}`, node: from, tag: msg.type, text: msg.body.replace(/\s+/g, " "), kind })
    }
    first.current = false
    if (add.length) {
      setPulses((p) => [...p, ...add])
      const keys = new Set(add.map((a) => a.key))
      // sem cleanup: o efeito roda a cada evento e não pode cancelar a expiração de pulsos anteriores
      setTimeout(() => setPulses((p) => p.filter((x) => !keys.has(x.key))), PULSE_MS + 400)
    }
    if (say.length) {
      setBubbles((b) => [...b, ...say])
      const keys = new Set(say.map((a) => a.key))
      setTimeout(() => setBubbles((b) => b.filter((x) => !keys.has(x.key))), BUBBLE_MS)
    }
  }, [root, model, board, byId])

  return { pulses, bubbles }
}
