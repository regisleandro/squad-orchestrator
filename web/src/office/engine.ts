// Motor do modo Escritório: um canvas em pixel art com um personagem por agente.
// Recebe o estado da tarefa a cada render (update) e transforma as mudanças em cenas:
//   - delegação: quem delegou caminha até a baia do novo membro e entrega a tarefa num balão
//   - board para alguém: o remetente caminha até a baia (ou sala do líder) e fala; para ALL, vai ao quadro
//   - todo post vira um post-it no quadro, na cor de quem postou (VETO em coral)
//   - trabalhando: sentado digitando, monitor aceso; esperando você: "!" âmbar; tentando de novo: vai ao café
//   - clicar num post-it abre o post (onBoard); na parede, relógio (hora do evento no replay), placar da squad,
//     rack que pisca quando alguém trabalha e janelas que seguem a hora do dia
// Ritmo: cada personagem tem uma fila. Se ela cresce (rajada de eventos), as caminhadas são puladas e
// só o balão aparece, para a animação não ficar minutos atrás do que acontece de verdade.

import type { BoardMessage } from "../api"
import type { AgentNode } from "../squad"
import { IDLE, SIT_FRONT, SPRITE_H, SPRITE_W, WALK, drawGrid, hash, palette, shade, type Palette } from "./sprites"

export interface OfficeInput {
  root?: string
  nodes: AgentNode[]
  colors: Map<string, string>
  resolve: (id: string) => string | undefined
  board: BoardMessage[]
  working: Set<string> // ids de nó
  waiting: Set<string>
  retrying: Map<string, number> // id de nó -> tentativa
  activity: Map<string, string> // id de nó -> texto da ação atual
  selected?: string
  selectedPost?: string // id da mensagem do board aberta no painel
  now?: () => number // relógio da tela (virtual no replay)
  stats?: { members: number; done: number; posts: number; vetos: number }
}

interface Pt {
  x: number
  y: number
}

type Action =
  | { k: "walk"; to: Pt }
  | { k: "say"; tag: string; text: string; color: string; ms: number; postit?: PostIt }
  | { k: "home" }

interface Bubble {
  tag: string
  text: string
  color: string
  until: number
}

interface Actor {
  id: string
  agent: string
  color: string
  pal: Palette
  x: number
  y: number
  path: Pt[]
  facing: 1 | -1
  queue: Action[]
  current?: Action
  waitUntil: number
  bubble?: Bubble
  walking: boolean
}

interface Desk {
  id: string
  x: number // canto superior esquerdo da baia
  y: number
  seat: Pt
  visit: Pt
}

interface PostIt {
  id: string
  color: string
  veto: boolean
  type: string
  text: string
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

const W = 400
const TOP = 112 // começo das baias
const DESK_W = 60
const DESK_H = 58
const PER_ROW = 6
const CORRIDOR = 104
const SPEED = 95 // px lógicos por segundo
const FONT = "Silkscreen, 'Press Start 2P', monospace"
const LEAD_SEAT: Pt = { x: 200, y: 70 }
const LEAD_VISIT: Pt = { x: 172, y: 86 }
const LEAD_SIDE = 232 // corredor lateral dentro da sala do líder
const BOARD_SPOT: Pt = { x: 331, y: 58 }
// quadro na parede: 11 post-its por linha, 3 linhas
const BOARD_RECT: Rect = { x: 272, y: 3, w: 118, h: 35 }
const POSTIT_COLS = 11
const POSTIT_ROWS = 3
const MAX_POSTITS = POSTIT_COLS * POSTIT_ROWS
const COFFEE_SPOT: Pt = { x: 40, y: 72 }
const DOOR: Pt = { x: 200, y: 98 }

export class OfficeEngine {
  private ctx: CanvasRenderingContext2D
  private actors = new Map<string, Actor>()
  private desks = new Map<string, Desk>()
  private input?: OfficeInput
  private seenMembers = new Map<string, string>()
  private seenBoard = new Set<string>()
  private postits: PostIt[] = []
  private first = true
  private raf = 0
  private last = 0
  private scale = 2
  private offX = 0
  private offY = 0
  private H = 250
  private frame = 0
  private drawn: { x: number; y: number; w: number; h: number }[] = []
  private postitRects: (Rect & { id: string })[] = []
  private hoverPost?: string
  private steam: { x: number; y: number; life: number }[] = []

  constructor(
    private canvas: HTMLCanvasElement,
    private onSelect: (id: string) => void,
    private onBoard: (messageID: string) => void = () => {},
  ) {
    this.ctx = canvas.getContext("2d")!
    canvas.addEventListener("click", this.onClick)
    canvas.addEventListener("mousemove", this.onMove)
    canvas.addEventListener("mouseleave", this.onLeave)
  }

