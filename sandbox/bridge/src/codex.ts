// Harness Codex, via @openai/codex-sdk (que roda `codex exec --experimental-json`).
//
// O que degrada em relação ao Kilo, e por quê:
//   - Squad: o Codex exec não tem subagentes. Roda um agente só ("codex"), que recebe o
//     roteiro do líder adaptado para fazer os papéis da squad em sequência. O grafo mostra um nó.
//   - Board: não há board; GET .../board responde vazio.
//   - Permissões: o exec não tem canal de aprovação interativa, então roda com
//     approvalPolicy "never". O isolamento é o container (mesma decisão do Kilo).
//
// Mapeamento de itens do thread:
//   agent_message -> message (texto)     reasoning -> message (reasoning)
//   command_execution -> tool "bash"     file_change -> tool "edit"
//   mcp_tool_call -> tool "<server>.<tool>"   web_search -> tool "websearch"
//   todo_list -> tool "todowrite"        error / turn.failed -> session.error
//   turn.completed -> session.diff + idle

import { Codex, type SandboxMode, type Thread, type ThreadEvent, type ThreadItem } from "@openai/codex-sdk"
import { newID } from "./hub.ts"
import { finishTurn, truncate, type PromptInput, type Runner, type RunnerContext } from "./runner.ts"

export const CODEX_AGENT = "codex"

const SOLO_NOTE = `

## Notas do ambiente (Codex)
Aqui não há subagentes nem board. Faça você mesmo, em sequência, os papéis da squad: arquiteto (desenho curto), desenvolvedor (implementação), QA (testes rodando) e revisor (releia o \`git diff\` com rigor). Ignore as instruções sobre \`task\`, \`board_post\` e \`board_read\`; resuma o plano e o resultado na resposta.`

type CodexFactory = () => Pick<Codex, "startThread">

export class CodexRunner implements Runner {
  private thread?: Thread
  private queue: PromptInput[] = []
  private running = false
  private abortController?: AbortController
  private turn = 0
  private messageID?: string

  private ctx: RunnerContext
  private codexFactory: CodexFactory

  constructor(ctx: RunnerContext, codexFactory?: CodexFactory) {
    this.ctx = ctx
    this.codexFactory = codexFactory ?? (() => new Codex({ apiKey: process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY || undefined }))
  }

  prompt(input: PromptInput) {
    this.queue.push(input)
    this.ctx.hub.userText(this.ctx.sessionID, CODEX_AGENT, input.text)
    if (!this.running) void this.loop()
  }

  async abort() {
    this.queue = []
    this.abortController?.abort()
  }

  close() {
    void this.abort()
  }

  private start(model?: string) {
    this.thread = this.codexFactory().startThread({
      model,
      workingDirectory: this.ctx.repoDir,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      // O sandbox próprio do Codex (landlock/seccomp) costuma falhar dentro do Docker; o container
      // é o isolamento, como no Kilo com SANDBOX_NATIVE_ISOLATION=false.
      sandboxMode: (process.env.CODEX_SANDBOX_MODE as SandboxMode) || "danger-full-access",
      networkAccessEnabled: true,
    })
  }

  private async loop() {
    const { hub, sessionID } = this.ctx
    this.running = true
    hub.status(sessionID, "busy")
    while (this.queue.length) {
      const input = this.queue.shift()!
      const first = !this.thread
      if (first) this.start(input.model)
      const lead = this.ctx.squad[this.ctx.agent]
      const text = first && lead ? `${lead.prompt}${SOLO_NOTE}\n\n## Tarefa\n${input.text}` : input.text
      this.turn++
      this.messageID = undefined
      this.abortController = new AbortController()
      try {
        const { events } = await this.thread!.runStreamed(text, { signal: this.abortController.signal })
        for await (const event of events) this.handle(event)
      } catch (err) {
        if (!this.abortController.signal.aborted) hub.error(sessionID, err instanceof Error ? err.message : String(err), "CodexError")
      }
    }
    this.running = false
    await finishTurn(this.ctx)
  }

  private handle(event: ThreadEvent) {
    const { hub, sessionID } = this.ctx
    switch (event.type) {
      case "thread.started":
        return hub.emit("harness.init", { harness: "codex", threadID: event.thread_id })
      case "item.started":
      case "item.updated":
      case "item.completed":
        return this.onItem(event.item, event.type === "item.completed")
      case "turn.failed":
        return hub.error(sessionID, event.error.message, "CodexTurnFailed")
      case "error":
        return hub.error(sessionID, event.message, "CodexError")
      default:
        return
    }
  }

  private onItem(item: ThreadItem, done: boolean) {
    const { hub, sessionID } = this.ctx
    // ids de item (item_0, item_1...) recomeçam a cada turno
    const callID = `t${this.turn}_${item.id}`
    const ensureMessage = () => {
      if (!this.messageID) {
        this.messageID = newID("msg")
        hub.message(sessionID, this.messageID, "assistant", CODEX_AGENT)
      }
      return this.messageID
    }
    switch (item.type) {
      case "agent_message":
        return hub.text(sessionID, ensureMessage(), `prt_${callID}`, item.text)
      case "reasoning":
        return hub.text(sessionID, ensureMessage(), `prt_${callID}`, item.text, "reasoning")
      case "command_execution": {
        const status = item.status === "in_progress" ? "running" : item.status === "failed" || (item.exit_code ?? 0) !== 0 ? "error" : "completed"
        return hub.tool(sessionID, callID, "bash", status, { command: item.command }, { output: truncate(item.aggregated_output), metadata: { exit: item.exit_code } })
      }
      case "file_change": {
        const description = item.changes.map((c) => `${c.kind} ${c.path}`).join(", ")
        return hub.tool(sessionID, callID, "edit", item.status === "failed" ? "error" : "completed", { filePath: item.changes[0]?.path, description, changes: item.changes }, { title: description })
      }
      case "mcp_tool_call": {
        const status = item.status === "in_progress" ? "running" : item.status === "failed" ? "error" : "completed"
        return hub.tool(sessionID, callID, `${item.server}.${item.tool}`, status, (item.arguments as Record<string, unknown>) ?? {}, {
          output: truncate(item.error?.message ?? item.result?.content),
        })
      }
      case "web_search":
        return hub.tool(sessionID, callID, "websearch", done ? "completed" : "running", { query: item.query }, { title: item.query })
      case "todo_list": {
        const doneCount = item.items.filter((i) => i.completed).length
        const title = `plano ${doneCount}/${item.items.length}: ${item.items.find((i) => !i.completed)?.text ?? "concluído"}`
        return hub.tool(sessionID, callID, "todowrite", done ? "completed" : "running", { todos: item.items }, { title })
      }
      case "error":
        return hub.error(sessionID, item.message, "CodexItemError")
    }
  }
}
