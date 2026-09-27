// Contrato comum dos harnesses dentro da ponte. Um runner por sessão raiz.

import type { GitDiff } from "./diff.ts"
import type { Hub } from "./hub.ts"
import type { Policy, SquadAgent } from "./squad.ts"

export interface RunnerContext {
  hub: Hub
  sessionID: string // sessão raiz (dona do board)
  agent: string // agente primário pedido pela tarefa (ex.: squad-lead)
  repoDir: string
  squad: Record<string, SquadAgent>
  policy: Policy
  diff: GitDiff
}

export interface PromptInput {
  text: string
  agent?: string
  model?: string // modelID puro (o providerID do formato do Kilo é descartado)
}

export interface Runner {
  prompt(input: PromptInput): void
  abort(): Promise<void>
  close(): void
}

/** Fim de turno: marca idle, publica o diff e libera quem espera. Igual ao que o Kilo emite. */
export async function finishTurn(ctx: RunnerContext) {
  const diff = await ctx.diff.compute().catch(() => [])
  ctx.hub.emit("session.diff", { sessionID: ctx.sessionID, diff })
  ctx.hub.status(ctx.sessionID, "idle")
}

/** Fila assíncrona simples para o modo de entrada em streaming do Agent SDK. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = []
  private waiters: ((r: IteratorResult<T>) => void)[] = []
  private closed = false

  push(item: T) {
    const w = this.waiters.shift()
    if (w) w({ value: item, done: false })
    else this.items.push(item)
  }

  close() {
    this.closed = true
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true })
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift()!, done: false })
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true })
        return new Promise((resolve) => this.waiters.push(resolve))
      },
    }
  }
}

export function truncate(text: unknown, max = 4_000): string | undefined {
  if (text === undefined || text === null) return undefined
  const s = typeof text === "string" ? text : JSON.stringify(text)
  return s.length > max ? s.slice(0, max) + "\n…" : s
}