  start() {
    const loop = (t: number) => {
      const dt = this.last ? Math.min(0.1, (t - this.last) / 1000) : 0
      this.last = t
      this.tick(dt, t)
      this.draw(t)
      this.raf = requestAnimationFrame(loop)
    }
    this.raf = requestAnimationFrame(loop)
  }

  stop() {
    cancelAnimationFrame(this.raf)
    this.canvas.removeEventListener("click", this.onClick)
    this.canvas.removeEventListener("mousemove", this.onMove)
    this.canvas.removeEventListener("mouseleave", this.onLeave)
  }

  /** Chamado a cada render do React com o estado atual. */
  update(input: OfficeInput) {
    this.input = input
    this.layout(input)
    this.syncActors(input)
    this.detect(input)
    this.first = false
  }

  // ---------- layout ----------

  private layout(input: OfficeInput) {
    const members = input.nodes.filter((n) => n.id !== input.root)
    const rows = Math.max(1, Math.ceil(members.length / PER_ROW))
    this.H = TOP + rows * (DESK_H + 8) + 10
    this.desks.clear()
    members.forEach((n, i) => {
      const row = Math.floor(i / PER_ROW)
      const inRow = Math.min(PER_ROW, members.length - row * PER_ROW)
      const gap = 4
      const total = inRow * DESK_W + (inRow - 1) * gap
      const x = Math.round((W - total) / 2 + (i % PER_ROW) * (DESK_W + gap))
      const y = TOP + row * (DESK_H + 8)
      // baia aberta para o corredor (em cima); o agente senta atrás da mesa, de frente
      this.desks.set(n.id, { id: n.id, x, y, seat: { x: x + DESK_W / 2, y: y + 30 }, visit: { x: x + DESK_W / 2 + 18, y: y + 20 } })
    })
  }

  private home(a: Actor): Pt {
    const input = this.input
    if (input?.retrying.has(a.id)) return COFFEE_SPOT
    if (a.id === input?.root) return LEAD_SEAT
    return this.desks.get(a.id)?.seat ?? DOOR
  }

  private visitSpot(id: string): Pt | undefined {
    if (id === this.input?.root) return LEAD_VISIT
    return this.desks.get(id)?.visit
  }

  private syncActors(input: OfficeInput) {
    for (const n of input.nodes) {
      if (this.actors.has(n.id)) continue
      const color = input.colors.get(n.id) ?? "#e6e6e6"
      const seed = hash(n.agent)
      const actor: Actor = {
        id: n.id,
        agent: n.agent,
        color,
        pal: palette(color, seed),
        x: 0,
        y: 0,
        path: [],
        facing: 1,
        queue: [],
        waitUntil: 0,
        walking: false,
      }
      const h = this.home(actor)
      // quem chega depois do começo entra pela porta e vai até a baia
      const spawn = this.first ? h : DOOR
      actor.x = spawn.x
      actor.y = spawn.y
      this.actors.set(n.id, actor)
    }
  }

  // ---------- eventos -> cenas ----------

  private detect(input: OfficeInput) {
    const root = input.root
    if (!root) return
    for (const n of input.nodes) {
      for (const m of n.members) {
        const prev = this.seenMembers.get(m.callID)
        this.seenMembers.set(m.callID, m.status)
        if (this.first || prev) continue
        const parent = input.resolve(m.parentSessionID ?? root) ?? root
        const to = this.desks.get(n.id)?.visit
        if (to) this.scene(parent, to, { tag: "TAREFA", text: m.description, color: input.colors.get(n.id) ?? "#e6e6e6", ms: 1800 })
      }
    }
    for (const msg of [...input.board].sort((a, b) => a.timestamp - b.timestamp)) {
      if (this.seenBoard.has(msg.id)) continue
      this.seenBoard.add(msg.id)
      const from = input.resolve(msg.from)
      const veto = msg.type === "VETO"
      const color = input.colors.get(from ?? "") ?? "#e6e6e6"
      const postit: PostIt = { id: msg.id, color: veto ? "#ff6363" : color, veto, type: msg.type, text: msg.body }
      if (this.first || !from) {
        this.addPostit(postit)
        continue
      }
      const target = msg.to === "ALL" ? undefined : input.resolve(msg.to)
      const spot = target ? this.visitSpot(target) : BOARD_SPOT
      this.scene(from, spot ?? BOARD_SPOT, { tag: msg.type, text: msg.body, color: veto ? "#ff6363" : color, ms: 2000, postit })
    }
  }

