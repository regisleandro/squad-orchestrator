import { createHash } from "node:crypto"
import { GitHub, githubRepository, type GitHubPull } from "./github.js"
import { HttpError } from "./http-error.js"
import type { Relay } from "./relay.js"
import type { SandboxDriver } from "./sandbox.js"
import type { TaskStore } from "./store.js"
import type { Publication, PublicationPreview, PullRequestResult, Task } from "./types.js"

export interface PublishInput {
  title: string
  body: string
  version: string
  reviewed: boolean
  draft?: boolean
}

/** Publicação explícita pelo backend. O agente pode commitar, mas não faz push. */
export class Publisher {
  private active = new Set<string>()

  constructor(private store: TaskStore, private relay: Relay, private driver: SandboxDriver) {}

  isPublishing(id: string) { return this.active.has(id) }

  private requireIdle(task: Task) {
    if (!this.driver.execute) throw new HttpError(409, "Publicação disponível apenas para sandboxes Docker.")
    if (!task.sandbox || task.status === "stopped") throw new HttpError(409, "A sandbox foi encerrada. Crie uma nova tarefa para publicar.")
    if (task.status !== "idle") throw new HttpError(409, "Aguarde o turno concluir sem falhas antes de publicar.")
    if (Object.keys(task.pendingPermissions).length || Object.values(task.members).some((m) => ["running", "pending"].includes(m.status)))
      throw new HttpError(409, "A squad ainda tem trabalho ou permissões pendentes.")
  }

  private async git(task: Task, args: string[], allowDiffExit = false) {
    const result = await this.driver.execute!(task.sandbox!, "git", args)
    if (result.code && !(allowDiffExit && result.code === 1)) {
      throw new HttpError(409, `Git não concluiu a operação: ${result.stderr.trim().slice(0, 1500) || "confira a sandbox e as permissões do repositório"}`)
    }
    return result.stdout
  }

  private github(task: Task) {
    const { owner, repo } = githubRepository(task.repoUrl)
    return new GitHub(this.driver, task.sandbox!, owner, repo)
  }

