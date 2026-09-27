// Harness Claude Code, via Claude Agent SDK (o mesmo motor do `claude` CLI, sem TTY).
//
// Mapeamento para o vocabulário do kilo serve:
//   squad (agents/*.md)       -> `agents` do SDK (subagentes); o líder vira append do system prompt
//   tool Agent/Task           -> part.tool = "task" + state.metadata.sessionId (sessão filha sintética)
//   parent_tool_use_id        -> sessionID da sessão filha (tudo que o subagente faz cai no nó dele)
//   board_post / board_read   -> servidor MCP in-process "board"; o snapshot sai de GET .../board
//   canUseTool                -> permission.asked / permission.replied, com a política do kilo.jsonc
//   system/api_retry          -> session.status retry
//   result                    -> session.diff + session.status idle + session.idle

import {
  createSdkMcpServer,
  query as sdkQuery,
  tool,
  type AgentDefinition,
  type CanUseTool,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import { AsyncQueue, finishTurn, truncate, type PromptInput, type Runner, type RunnerContext } from "./runner.ts"
import { alwaysPattern } from "./squad.ts"

type QueryFn = typeof sdkQuery

const SUBAGENT_TOOLS = new Set(["Agent", "Task"])
const TOOL_NAMES: Record<string, string> = {
  Read: "read",
  Write: "write",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Glob: "glob",
  Grep: "grep",
  LS: "list",
  WebFetch: "webfetch",
  WebSearch: "websearch",
  TodoWrite: "todowrite",
  mcp__board__board_post: "board_post",
  mcp__board__board_read: "board_read",
}
// Chave da política do kilo.jsonc para cada tool do Claude Code. Tools fora daqui são internas
// do harness (ToolSearch, TaskOutput...) e passam direto.
const PERMISSION_KEYS: Record<string, string> = {
  Read: "read",
  Write: "edit",
  Edit: "edit",
  MultiEdit: "edit",
  NotebookEdit: "edit",
  Bash: "bash",
  Glob: "glob",
  Grep: "grep",
  LS: "list",
  WebFetch: "webfetch",
  WebSearch: "webfetch",
  TodoWrite: "todowrite",
  Agent: "task",
  Task: "task",
}

const HARNESS_NOTE = `

## Notas do ambiente (Claude Code)
- A tool \`task\` citada acima é a tool Agent (ou Task): use \`subagent_type\` com o nome do especialista.
- O board da squad é o servidor MCP \`board\`: \`board_post\` = mcp__board__board_post { to: "ALL" | "main" | nome do agente, type: INFO|ASK|RESULT|HOLD|VETO, body, reply_to? } e \`board_read\` = mcp__board__board_read.`

export class ClaudeRunner implements Runner {
  private q?: Query
  private inbox = new AsyncQueue<SDKUserMessage>()
  private model?: string
  private childSession = new Map<string, string>() // tool_use id da Agent -> sessão filha
  private sessionAgent = new Map<string, string>() // sessão -> nome do agente
  private toolSession = new Map<string, string>() // tool_use id -> sessão que chamou
  private tools = new Map<string, { sessionID: string; tool: string; input: Record<string, unknown>; title?: string }>()
  private boardCalls: { tool: string; input: string; sessionID: string; used: boolean }[] = []
  private turnOpen = false

  private ctx: RunnerContext
  private queryFn: QueryFn

  constructor(ctx: RunnerContext, queryFn: QueryFn = sdkQuery) {
    this.ctx = ctx
    this.queryFn = queryFn
    this.sessionAgent.set(ctx.sessionID, ctx.agent)
  }

  prompt(input: PromptInput) {
    const { hub, sessionID } = this.ctx
    if (!this.q) this.start(input.model)
    else if (input.model && input.model !== this.model) {
      this.model = input.model
      void this.q.setModel(input.model).catch(() => {})
    }
    hub.userText(sessionID, this.ctx.agent, input.text)
    this.turnOpen = true
    hub.status(sessionID, "busy")
    this.inbox.push({ type: "user", message: { role: "user", content: input.text }, parent_tool_use_id: null })
  }

  async abort() {
    this.ctx.hub.rejectAll()
    await this.q?.interrupt().catch(() => {})
  }

  close() {
    this.inbox.close()
    this.q?.close()
  }

  private start(model?: string) {
    const { squad, agent, repoDir } = this.ctx
    this.model = model
    const lead = squad[agent]
    const agents: Record<string, AgentDefinition> = {}
    if (lead)
      for (const a of Object.values(squad)) {
        if (a.name === lead.name || a.mode === "primary") continue
        agents[a.name] = {
          description: a.description,
          prompt: a.prompt + HARNESS_NOTE,
          ...(a.readOnly ? { disallowedTools: ["Write", "Edit", "MultiEdit", "NotebookEdit"] } : {}),
        }
      }

    this.q = this.queryFn({
      prompt: this.inbox,
      options: {
        cwd: repoDir,
        model,
        permissionMode: "default",
        canUseTool: this.canUseTool,
        agents,
        mcpServers: lead ? { board: this.boardServer() } : {},
        // Sem squad (ex.: agente "claude"), é o Claude Code puro, com o prompt padrão dele.
        systemPrompt: { type: "preset", preset: "claude_code", ...(lead ? { append: lead.prompt + HARNESS_NOTE } : {}) },
        // CLAUDE.md e .claude/ do próprio repo continuam valendo, como .kilo/ no Kilo.
        settingSources: ["project"],
        stderr: (line) => process.stderr.write(`[claude] ${line}`),
      },
    })
    void this.consume(this.q)
  }

  private async consume(q: Query) {
    try {
      for await (const m of q) this.handle(m)
    } catch (err) {
      this.ctx.hub.error(this.ctx.sessionID, err instanceof Error ? err.message : String(err))
    }
    if (this.turnOpen) {
      this.turnOpen = false
      await finishTurn(this.ctx)
    }
  }

  private sessionOf(parentToolUseID: string | null | undefined) {
    return (parentToolUseID && this.childSession.get(parentToolUseID)) || this.ctx.sessionID
  }

  private handle(m: SDKMessage) {
    const { hub } = this.ctx
    switch (m.type) {
      case "assistant": {
        const sessionID = this.sessionOf(m.parent_tool_use_id)
        const agent = this.sessionAgent.get(sessionID) ?? "membro"
        hub.message(sessionID, m.uuid, "assistant", agent)
        const content = (m.message.content ?? []) as any[]
        content.forEach((block, i) => {
          const partID = `prt_${m.uuid}_${i}`
          if (block.type === "text" && block.text) hub.text(sessionID, m.uuid, partID, block.text)
          else if (block.type === "thinking" && block.thinking) hub.text(sessionID, m.uuid, partID, block.thinking, "reasoning")
          else if (block.type === "tool_use") this.onToolUse(sessionID, block)
        })
        return
      }
      case "user": {
        const content = m.message.content
        if (!Array.isArray(content)) return
        for (const block of content as any[]) if (block.type === "tool_result") this.onToolResult(block)
        return
      }
      case "system":
        if (m.subtype === "api_retry")
          hub.status(this.ctx.sessionID, "retry", {
            attempt: m.attempt,
            message: `${m.error}${m.error_status ? ` (HTTP ${m.error_status})` : ""}`,
            next: Date.now() + m.retry_delay_ms,
          })
        else if (m.subtype === "init") hub.emit("harness.init", { harness: "claude-code", model: m.model, tools: m.tools, agents: m.agents })
        return
      case "result":
        if (m.subtype !== "success" || m.is_error) {
          const errors = "errors" in m && Array.isArray(m.errors) ? m.errors.join("\n") : ""
          hub.error(this.ctx.sessionID, errors || ("result" in m ? String(m.result) : m.subtype), m.subtype)
        }
        this.turnOpen = false
        void finishTurn(this.ctx)
        return
      default:
        return
    }
  }

  private onToolUse(sessionID: string, block: { id: string; name: string; input: Record<string, any> }) {
    const { hub } = this.ctx
    const input = block.input ?? {}
    this.toolSession.set(block.id, sessionID)

    if (SUBAGENT_TOOLS.has(block.name)) {
      const child = `${this.ctx.sessionID}_${block.id}`
      const agent = String(input.subagent_type ?? "general-purpose")
      this.childSession.set(block.id, child)
      this.sessionAgent.set(child, agent)
      const taskInput = { subagent_type: agent, description: input.description ?? "", prompt: input.prompt }
      this.tools.set(block.id, { sessionID, tool: "task", input: taskInput, title: input.description })
      hub.tool(sessionID, block.id, "task", "running", taskInput, {
        metadata: { sessionId: child, parentSessionId: sessionID },
        title: input.description,
      })
      if (input.prompt) hub.userText(child, agent, String(input.prompt))
      hub.status(child, "busy")
      return
    }

    const name = TOOL_NAMES[block.name] ?? block.name.replace(/^mcp__/, "").toLowerCase()
    const normalized = normalizeInput(input)
    if (name === "board_post" || name === "board_read")
      this.boardCalls.push({ tool: name, input: stable(input), sessionID, used: false })
    this.tools.set(block.id, { sessionID, tool: name, input: normalized, title: input.description })
    hub.tool(sessionID, block.id, name, "running", normalized, { title: input.description })
  }

  private onToolResult(block: { tool_use_id: string; is_error?: boolean; content?: unknown }) {
    const info = this.tools.get(block.tool_use_id)
    if (!info) return
    const status = block.is_error ? "error" : "completed"
    const output = truncate(Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? "").join("\n") : block.content)
    const child = this.childSession.get(block.tool_use_id)
    this.ctx.hub.tool(info.sessionID, block.tool_use_id, info.tool, status, info.input, {
      output,
      title: info.title,
      ...(child ? { metadata: { sessionId: child, parentSessionId: info.sessionID } } : {}),
    })
    if (child) this.ctx.hub.status(child, "idle")
  }

  private canUseTool: CanUseTool = async (toolName, input, opts) => {
    const allow = { behavior: "allow" as const, updatedInput: input }
    const key = PERMISSION_KEYS[toolName]
    if (!key) return allow
    const value = String(input.command ?? input.file_path ?? input.url ?? input.query ?? input.pattern ?? "*")
    const action = this.ctx.policy.evaluate(key, value)
    if (action === "allow") return allow
    if (action === "deny") return { behavior: "deny", message: `negado pela política da squad (${key})` }

    const sessionID = (await waitFor(() => this.toolSession.get(opts.toolUseID), 500)) ?? this.ctx.sessionID
    const always = alwaysPattern(key, value)
    const reply = await this.ctx.hub.ask(
      { sessionID, permission: key, patterns: [value], metadata: { tool: toolName, title: opts.title, ...normalizeInput(input) }, always: [always] },
      opts.signal,
    )
    if (reply === "reject") return { behavior: "deny", message: "recusado pelo humano na UI" }
    if (reply === "always") this.ctx.policy.allowAlways(key, always)
    return allow
  }

  /** Board do Swarm emulado: mesmas tools e mesmo formato de mensagem do Kilo. */
  private boardServer() {
    const { hub, sessionID: root } = this.ctx
    const types = ["INFO", "ASK", "RESULT", "HOLD", "VETO"] as const
    return createSdkMcpServer({
      name: "board",
      version: "1.0.0",
      tools: [
        tool(
          "board_post",
          "Publica uma mensagem no board compartilhado da squad. to: ALL (todos), main (líder) ou o nome de um agente.",
          { to: z.string(), type: z.enum(types), body: z.string(), reply_to: z.string().optional() },
          async (args) => {
            const from = await this.claimBoardCall("board_post", args)
            const fromLabel = this.sessionAgent.get(from)
            const toLabel = args.to === "main" ? this.ctx.agent : args.to
            const msg = hub.postBoard({ from, fromLabel, to: args.to, toLabel, type: args.type, body: args.body, reply_to: args.reply_to })
            return { content: [{ type: "text", text: `publicado ${msg.id}` }] }
          },
        ),
        tool("board_read", "Lê as mensagens mais recentes do board da squad.", { limit: z.number().optional() }, async (args) => {
          await this.claimBoardCall("board_read", args)
          const board = hub.boardSnapshot(root, { limit: args.limit ?? 50 })
          const text = board.messages.map((m) => `[${m.id}] ${m.fromLabel ?? m.from} -> ${m.toLabel ?? m.to} ${m.type}: ${m.body}`).join("\n")
          return { content: [{ type: "text", text: text || "(board vazio)" }] }
        }),
      ],
    })
  }

  /**
   * O handler MCP não sabe qual subagente chamou. Casamos pela chamada vista no stream
   * (mesma tool, mesmo input) que ainda não foi usada; sem par, atribui ao líder.
   */
  private async claimBoardCall(tool: string, args: Record<string, unknown>) {
    const key = stable(args)
    const call = await waitFor(() => this.boardCalls.find((c) => !c.used && c.tool === tool && c.input === key), 1_000)
    if (call) call.used = true
    return call?.sessionID ?? this.ctx.sessionID
  }
}

/** Nomes de campo do Claude Code -> os que a UI resume (filePath, command, pattern, url). */
function normalizeInput(input: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...input }
  if (input.file_path) out.filePath = input.file_path
  if (input.notebook_path) out.filePath = input.notebook_path
  // Conteúdo de arquivo não precisa ir para a timeline
  for (const k of ["content", "old_string", "new_string", "edits"]) if (k in out) out[k] = truncate(out[k], 400)
  return out
}

function stable(v: Record<string, unknown>) {
  return JSON.stringify(Object.keys(v).sort().reduce<Record<string, unknown>>((o, k) => ((o[k] = v[k]), o), {}))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const v = fn()
    if (v !== undefined || Date.now() >= deadline) return v
    await new Promise((r) => setTimeout(r, 25))
  }
}