  private scene(actorId: string, to: Pt, say: { tag: string; text: string; color: string; ms: number; postit?: PostIt }) {
    const a = this.actors.get(actorId)
    if (!a) {
      if (say.postit) this.addPostit(say.postit)
      return
    }
    // Atrasado (já há uma cena na fila): fala de onde está, sem caminhar e mais rápido.
    // Muito atrasado: descarta falas antigas e fica só com as mais recentes.
    if (a.queue.length > 8) a.queue.splice(0, a.queue.length - 4)
    if (a.queue.length > 2 || a.current) {
      a.queue.push({ k: "say", ...say, ms: 1300 })
      return
    }
    a.queue.push({ k: "walk", to }, { k: "say", ...say }, { k: "home" })
  }

  private addPostit(p: PostIt) {
    if (this.postits.some((x) => x.id === p.id)) return
    this.postits.push(p)
    if (this.postits.length > MAX_POSTITS) this.postits.shift()
  }

  // ---------- simulação ----------

  private tick(dt: number, now: number) {
    // vapor do café enquanto alguém espera lá (tentando de novo)
    if (this.input?.retrying.size && Math.random() < dt * 6) this.steam.push({ x: 36 + Math.random() * 6, y: 43, life: 1 })
    for (const p of this.steam) {
      p.life -= dt * 0.8
      p.y -= dt * 9
      p.x += Math.sin((p.life + p.y) * 6) * dt * 4
    }
    this.steam = this.steam.filter((p) => p.life > 0)
    for (const a of this.actors.values()) {
      if (!a.current) {
        a.current = a.queue.shift()
        if (!a.current) {
          const h = this.home(a)
          if (Math.hypot(a.x - h.x, a.y - h.y) > 1 && !a.path.length) a.current = { k: "home" }
        }
        if (a.current) this.begin(a, now)
      }
      if (a.path.length) {
        const target = a.path[0]!
        const dx = target.x - a.x
        const dy = target.y - a.y
        const dist = Math.hypot(dx, dy)
        const step = SPEED * dt * (a.queue.length > 0 ? 1.7 : 1)
        if (Math.abs(dx) > 0.5) a.facing = dx > 0 ? 1 : -1
        if (dist <= step) {
          a.x = target.x
          a.y = target.y
          a.path.shift()
        } else {
          a.x += (dx / dist) * step
          a.y += (dy / dist) * step
        }
        a.walking = a.path.length > 0
        if (!a.path.length && (a.current?.k === "walk" || a.current?.k === "home")) a.current = undefined
      } else if (a.current?.k === "say" && now >= a.waitUntil) {
        a.current = undefined
      }
    }
  }

  private begin(a: Actor, now: number) {
    const act = a.current!
    if (act.k === "walk") a.path = route(a, act.to)
    else if (act.k === "home") a.path = route(a, this.home(a))
    else {
      a.bubble = { tag: act.tag, text: act.text, color: act.color, until: now + act.ms }
      a.waitUntil = now + act.ms
      if (act.postit) this.addPostit(act.postit)
    }
    if ((act.k === "walk" || act.k === "home") && !a.path.length) a.current = undefined
  }

  // ---------- desenho ----------

  private draw(now: number) {
    const canvas = this.canvas
    const dpr = window.devicePixelRatio || 1
    const cw = canvas.clientWidth
    const chh = canvas.clientHeight
    if (!cw || !chh) return
    if (canvas.width !== Math.round(cw * dpr) || canvas.height !== Math.round(chh * dpr)) {
      canvas.width = Math.round(cw * dpr)
      canvas.height = Math.round(chh * dpr)
    }
    const fit = Math.min(cw / W, chh / this.H)
    this.scale = fit
    this.offX = Math.round((cw - W * this.scale) / 2)
    this.offY = Math.round((chh - this.H * this.scale) / 2)
    const ctx = this.ctx
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.setTransform(this.scale * dpr, 0, 0, this.scale * dpr, this.offX * dpr, this.offY * dpr)
    ctx.imageSmoothingEnabled = false
    this.frame = Math.floor(now / 180)

    this.drawRoom()
    for (const d of this.desks.values()) this.drawCubicle(d)
    // personagens em ordem de profundidade; as mesas vêm depois e cobrem as pernas de quem está sentado
    const actors = [...this.actors.values()].sort((a, b) => a.y - b.y)
    for (const a of actors) this.drawActor(a, now)
    const root = this.input?.root
    this.drawDeskFront(186, 66, root ? this.input!.working.has(root) : false, "#e6e6e6")
    for (const d of this.desks.values()) this.drawDeskFront(d.x + 16, d.y + 26, this.input!.working.has(d.id), this.input!.colors.get(d.id) ?? "#e6e6e6")
    for (const d of this.desks.values()) this.drawNameplate(d)
    this.drawn = []
    for (const a of actors) this.drawOverlay(a, now)
    this.drawPostitHover()
  }

