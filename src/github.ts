import { HttpError } from "./http-error.js"
import type { SandboxDriver } from "./sandbox.js"
import type { SandboxHandle } from "./types.js"

export function githubRepository(url: string) {
  const match = url.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
  if (!match) throw new HttpError(400, "Publicação disponível para repositórios do github.com via HTTPS ou SSH.")
  return { owner: match[1]!, repo: match[2]! }
}

// Executado na sandbox: usa sua chave e seu trust store, sem enviá-los ao browser
// nem colocar o token nos argumentos do processo. Entrada e saída são JSON.
export const GITHUB_REQUEST = `
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { method, path, body } = JSON.parse(input);
  const token = process.env.GITHUB_TOKEN;
  if (!token) { console.log(JSON.stringify({ ok: false, status: 400, message: "GITHUB_TOKEN não está disponível. Configure a chave no backend e recrie o serviço da API para carregá-la." })); }
  else {
    if (!path.startsWith("/repos/") || !["GET", "POST"].includes(method)) throw new Error("request");
    const response = await fetch("https://api.github.com" + path, {
      method,
      headers: { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2026-03-10", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(25000)
    });
    const data = await response.json();
    console.log(JSON.stringify({ ok: response.ok, status: response.status, data: response.ok ? data : undefined, message: response.ok ? undefined : data.message }));
  }
} catch { console.log(JSON.stringify({ ok: false, status: 502, message: "Não foi possível acessar o GitHub. Confira a conexão e os certificados da sandbox e tente novamente." })); }
`

export class GitHub {
  constructor(private driver: SandboxDriver, private sandbox: SandboxHandle, private owner: string, private repo: string) {}

  async request<T>(method: "GET" | "POST", suffix = "", body?: unknown): Promise<T> {
    const path = `/repos/${this.owner}/${this.repo}${suffix}`
    const result = await this.driver.execute!(this.sandbox, "node", ["--input-type=module", "-e", GITHUB_REQUEST], JSON.stringify({ method, path, body }))
    if (result.code) throw new HttpError(502, "Não foi possível consultar o GitHub pela sandbox.")
    const reply = JSON.parse(result.stdout) as { ok: boolean; status: number; message?: string; data: T }
    if (!reply.ok) {
      const message = reply.status === 401 ? "O GitHub recusou a credencial. Confira GITHUB_TOKEN."
        : reply.status === 403 ? "O token não tem permissão para esta operação. Confira Contents: escrita e Pull requests: escrita no repositório."
        : reply.status === 404 ? "O repositório não foi encontrado ou o token não tem acesso a ele."
        : reply.message ?? "O GitHub recusou a operação."
      throw new HttpError(reply.status >= 500 ? 502 : reply.status, message)
    }
    return reply.data
  }

  repository() {
    return this.request<{ default_branch: string; permissions?: { push?: boolean } }>("GET")
  }

  find(branch: string, baseBranch: string): Promise<GitHubPull | undefined> {
    const query = new URLSearchParams({ state: "all", head: `${this.owner}:${branch}`, base: baseBranch, per_page: "100" })
    return this.request<GitHubPull[]>("GET", `/pulls?${query}`).then((pulls) => pulls[0])
  }

  create(input: { title: string; body: string; branch: string; baseBranch: string; draft: boolean }) {
    return this.request<GitHubPull>("POST", "/pulls", { title: input.title, body: input.body, head: input.branch, base: input.baseBranch, draft: input.draft })
  }
}

export interface GitHubPull {
  number: number
  html_url: string
  draft: boolean
  state: string
  head: { sha: string }
}
