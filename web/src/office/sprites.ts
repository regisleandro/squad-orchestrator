// Sprites em pixel art desenhados em código (sem arte de terceiros).
// Cada sprite é uma grade de caracteres; cada caractere é uma cor da paleta do personagem.
//   h cabelo · s pele · e olhos · c camisa (cor do agente) · d sombra da camisa · p calça · k sapato · . vazio

export type Grid = string[]

const HEAD_FRONT: Grid = [
  "...hhhh...",
  "..hhhhhh..",
  "..hssssh..",
  "..sesses..",
  "..ssssss..",
  "...ssss...",
]
const HEAD_BACK: Grid = [
  "...hhhh...",
  "..hhhhhh..",
  "..hhhhhh..",
  "..hhhhhh..",
  "..hhhhhh..",
  "...ssss...",
]
const TORSO: Grid = [
  "..cccccc..",
  ".cccccccc.",
  ".cdccccdc.",
  ".s.cccc.s.",
]
const LEGS_A: Grid = ["...pppp...", "...p..p...", "...p..p...", "..kk..kk.."]
const LEGS_B: Grid = ["...pppp...", "..p....p..", "..p....p..", ".kk....kk."]

/** Em pé, de frente, dois quadros de caminhada. */
export const WALK: Grid[] = [
  [...HEAD_FRONT, ...TORSO, ...LEGS_A],
  [...HEAD_FRONT, ...TORSO, ...LEGS_B],
]
/** Sentado de costas para a tela (olhando o monitor), dois quadros de digitação. */
export const SIT: Grid[] = [
  [...HEAD_BACK, "..cccccc..", ".cccccccc.", ".cccccccc.", "s.cccccc.s"],
  [...HEAD_BACK, "..cccccc..", ".cccccccc.", ".cccccccc.", ".scccccs.."],
]
/** Sentado de frente, atrás da mesa (a mesa cobre as pernas), dois quadros de digitação. */
export const SIT_FRONT: Grid[] = [
  [...HEAD_FRONT, "..cccccc..", ".cccccccc.", ".cdccccdc.", "..sccccs..", "..........", ".........."],
  [...HEAD_FRONT, "..cccccc..", ".cccccccc.", ".cdccccdc.", ".s.cccc.s.", "..........", ".........."],
]
/** Parado de frente (esperando, na máquina de café). */
export const IDLE: Grid = [...HEAD_FRONT, ...TORSO, ...LEGS_A]

export const SPRITE_W = 10
export const SPRITE_H = 14

export const HAIR = ["#3b2a20", "#1b1c1e", "#8a5a2b", "#d9b36c", "#6b3b2a", "#2f3031", "#b0b0b0"]
export const SKIN = ["#f1c6a1", "#d9a07a", "#a86f4c", "#f5d5b8", "#7a4e33"]

export interface Palette {
  h: string
  s: string
  e: string
  c: string
  d: string
  p: string
  k: string
}

export function palette(color: string, seed: number): Palette {
  return {
    h: HAIR[seed % HAIR.length]!,
    s: SKIN[(seed >> 2) % SKIN.length]!,
    e: "#040506",
    c: color,
    d: shade(color, -0.3),
    p: "#2b3140",
    k: "#111214",
  }
}

export function drawGrid(ctx: CanvasRenderingContext2D, grid: Grid, pal: Palette, x: number, y: number, flip = false) {
  for (let r = 0; r < grid.length; r++) {
    const row = grid[r]!
    for (let col = 0; col < row.length; col++) {
      const ch = row[col] as keyof Palette | "."
      if (ch === ".") continue
      const c = pal[ch as keyof Palette]
      if (!c) continue
      ctx.fillStyle = c
      ctx.fillRect(x + (flip ? row.length - 1 - col : col), y + r, 1, 1)
    }
  }
}

export function shade(hex: string, amount: number) {
  const n = parseInt(hex.slice(1), 16)
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v + (amount < 0 ? v * amount : (255 - v) * amount))))
  const r = f((n >> 16) & 255)
  const g = f((n >> 8) & 255)
  const b = f(n & 255)
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`
}

export function hash(text: string) {
  let h = 7
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h
}