  private drawRoom() {
    const ctx = this.ctx
    const H = this.H
    // piso de tábuas
    ctx.fillStyle = "#15171b"
    ctx.fillRect(0, 0, W, H)
    for (let y = 40; y < H; y += 8) {
      ctx.fillStyle = y % 16 ? "#191b20" : "#17191d"
      ctx.fillRect(0, y, W, 8)
      ctx.fillStyle = "#0f1013"
      for (let x = (y / 8) % 2 ? 0 : 24; x < W; x += 48) ctx.fillRect(x, y, 1, 8)
    }
    // parede
    ctx.fillStyle = "#0b0c0f"
    ctx.fillRect(0, 0, W, 40)
    ctx.fillStyle = "#1b1c1e"
    ctx.fillRect(0, 38, W, 2)
    const now = this.input?.now?.() ?? Date.now()
    const hour = new Date(now).getHours() + new Date(now).getMinutes() / 60
    this.drawRack()
    this.drawShelf(30, 10)
    for (const x of [70, 110]) this.drawWindow(x, hour)
    this.drawScoreboard(150, 6)
    this.drawClock(243, 19, now)
    // sala do líder (vidro) com tapete
    ctx.fillStyle = "#101216"
    ctx.fillRect(150, 40, 100, 56)
    ctx.fillStyle = "#1d1a2a"
    ctx.fillRect(170, 76, 60, 16)
    ctx.fillStyle = "#28233b"
    ctx.fillRect(172, 78, 56, 12)
    ctx.fillStyle = "#1d1a2a"
    for (let x = 176; x < 226; x += 6) ctx.fillRect(x, 83, 3, 2)
    ctx.fillStyle = "rgba(230,230,230,0.25)"
    ctx.fillRect(150, 40, 1, 56)
    ctx.fillRect(249, 40, 1, 56)
    ctx.fillRect(150, 95, 40, 1)
    ctx.fillRect(210, 95, 40, 1)
    this.label("SALA DO LÍDER", 153, 45, "#6a6b6c", 5)
    this.drawWhiteboard()
    // máquina de café + planta
    ctx.fillStyle = "#2f3031"
    ctx.fillRect(28, 44, 20, 22)
    ctx.fillStyle = "#454647"
    ctx.fillRect(30, 46, 16, 6)
    ctx.fillStyle = "#ff6363"
    ctx.fillRect(43, 48, 2, 2)
    ctx.fillStyle = "#e6e6e6"
    ctx.fillRect(35, 58, 5, 5)
    this.label("CAFÉ", 29, 70, "#6a6b6c", 5)
    this.drawPlant(8, 50)
    this.drawPlant(388, 50)
    this.drawPlant(258, 50)
    for (const p of this.steam) {
      ctx.fillStyle = `rgba(230,230,230,${(p.life * 0.5).toFixed(2)})`
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1)
    }
  }

  private drawWindow(x: number, hour: number) {
    const ctx = this.ctx
    const night = hour < 6 || hour >= 19
    const dusk = !night && (hour < 7.5 || hour >= 17.5)
    ctx.fillStyle = "#1a2a44"
    ctx.fillRect(x, 8, 28, 20)
    ctx.fillStyle = night ? "#0e1a30" : dusk ? "#8a4f5c" : "#4f86c6"
    ctx.fillRect(x + 2, 10, 11, 16)
    ctx.fillRect(x + 15, 10, 11, 16)
    if (night) {
      ctx.fillStyle = "#e6e6e6"
      ctx.fillRect(x + 4, 12, 1, 1)
      ctx.fillRect(x + 20, 15, 1, 1)
      ctx.fillRect(x + 9, 20, 1, 1)
    } else {
      // nuvem e prédios
      ctx.fillStyle = dusk ? "#c98a6b" : "#dbe8f5"
      ctx.fillRect(x + 4, 13, 6, 2)
      ctx.fillRect(x + 17, 16, 5, 2)
      ctx.fillStyle = dusk ? "#3a2a3a" : "#2c4a78"
      ctx.fillRect(x + 3, 21, 4, 5)
      ctx.fillRect(x + 8, 19, 3, 7)
      ctx.fillRect(x + 16, 22, 5, 4)
      ctx.fillRect(x + 22, 20, 3, 6)
    }
  }

  /** Rack de servidores: LEDs piscam mais quando alguém da squad está trabalhando. */
  private drawRack() {
    const ctx = this.ctx
    const busy = this.input?.working.size ?? 0
    ctx.fillStyle = "#1b1c1e"
    ctx.fillRect(8, 4, 16, 34)
    ctx.fillStyle = "#111214"
    for (let i = 0; i < 5; i++) {
      const y = 6 + i * 6
      ctx.fillStyle = "#26282b"
      ctx.fillRect(10, y, 12, 5)
      const on = busy ? (this.frame + i * 3) % (5 - Math.min(3, busy)) === 0 : i === 0 && this.frame % 8 < 4
      ctx.fillStyle = on ? "#59d499" : "#20452f"
      ctx.fillRect(12, y + 2, 1, 1)
      ctx.fillStyle = busy && (this.frame + i) % 3 === 0 ? "#ffb829" : "#3a3b3c"
      ctx.fillRect(14, y + 2, 1, 1)
      ctx.fillStyle = "#3a3b3c"
      ctx.fillRect(17, y + 2, 4, 1)
    }
  }

