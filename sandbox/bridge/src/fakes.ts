// Roteiros gravados no formato dos SDKs (BRIDGE_FAKE=1). Passam pelos mesmos runners e
// mapeamentos que os SDKs reais, então servem para demo e para testar a ponte sem LLM.
// O roteiro do Claude Code espelha o scripts/mock-kilo.ts: squad, board, permissão, VETO.

import type { CanUseTool, McpSdkServerConfigWithInstance, Options, Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import type { ThreadEvent, ThreadOptions } from "@openai/codex-sdk"
import { randomUUID } from "node:crypto"
import { appendFile } from "node:fs/promises"
import { join } from "node:path"

const SPEED = Number(process.env.BRIDGE_FAKE_SPEED ?? 1)
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms * SPEED))

export function fakeClaudeQuery(params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }): Query {
  const options = params.options ?? {}
  const cwd = options.cwd ?? process.cwd()
  const canUseTool = options.canUseTool as CanUseTool
  const board = (options.mcpServers as Record<string, McpSdkServerConfigWithInstance> | undefined)?.board
  const out: SDKMessage[] = []
  let notify: (() => void) | undefined
  let closed = false
  let interrupted = false
  const push = (m: any) => {
    out.push(m as SDKMessage)
    notify?.()
  }

  const session_id = randomUUID()
  const say = (parent: string | null, text: string) =>
    push({ type: "assistant", uuid: randomUUID(), session_id, parent_tool_use_id: parent, message: { id: randomUUID(), role: "assistant", content: [{ type: "text", text }] } })

  /** tool_use -> (permissão) -> execução -> tool_result, como o Claude Code faz. */
  const use = async (parent: string | null, name: string, input: Record<string, unknown>, run?: () => Promise<string>) => {
    const id = "toolu_" + randomUUID().replaceAll("-", "").slice(0, 16)
    push({ type: "assistant", uuid: randomUUID(), session_id, parent_tool_use_id: parent, message: { id: randomUUID(), role: "assistant", content: [{ type: "tool_use", id, name, input }] } })
    await wait(150)
    const decision = await canUseTool(name, input, { signal: new AbortController().signal, toolUseID: id, requestId: id })
    let content = "ok"
    let is_error = false
    if (decision?.behavior === "deny") {
      content = decision.message
      is_error = true
    } else if (name.startsWith("mcp__board__")) {
      const tools = (board?.instance as any)?._registeredTools ?? {}
      const t = tools[name.replace("mcp__board__", "")]
      const result = await (t?.handler ?? t?.callback)?.(input, {})
      content = result?.content?.[0]?.text ?? "ok"
    } else if (run) content = await run()
    push({ type: "user", session_id, parent_tool_use_id: parent, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content, is_error }] } })
    return id
  }

  const agent = async (subagent_type: string, description: string, body: (self: string) => Promise<void>) => {
    const id = "toolu_" + randomUUID().replaceAll("-", "").slice(0, 16)
    const input = { subagent_type, description, prompt: `${description}. Siga o desenho no board.` }
    push({ type: "assistant", uuid: randomUUID(), session_id, parent_tool_use_id: null, message: { id: randomUUID(), role: "assistant", content: [{ type: "tool_use", id, name: "Agent", input }] } })
    await canUseTool("Agent", input, { signal: new AbortController().signal, toolUseID: id, requestId: id })
    await wait(300)
    await body(id)
    push({ type: "user", session_id, parent_tool_use_id: null, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: `${subagent_type} concluiu` }] } })
  }

  const post = (parent: string | null, to: string, type: string, body: string) => use(parent, "mcp__board__board_post", { to, type, body })
  const result = () => push({ type: "result", subtype: "success", is_error: false, result: "ok", session_id, uuid: randomUUID(), duration_ms: 0, duration_api_ms: 0, num_turns: 1 })

  async function squadTurn() {
    push({ type: "system", subtype: "init", model: options.model ?? "claude-fake", tools: ["Agent", "Bash", "Edit", "Read", "mcp__board__board_post"], agents: Object.keys(options.agents ?? {}), session_id, uuid: randomUUID() })
    await wait(300)
    say(null, "Explorei o repo. Plano: architect desenha, developer implementa, qa testa e reviewer revisa o diff.")
    await post(null, "ALL", "INFO", "Plano: 1) desenho 2) implementação 3) testes 4) revisão. Postem ASK se travarem.")
    await agent("architect", "Desenhar a mudança", async (self) => {
      say(self, "Li o README e a estrutura. Proposta: uma seção nova, sem mexer no código.")
      await use(self, "Read", { file_path: "README.md" }, async () => "conteúdo")
      await post(self, "main", "RESULT", "Adicionar SQUAD_DEMO.md com o passo a passo; README aponta para ele.")
    })
    await agent("developer", "Implementar a mudança", async (self) => {
      say(self, "Implementando a partir do desenho do architect.")
      await use(self, "Write", { file_path: join(cwd, "SQUAD_DEMO.md"), content: "# Squad demo\n" }, async () => {
        await appendFile(join(cwd, "SQUAD_DEMO.md"), "# Squad demo\n\nFeito pela squad (Claude Code, roteiro fake).\n")
        return "arquivo escrito"
      })
      await use(self, "Bash", { command: "npm install --save-dev markdownlint-cli", description: "instalar o lint de markdown" }, async () => "added 1 package")
      await post(self, "main", "RESULT", "SQUAD_DEMO.md criado.")
    })
    await agent("reviewer", "Revisar o diff", async (self) => {
      await use(self, "Bash", { command: "git diff" }, async () => "+# Squad demo")
      await post(self, "main", "VETO", "SQUAD_DEMO.md:1 falta dizer como rodar. Corrija antes do commit.")
    })
    await agent("developer", "Completar o como rodar", async (self) => {
      await use(self, "Edit", { file_path: join(cwd, "SQUAD_DEMO.md"), old_string: "", new_string: "## Como rodar" }, async () => {
        await appendFile(join(cwd, "SQUAD_DEMO.md"), "\n## Como rodar\n\n`npm test`\n")
        return "editado"
      })
      await post(self, "main", "RESULT", "Seção 'Como rodar' adicionada.")
    })
    await agent("reviewer", "Revisar a correção", async (self) => {
      await use(self, "Bash", { command: "git diff" }, async () => "+## Como rodar")
      await post(self, "main", "RESULT", "Corrigido pelo developer. Aprovado.")
    })
    say(null, "Pronto. SQUAD_DEMO.md criado, revisão aprovada depois da correção.")
    result()
  }

  void (async () => {
    let first = true
    for await (const msg of params.prompt as AsyncIterable<SDKUserMessage>) {
      if (closed) break
      interrupted = false
      if (first) await squadTurn()
      else {
        say(null, `Entendido: "${String(msg.message.content).slice(0, 80)}".`)
        result()
      }
      first = false
    }
    closed = true
    notify?.()
  })()

  const iterator = {
    async next() {
      for (;;) {
        if (out.length) return { value: out.shift()!, done: false }
        if (closed) return { value: undefined, done: true }
        await new Promise<void>((r) => (notify = r))
      }
    },
    async return() {
      closed = true
      return { value: undefined, done: true }
    },
    async throw(e) {
      throw e
    },
    [Symbol.asyncIterator]() {
      return this
    },
  } as AsyncGenerator<SDKMessage, void>
  return Object.assign(iterator, {
    interrupt: async () => {
      interrupted = true
      return undefined
    },
    setModel: async () => {},
    close: () => {
      closed = true
      notify?.()
    },
    get interrupted() {
      return interrupted
    },
  }) as unknown as Query
}

