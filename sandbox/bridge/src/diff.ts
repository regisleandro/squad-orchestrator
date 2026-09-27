// Diff da sessão calculado pelo git, no mesmo formato que a gaveta de diff da UI lê
// ({ file, additions, deletions, status, patch }). Base = HEAD de quando a ponte subiu,
// então commits feitos pelo agente na branch da tarefa também aparecem.

import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"

const exec = promisify(execFile)
const MAX_PATCH = 20_000

export interface FileDiff {
  file: string
  additions: number
  deletions: number
  status: "added" | "modified" | "deleted"
  patch?: string
}

export class GitDiff {
  private base?: string
  private repoDir: string

  constructor(repoDir: string) {
    this.repoDir = repoDir
  }

  private git(args: string[]) {
    return exec("git", ["-C", this.repoDir, ...args], { maxBuffer: 32 * 1024 * 1024 }).then((r) => r.stdout)
  }

  async init() {
    this.base = (await this.git(["rev-parse", "HEAD"]).catch(() => "")).trim() || undefined
  }

  async compute(): Promise<FileDiff[]> {
    if (!this.base) await this.init()
    const base = this.base ?? "HEAD"
    const files: FileDiff[] = []
    const numstat = await this.git(["diff", "--numstat", base]).catch(() => "")
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [add, del, file] = line.split("\t")
      if (!file) continue
      const patch = await this.git(["diff", base, "--", file]).catch(() => "")
      const status = /^new file mode/m.test(patch) ? "added" : /^deleted file mode/m.test(patch) ? "deleted" : "modified"
      files.push({ file, additions: Number(add) || 0, deletions: Number(del) || 0, status, patch: patch.slice(0, MAX_PATCH) })
    }
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard"]).catch(() => "")
    for (const file of untracked.split("\n").filter(Boolean)) {
      const content = await readFile(join(this.repoDir, file), "utf8").catch(() => "")
      const lines = content.split("\n")
      files.push({ file, additions: lines.length, deletions: 0, status: "added", patch: lines.map((l) => "+" + l).join("\n").slice(0, MAX_PATCH) })
    }
    return files
  }
}