  private drawShelf(x: number, y: number) {
    const ctx = this.ctx
    ctx.fillStyle = "#3b2a20"
    ctx.fillRect(x, y, 32, 2)
    ctx.fillRect(x, y + 13, 32, 2)
    ctx.fillRect(x, y + 26, 32, 2)
    const books = ["#7c5cff", "#ff6363", "#59d499", "#ffb829", "#6ea8ff", "#e6e6e6", "#c77dff"]
    for (let shelf = 0; shelf < 2; shelf++) {
      let bx = x + 2
      for (let i = 0; bx < x + 30; i++) {
        const w = 2 + ((i * 7 + shelf * 3) % 3)
        const h = 8 + ((i * 5 + shelf) % 4)
        ctx.fillStyle = shade(books[(i + shelf * 2) % books.length]!, -0.25)
        ctx.fillRect(bx, y + 13 * (shelf + 1) - h, Math.min(w, x + 30 - bx), h)
        bx += w + 1
      }
    }
  }

  /** Placar da squad na parede: membros concluídos, posts no board e VETOs. */
  private drawScoreboard(x: number, y: number) {
    const ctx = this.ctx
    const st = this.input?.stats
    ctx.fillStyle = "#26282b"
    ctx.fillRect(x, y, 78, 28)
    ctx.fillStyle = "#07080a"
    ctx.fillRect(x + 2, y + 2, 74, 24)
    if (!st) return
    const working = this.input?.working.size ?? 0
    this.label("SQUAD", x + 5, y + 9, "#6a6b6c", 5)
    this.label(`${st.done}/${st.members} ✓`, x + 32, y + 9, st.members && st.done === st.members ? "#59d499" : "#e6e6e6", 5)
    this.label("BOARD", x + 5, y + 17, "#6a6b6c", 5)
    this.label(String(st.posts), x + 32, y + 17, "#e6e6e6", 5)
    if (st.vetos) this.label(`VETO ${st.vetos}`, x + 46, y + 17, "#ff6363", 5)
    this.label(working ? `${working} TRABALHANDO` : "OCIOSO", x + 5, y + 24, working ? "#ffb829" : "#454647", 5)
    if (working && this.frame % 4 < 2) {
      ctx.fillStyle = "#ffb829"
      ctx.fillRect(x + 71, y + 20, 2, 2)
    }
  }