  async preview(task: Task): Promise<PublicationPreview> {
    this.requireIdle(task)
    const expected = githubRepository(task.repoUrl)
    const origin = githubRepository((await this.git(task, ["remote", "get-url", "origin"])).trim())
    if (`${expected.owner}/${expected.repo}`.toLowerCase() !== `${origin.owner}/${origin.repo}`.toLowerCase())
      throw new HttpError(409, "O remote origin mudou. Restaure o repositório da tarefa antes de publicar.")
    const repository = await this.github(task).repository()
    if (repository.permissions?.push === false) throw new HttpError(403, "O token não tem acesso de escrita ao repositório. Confira Contents: escrita e Pull requests: escrita.")
    const branch = (await this.git(task, ["branch", "--show-current"])).trim()
    if (!/^squad\/[\w./-]+$/.test(branch)) throw new HttpError(409, "A publicação deve usar a branch squad criada para a tarefa.")
    const configuredBranch = await this.driver.execute!(task.sandbox!, "git", ["config", "--get", "squad.baseBranch"])
    const baseBranch = configuredBranch.stdout.trim() || task.branch || repository.default_branch
    const recordedBase = await this.driver.execute!(task.sandbox!, "git", ["rev-parse", "--verify", "refs/squad/base"])
    // Sandboxes anteriores à publicação usam a referência remota do clone.
    const baseResult = recordedBase.code
      ? await this.driver.execute!(task.sandbox!, "git", ["rev-parse", "--verify", `refs/remotes/origin/${baseBranch}`])
      : recordedBase
    if (baseResult.code) throw new HttpError(409, "A referência da branch de origem não existe na sandbox. Confira a branch escolhida para a tarefa.")
    const base = baseResult.stdout.trim()
    if (!baseBranch || branch === baseBranch) throw new HttpError(409, "A branch de destino não foi identificada corretamente.")
    await this.git(task, ["check-ref-format", `refs/heads/${baseBranch}`])
    const head = (await this.git(task, ["rev-parse", "HEAD"])).trim()
    const status = await this.git(task, ["status", "--porcelain=v1", "-z"])
    if (/(?:^|\x00)(?:UU|AA|DD|AU|UA|DU|UD) /.test(status)) throw new HttpError(409, "Resolva os conflitos de merge antes de publicar.")
    const tracked = (await this.git(task, ["diff", "--name-only", "-z", base, "--"])).split("\0").filter(Boolean)
    const untracked = (await this.git(task, ["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean)
    const files = [...new Set([...tracked, ...untracked])].sort()
    const patches: string[] = []
    let size = 0
    for (const file of files) {
      const patch = untracked.includes(file)
        ? await this.git(task, ["diff", "--no-index", "--binary", "--", "/dev/null", file], true)
        : await this.git(task, ["diff", "--binary", base, "--", file])
      size += Buffer.byteLength(patch)
      if (size > 2 * 1024 * 1024) throw new HttpError(413, "O diff excede 2 MB. Reduza as mudanças desta tarefa antes de publicar.")
      patches.push(patch)
    }
    const diff = patches.join("\n")
    if (!diff) throw new HttpError(409, "Não há mudanças em relação à branch de origem para publicar.")
    const commits = (await this.git(task, ["log", "--format=%s", "-50", `${base}..HEAD`])).trim().split("\n").filter(Boolean)
    const title = (commits[0] ?? task.prompt).replace(/\s+/g, " ").slice(0, 160)
    const body = `## Mudança\n\n${task.prompt}\n\n## Validação\n\nPublicação solicitada após revisão do diff e confirmação dos testes.\n\nTarefa: ${task.id}`
    const version = createHash("sha256").update(JSON.stringify({ branch, baseBranch, base, head, status, diff })).digest("hex")
    return { branch, baseBranch, head, base, version, diff, files: files.length, commits, hasUncommitted: Boolean(status), title, body }
  }

  private update(task: Task, publication: Publication) {
    this.store.update(task.id, { publication })
    this.store.touch(task.id)
    this.relay.publish(task.id, "task.publication", publication)
  }

  async publish(task: Task, input: PublishInput): Promise<PullRequestResult> {
    if (task.publication?.status === "published" && task.publication.result) return task.publication.result
    if (this.active.has(task.id)) throw new HttpError(409, "A publicação desta tarefa já está em andamento.")
    this.requireIdle(task)
    if (typeof input.title !== "string" || !input.title.trim() || input.title.length > 256) throw new HttpError(400, "Informe um título de até 256 caracteres.")
    if (typeof input.body !== "string" || !input.body.trim() || input.body.length > 60000) throw new HttpError(400, "Informe uma descrição de até 60.000 caracteres.")
    if (input.reviewed !== true) throw new HttpError(400, "Confirme a revisão das mudanças e a validação dos testes.")
    if (typeof input.version !== "string") throw new HttpError(400, "Atualize a revisão do diff antes de publicar.")
    if (input.draft !== undefined && typeof input.draft !== "boolean") throw new HttpError(400, "O campo rascunho deve ser verdadeiro ou falso.")
    this.active.add(task.id)
    let step: Publication["step"] = "checking"
    try {
      this.update(task, { status: "publishing", step })
      const preview = await this.preview(task)
      if (preview.version !== input.version) throw new HttpError(409, "As mudanças foram alteradas desde a revisão. Atualize o diff e revise novamente.")
      const github = this.github(task)
      let existing = await github.find(preview.branch, preview.baseBranch)
      if (existing && existing.state !== "open") throw new HttpError(409, "O PR desta branch já foi fechado ou mesclado. Crie uma nova tarefa.")
      if (preview.hasUncommitted) {
        step = "committing"
        this.update(task, { status: "publishing", step })
        await this.git(task, ["add", "--all", "--", "."])
        await this.git(task, ["commit", "-m", input.title.trim()])
      }
      // Confere conteúdo e limpeza após hooks de commit; nada novo é enviado sem revisão.
      const committed = await this.preview(task)
      const normalize = (diff: string) => diff.replace(/^index .*\n/gm, "")
      if (committed.hasUncommitted || normalize(committed.diff) !== normalize(preview.diff))
        throw new HttpError(409, "O conteúdo mudou durante o commit. Atualize o diff e revise novamente antes de publicar.")
      if (committed.head === committed.base) throw new HttpError(409, "Nenhum commit foi criado para esta tarefa.")
      step = "pushing"
      this.update(task, { status: "publishing", step })
      // Repositórios clonados por SSH também usam o helper HTTPS com GITHUB_TOKEN.
      const { owner, repo } = githubRepository(task.repoUrl)
      const remote = `https://github.com/${owner}/${repo}.git`
      await this.git(task, ["push", remote, `${committed.head}:refs/heads/${preview.branch}`])
      step = "creating"
      this.update(task, { status: "publishing", step })
      if (!existing) {
        try {
          existing = await github.create({ title: input.title.trim(), body: input.body, branch: preview.branch, baseBranch: preview.baseBranch, draft: input.draft ?? true })
        } catch (err) {
          // A resposta pode ter se perdido após o GitHub criar o PR.
          existing = await github.find(preview.branch, preview.baseBranch).catch(() => undefined)
          if (!existing || existing.state !== "open") throw err
        }
      }
      const result = this.result(existing, preview, committed.head)
      this.update(task, { status: "published", step: "done", result })
      return result
    } catch (err) {
      const error = err instanceof Error ? err.message : "Não foi possível publicar o PR."
      this.update(task, { status: "error", step, error })
      throw err
    } finally {
      this.active.delete(task.id)
    }
  }

  private result(pull: GitHubPull, preview: PublicationPreview, commit: string): PullRequestResult {
    return { number: pull.number, url: pull.html_url, branch: preview.branch, baseBranch: preview.baseBranch, commit, draft: pull.draft }
  }
}