export function fakeCodex() {
  return {
    startThread(options: ThreadOptions = {}) {
      const cwd = options.workingDirectory ?? process.cwd()
      let turn = 0
      return {
        id: "thr_fake",
        async runStreamed(input: unknown, opts: { signal?: AbortSignal } = {}) {
          const current = ++turn
          async function* events(): AsyncGenerator<ThreadEvent> {
            if (current === 1) yield { type: "thread.started", thread_id: "thr_fake" }
            yield { type: "turn.started" }
            await wait(300)
            if (current > 1) {
              yield { type: "item.completed", item: { id: "item_0", type: "agent_message", text: `Entendido: "${String(input).slice(0, 80)}".` } }
              yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
              return
            }
            yield { type: "item.completed", item: { id: "item_0", type: "reasoning", text: "Vou ler o repo, desenhar, implementar, testar e revisar." } }
            const todos = [
              { text: "Desenhar a mudança", completed: false },
              { text: "Implementar", completed: false },
              { text: "Testar", completed: false },
              { text: "Revisar o diff", completed: false },
            ]
            yield { type: "item.started", item: { id: "item_1", type: "todo_list", items: todos } }
            yield { type: "item.started", item: { id: "item_2", type: "command_execution", command: "ls -la", aggregated_output: "", status: "in_progress" } }
            await wait(400)
            yield { type: "item.completed", item: { id: "item_2", type: "command_execution", command: "ls -la", aggregated_output: "README.md\n", exit_code: 0, status: "completed" } }
            todos[0]!.completed = true
            yield { type: "item.updated", item: { id: "item_1", type: "todo_list", items: todos } }
            if (opts.signal?.aborted) return
            await appendFile(join(cwd, "SQUAD_DEMO.md"), "# Squad demo\n\nFeito pelo Codex (roteiro fake).\n")
            yield { type: "item.completed", item: { id: "item_3", type: "file_change", changes: [{ path: "SQUAD_DEMO.md", kind: "add" }], status: "completed" } }
            todos[1]!.completed = true
            yield { type: "item.updated", item: { id: "item_1", type: "todo_list", items: todos } }
            yield { type: "item.started", item: { id: "item_4", type: "command_execution", command: "npm test", aggregated_output: "", status: "in_progress" } }
            await wait(500)
            yield { type: "item.completed", item: { id: "item_4", type: "command_execution", command: "npm test", aggregated_output: "42 passing", exit_code: 0, status: "completed" } }
            todos[2]!.completed = true
            todos[3]!.completed = true
            yield { type: "item.completed", item: { id: "item_1", type: "todo_list", items: todos } }
            yield { type: "item.completed", item: { id: "item_5", type: "agent_message", text: "Pronto. SQUAD_DEMO.md criado, testes passando e diff revisado." } }
            yield { type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 } }
          }
          return { events: events() }
        },
      }
    },
  } as any
}