  private drawClock(cx: number, cy: number, now: number) {
    const ctx = this.ctx
    const d = new Date(now)
    ctx.fillStyle = "#454647"
    ctx.beginPath()
    ctx.arc(cx, cy, 9, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "#f3f1ed"
    ctx.beginPath()
    ctx.arc(cx, cy, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = "#6a6b6c"
    for (let i = 0; i < 12; i += 3) {
      const a = (i / 12) * Math.PI * 2
      ctx.fillRect(Math.round(cx + Math.sin(a) * 6.5), Math.round(cy - Math.cos(a) * 6.5), 1, 1)
    }
    const hand = (angle: number, len: number, color: string) => {
      ctx.strokeStyle = color
      ctx.lineWidth = 1
      ctx.beginPath()
      ctx.moveTo(cx + 0.5, cy + 0.5)
      ctx.lineTo(cx + 0.5 + Math.sin(angle) * len, cy + 0.5 - Math.cos(angle) * len)
      ctx.stroke()
    }
    const min = d.getMinutes() + d.getSeconds() / 60
    hand(((d.getHours() % 12) + min / 60) * (Math.PI / 6), 3.5, "#07080a")
    hand(min * (Math.PI / 30), 5.5, "#07080a")
    hand(d.getSeconds() * (Math.PI / 30), 6, "#ff6363")
  }

  /** Quadro do board: um post-it por mensagem, na cor de quem postou; clicável. */
  private drawWhiteboard() {
    const ctx = this.ctx
    const b = BOARD_RECT
    ctx.fillStyle = "#d8d4d4"
    ctx.fillRect(b.x, b.y, b.w, b.h)
    ctx.fillStyle = "#f3f1ed"
    ctx.fillRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4)
    ctx.fillStyle = "#b9b4b4"
    ctx.fillRect(b.x + 30, b.y + b.h, 58, 2) // bandeja das canetas
    ctx.fillStyle = "#ff6363"
    ctx.fillRect(b.x + 36, b.y + b.h, 5, 1)
    ctx.fillStyle = "#6ea8ff"
    ctx.fillRect(b.x + 44, b.y + b.h, 5, 1)
    this.postitRects = []
    const selected = this.input?.selectedPost
    this.postits.forEach((p, i) => {
      const x = b.x + 5 + (i % POSTIT_COLS) * 10
      const y = b.y + 4 + Math.floor(i / POSTIT_COLS) * 10
      const lit = p.id === selected || p.id === this.hoverPost
      if (lit) {
        ctx.fillStyle = p.id === selected ? "#040506" : "#6a6b6c"
        ctx.fillRect(x - 1, y - 1, 10, 10)
      }
      ctx.fillStyle = p.color
      ctx.fillRect(x, y, 8, 7)
      ctx.fillStyle = shade(p.color, -0.35)
      ctx.fillRect(x, y + 7, 8, 1)
      // "texto" rabiscado; VETO ganha um X
      ctx.fillStyle = shade(p.color, -0.55)
      if (p.veto) {
        for (let k = 0; k < 5; k++) {
          ctx.fillRect(x + 1 + k, y + 1 + k, 1, 1)
          ctx.fillRect(x + 5 - k, y + 1 + k, 1, 1)
        }
      } else {
        ctx.fillRect(x + 1, y + 2, 6, 1)
        ctx.fillRect(x + 1, y + 4, 4, 1)
      }
      this.postitRects.push({ id: p.id, x: x - 1, y: y - 1, w: 10, h: 10 })
    })
  }

  private drawPostitHover() {
    const id = this.hoverPost
    if (!id) return
    const r = this.postitRects.find((p) => p.id === id)
    const p = this.postits.find((x) => x.id === id)
    if (!r || !p) return
    this.bubble(r.x + r.w / 2, r.y + r.h + 13, p.type, p.text, p.veto ? "#ff6363" : p.color)
  }

  private drawPlant(x: number, y: number) {
    const ctx = this.ctx
    ctx.fillStyle = "#6b3b2a"
    ctx.fillRect(x, y + 10, 8, 7)
    ctx.fillStyle = "#3c8d5a"
    ctx.fillRect(x - 1, y + 2, 10, 8)
    ctx.fillStyle = "#59d499"
    ctx.fillRect(x + 1, y, 3, 5)
    ctx.fillRect(x + 5, y + 3, 3, 4)
  }

  /** Mesa vista de frente: tampo na altura da cintura e monitor de costas, com o brilho da tela quando trabalha. */
  private drawDeskFront(x: number, y: number, on: boolean, color: string) {
    const ctx = this.ctx
    // monitor de costas, à esquerda
    ctx.fillStyle = "#1b1c1e"
    ctx.fillRect(x - 2, y - 10, 12, 10)
    if (on) {
      ctx.fillStyle = this.frame % 4 === 0 ? shade(color, -0.3) : color
      ctx.fillRect(x - 3, y - 11, 14, 1)
      ctx.fillRect(x - 3, y - 11, 1, 10)
      ctx.fillRect(x + 10, y - 11, 1, 10)
    }
    ctx.fillStyle = "#2f3031"
    ctx.fillRect(x + 2, y, 4, 1)
    // tampo e frente da mesa
    ctx.fillStyle = "#6e4a33"
    ctx.fillRect(x - 4, y, 36, 3)
    ctx.fillStyle = "#5a3d2b"
    ctx.fillRect(x - 4, y + 3, 36, 8)
    ctx.fillStyle = "#4a3223"
    ctx.fillRect(x - 3, y + 11, 3, 2)
    ctx.fillRect(x + 28, y + 11, 3, 2)
    // caneca
    ctx.fillStyle = "#e6e6e6"
    ctx.fillRect(x + 24, y - 3, 3, 3)
  }

  /** Divisórias da baia (laterais e fundo), aberta para o corredor. */
  private drawCubicle(d: Desk) {
    const ctx = this.ctx
    const input = this.input!
    const color = input.colors.get(d.id) ?? "#e6e6e6"
    ctx.fillStyle = input.selected === d.id ? "rgba(255,255,255,0.10)" : "rgba(255,255,255,0.03)"
    ctx.fillRect(d.x, d.y, DESK_W, DESK_H)
    ctx.fillStyle = shade(color, -0.45)
    ctx.fillRect(d.x, d.y + 6, 2, DESK_H - 6)
    ctx.fillRect(d.x + DESK_W - 2, d.y + 6, 2, DESK_H - 6)
    ctx.fillRect(d.x, d.y + DESK_H - 12, DESK_W, 2)
    // lâmpada de status no alto da divisória: cor do agente piscando = trabalhando, âmbar = espera você,
    // verde = entregou, coral = erro ou tentando de novo
    const node = input.nodes.find((n) => n.id === d.id)
    const lamp = input.waiting.has(d.id)
      ? this.frame % 4 < 2 ? "#ffb829" : "#7a5a14"
      : input.retrying.has(d.id) || node?.state === "error"
        ? "#ff6363"
        : input.working.has(d.id)
          ? this.frame % 4 < 2 ? color : shade(color, -0.5)
          : node?.state === "completed"
            ? "#59d499"
            : "#2f3031"
    ctx.fillStyle = "#1b1c1e"
    ctx.fillRect(d.x + DESK_W - 9, d.y + 2, 7, 5)
    ctx.fillStyle = lamp
    ctx.fillRect(d.x + DESK_W - 8, d.y + 3, 5, 3)
    // cadeira atrás do agente
    ctx.fillStyle = "#2f3031"
    ctx.fillRect(d.seat.x - 6, d.seat.y - 14, 12, 12)
    ctx.fillStyle = "#454647"
    ctx.fillRect(d.seat.x - 5, d.seat.y - 13, 10, 3)
  }

  private drawNameplate(d: Desk) {
    const input = this.input!
    const node = input.nodes.find((n) => n.id === d.id)
    const done = node?.state === "completed"
    if (input.selected === d.id) {
      this.ctx.fillStyle = "#ffffff"
      this.ctx.fillRect(d.x, d.y + DESK_H - 1, DESK_W, 1)
    }
    this.label(`${done ? "✓ " : ""}${node?.agent ?? ""}`, d.x + 4, d.y + DESK_H - 3, done ? "#59d499" : "#9c9c9d", 5)
    if (node && node.members.length > 1) this.label(`×${node.members.length}`, d.x + DESK_W - 13, d.y + DESK_H - 3, "#9c9c9d", 5)
  }

  private drawActor(a: Actor, _now: number) {
    const ctx = this.ctx
    const input = this.input!
    const h = this.home(a)
    const seated = !a.walking && !a.path.length && Math.hypot(a.x - h.x, a.y - h.y) < 1 && !input.retrying.has(a.id)
    const x = Math.round(a.x - SPRITE_W / 2)
    const y = Math.round(a.y - SPRITE_H + 2)
    const node = input.nodes.find((n) => n.id === a.id)
    ctx.globalAlpha = node?.state === "completed" && seated ? 0.75 : 1
    // sombra
    ctx.fillStyle = "rgba(0,0,0,0.35)"
    ctx.fillRect(x + 1, Math.round(a.y) + 1, SPRITE_W - 2, 2)
    if (seated) {
      const typing = input.working.has(a.id)
      drawGrid(ctx, SIT_FRONT[typing ? this.frame % 2 : 0]!, a.pal, x, y)
    } else if (a.walking) {
      drawGrid(ctx, WALK[this.frame % 2]!, a.pal, x, y, a.facing < 0)
    } else {
      drawGrid(ctx, IDLE, a.pal, x, y)
    }
    ctx.globalAlpha = 1
  }

  private drawOverlay(a: Actor, now: number) {
    const input = this.input!
    const top = Math.round(a.y - SPRITE_H - 4)
    if (a.bubble && now < a.bubble.until) {
      this.bubble(a.x, top, a.bubble.tag, a.bubble.text, a.bubble.color)
      return
    }
    a.bubble = undefined
    if (input.waiting.has(a.id)) {
      if (this.frame % 4 < 3) this.bubble(a.x, top, "!", "precisa de você", "#ffb829", true)
    } else if (input.retrying.has(a.id)) {
      this.bubble(a.x, top, "…", `tentando de novo (${input.retrying.get(a.id)})`, "#ff6363", true)
    } else if (input.working.has(a.id) && !a.walking) {
      const dots = ".".repeat((this.frame % 3) + 1)
      this.label(dots, a.x - 3, top + 2, "#e6e6e6", 6)
    }
  }

  private bubble(cx: number, bottom: number, tag: string, text: string, color: string, solid = false) {
    const ctx = this.ctx
    const body = text.replace(/\s+/g, " ")
    const clipped = body.length > 30 ? body.slice(0, 29) + "…" : body
    ctx.font = `5px ${FONT}`
    const tw = ctx.measureText(tag).width
    const bw = ctx.measureText(clipped).width
    const w = Math.ceil(tw + bw + 12)
    const h = 11
    const x = Math.round(Math.max(2, Math.min(W - w - 2, cx - w / 2)))
    let y = Math.round(Math.max(1, bottom - h))
    // balões não se sobrepõem: sobe até achar espaço
    const hits = (yy: number) => this.drawn.some((d) => x < d.x + d.w + 1 && d.x < x + w + 1 && yy < d.y + d.h + 1 && d.y < yy + h + 1)
    for (let i = 0; i < 6 && hits(y); i++) y -= h + 2
    this.drawn.push({ x, y, w, h })
    const tail = Math.round(Math.max(1, bottom - h)) === y
    ctx.fillStyle = solid ? color : "#07080a"
    ctx.fillRect(x + 1, y, w - 2, h)
    ctx.fillRect(x, y + 1, w, h - 2)
    if (!solid) {
      ctx.fillStyle = color
      ctx.fillRect(x + 1, y, w - 2, 1)
      ctx.fillRect(x + 1, y + h - 1, w - 2, 1)
      ctx.fillRect(x, y + 1, 1, h - 2)
      ctx.fillRect(x + w - 1, y + 1, 1, h - 2)
    }
    // rabinho (só quando o balão está logo acima do personagem)
    if (tail) {
      ctx.fillStyle = solid ? color : "#07080a"
      ctx.fillRect(Math.round(cx) - 1, y + h, 3, 2)
    }
    ctx.textBaseline = "alphabetic"
    ctx.fillStyle = solid ? "#040506" : color
    ctx.fillText(tag, x + 4, y + 8)
    ctx.fillStyle = solid ? "#040506" : "#ffffff"
    ctx.fillText(clipped, x + 8 + tw, y + 8)
  }

  private label(text: string, x: number, y: number, color: string, size: number) {
    const ctx = this.ctx
    ctx.font = `${size}px ${FONT}`
    ctx.textBaseline = "alphabetic"
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
  }

  // ---------- clique ----------

  private toLogical(e: MouseEvent) {
    const rect = this.canvas.getBoundingClientRect()
    return { x: (e.clientX - rect.left - this.offX) / this.scale, y: (e.clientY - rect.top - this.offY) / this.scale }
  }

  private postitAt(x: number, y: number) {
    return this.postitRects.find((r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h)?.id
  }

  private onMove = (e: MouseEvent) => {
    const { x, y } = this.toLogical(e)
    this.hoverPost = this.postitAt(x, y)
    const onBoard = x >= BOARD_RECT.x && x <= BOARD_RECT.x + BOARD_RECT.w && y >= BOARD_RECT.y && y <= BOARD_RECT.y + BOARD_RECT.h
    const onActor = [...this.actors.values()].some((a) => Math.abs(x - a.x) < 7 && y > a.y - SPRITE_H && y < a.y + 3)
    const onDesk = [...this.desks.values()].some((d) => x >= d.x && x <= d.x + DESK_W && y >= d.y && y <= d.y + DESK_H)
    const onLead = x >= 150 && x <= 250 && y >= 40 && y <= 96
    this.canvas.style.cursor = this.hoverPost || (onBoard && this.postits.length) || onActor || onDesk || onLead ? "pointer" : "default"
  }

  private onLeave = () => {
    this.hoverPost = undefined
  }

  private onClick = (e: MouseEvent) => {
    const { x, y } = this.toLogical(e)
    const post = this.postitAt(x, y)
    if (post) return this.onBoard(post)
    // clique no quadro fora de um post-it abre o mais recente
    if (x >= BOARD_RECT.x && x <= BOARD_RECT.x + BOARD_RECT.w && y >= BOARD_RECT.y && y <= BOARD_RECT.y + BOARD_RECT.h) {
      const last = this.postits[this.postits.length - 1]
      if (last) return this.onBoard(last.id)
    }
    for (const a of this.actors.values()) {
      if (Math.abs(x - a.x) < 7 && y > a.y - SPRITE_H && y < a.y + 3) return this.onSelect(a.id)
    }
    for (const d of this.desks.values()) {
      if (x >= d.x && x <= d.x + DESK_W && y >= d.y && y <= d.y + DESK_H) return this.onSelect(d.id)
    }
    if (x >= 150 && x <= 250 && y >= 40 && y <= 96 && this.input?.root) this.onSelect(this.input.root)
  }
}

/** Caminho em "L" pelos corredores: vai até o corredor, anda na horizontal e chega ao destino.
 *  Na sala do líder, entra e sai pela porta contornando a mesa pelo lado direito. */
function route(from: Pt, to: Pt): Pt[] {
  if (Math.hypot(from.x - to.x, from.y - to.y) < 1) return []
  const inRoom = (p: Pt) => p.y < 96 && p.x > 150 && p.x < 250
  const pts: Pt[] = []
  if (inRoom(from) && inRoom(to)) return [to]
  if (inRoom(from)) {
    if (from.y < 82) pts.push({ x: LEAD_SIDE, y: from.y }, { x: LEAD_SIDE, y: 88 })
    pts.push(DOOR)
  }
  const start = pts.length ? DOOR : from
  pts.push({ x: start.x, y: CORRIDOR })
  if (inRoom(to)) {
    pts.push({ x: DOOR.x, y: CORRIDOR }, DOOR)
    if (to.y < 82) pts.push({ x: LEAD_SIDE, y: 88 }, { x: LEAD_SIDE, y: to.y })
  } else {
    pts.push({ x: to.x, y: CORRIDOR })
  }
  pts.push(to)
  return pts
}
