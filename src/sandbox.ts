// Lifecycle das sandboxes. Um `kilo serve` por container por tarefa: o servidor do
// Kilo é stateful por diretório, e container por tarefa é o isolamento certo para
// repos de terceiros. O container isola a máquina; o sandbox nativo do Kilo (bwrap,
// ativado via kilo.jsonc) isola os comandos do agente dentro do container.

import { execFile } from "node:child_process"
import { randomBytes } from "node:crypto"
import { promisify } from "node:util"
import type { Config } from "./config.js"
import type { SandboxHandle, Task } from "./types.js"

const exec = promisify(execFile)

export interface SandboxDriver {
  provision(task: Task): Promise<SandboxHandle>
  destroy(handle: SandboxHandle): Promise<void>
  logs?(handle: SandboxHandle, tail?: number): Promise<string>
  /** false quando o container já morreu (ex.: git clone falhou). */
  isAlive?(handle: SandboxHandle): Promise<boolean>
  /** Reconecta a um container sobrevivente após interrupção do host/orquestrador. */
  restore?(task: Task): Promise<SandboxHandle | undefined>
  /** Comandos internos do backend, nunca expostos como execução arbitrária pela API. */
  execute?(handle: SandboxHandle, command: string, args: string[], input?: string): Promise<{ stdout: string; stderr: string; code: number }>
}

const WORKDIR = "/workspace/repo"

// A credencial atual chega por stdin, sem persistência nem argumentos de processo.
// Isso permite publicar trabalho de containers criados antes da configuração do token.
export const PUBLICATION_EXEC = `
import { spawn } from "node:child_process";
let input = "";
for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
const env = { ...process.env };
if (request.token) env.GITHUB_TOKEN = request.token;
let args = request.args;
if (request.command === "git" && args[0] === "push") {
  env.GIT_TERMINAL_PROMPT = "0";
  args = ["-c", "credential.helper=", "-c", 'credential.helper=!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f', ...args];
}
const child = spawn(request.command, args, { env, stdio: ["pipe", "inherit", "inherit"] });
child.stdin.on("error", () => {});
child.stdin.end(request.input);
child.on("error", () => { process.stderr.write("Não foi possível executar a publicação.\\n"); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
`

export class DockerSandboxDriver implements SandboxDriver {
  constructor(private cfg: Config) {}

  async provision(task: Task): Promise<SandboxHandle> {
    const password = randomBytes(24).toString("base64url")
    const env: Record<string, string> = {
      REPO_URL: task.repoUrl,
      REPO_BRANCH: task.branch,
      REPO_DIR: WORKDIR,
      KILO_SERVER_PASSWORD: password,
      ...(task.harness === "aic" ? { AICOCKPIT_SERVER_PASSWORD: password } : {}),
      // O entrypoint sobe o servidor do harness conforme a tarefa.
      HARNESS: task.harness,
      TASK_BRANCH: `squad/${task.id}`,
    }
    // Sem isolamento nativo: desliga o bwrap do Kilo (KILO_CONFIG_CONTENT tem precedência sobre KILO_CONFIG_DIR)
    // e o container volta ao perfil de segurança padrão do Docker.
    if (!this.cfg.sandboxNativeIsolation) {
      env.KILO_CONFIG_CONTENT = JSON.stringify({ sandbox: { enabled: false } })
      if (task.harness === "aic") env.AICOCKPIT_CONFIG_CONTENT = env.KILO_CONFIG_CONTENT
    }
    if (process.env.CODEX_SANDBOX_MODE) env.CODEX_SANDBOX_MODE = process.env.CODEX_SANDBOX_MODE
    for (const name of this.cfg.sandboxEnvPassthrough) {
      const value = process.env[name]
      if (value) env[name] = value
    }
    // O daemon monta o arquivo do host; o backend pode rodar dentro do Compose.
    // Sem configuração, a sandbox mantém seu trust store padrão.
    const caPath = "/opt/certs/host-ca.pem"
    if (this.cfg.sandboxCaBundle) {
      env.NODE_EXTRA_CA_CERTS = caPath
      env.SSL_CERT_FILE = caPath
      env.CURL_CA_BUNDLE = caPath
      env.GIT_SSL_CAINFO = caPath
    }

    const args = [
      "run",
      "-d",
      "--name",
      `squad-${task.id}`,
      "--label",
      "squad-orchestrator=1",
      "--label",
      `squad-task=${task.id}`,
      // Backend no host usa loopback; no Compose usa DNS da rede Docker.
      ...(this.cfg.sandboxUseContainerDns ? [] : ["-p", "127.0.0.1::4096"]),
      "--cpus",
      this.cfg.sandboxCpus,
      "--memory",
      this.cfg.sandboxMemory,
      "--pids-limit",
      "1024",
      // bwrap (sandbox nativo do Kilo) precisa criar namespaces e montar um /proc novo
      // (--unshare-pid + --proc) dentro do container. Sem systempaths=unconfined o Docker
      // mascara /proc e o bwrap falha com "Can't mount proc on /newroot/proc".
      ...(this.cfg.sandboxNativeIsolation
        ? ["--security-opt", "seccomp=unconfined", "--security-opt", "apparmor=unconfined", "--security-opt", "systempaths=unconfined"]
        : []),
      ...(this.cfg.sandboxNetwork ? ["--network", this.cfg.sandboxNetwork] : []),
      ...(this.cfg.sandboxCaBundle
        ? ["--mount", `type=bind,source=${this.cfg.sandboxCaBundle},target=${caPath},readonly`]
        : []),
      ...(task.harness === "aic" && this.cfg.aicAuthFile
        ? ["--mount", `type=bind,source=${this.cfg.aicAuthFile},target=/run/secrets/aic-auth.json,readonly`]
        : []),
      ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
      this.cfg.sandboxImage,
    ]
    const { stdout } = await exec("docker", args)
    const id = stdout.trim()

    try {
      if (this.cfg.sandboxUseContainerDns)
        return { id, baseUrl: `http://squad-${task.id}:4096`, password, directory: WORKDIR, harness: task.harness }
      const { stdout: portOut } = await exec("docker", ["port", id, "4096/tcp"])
      // ex.: "127.0.0.1:49153"
      const hostPort = portOut.trim().split("\n")[0]?.split(":").pop()
      if (!hostPort) throw new Error(`não achei a porta publicada: ${portOut}`)
      return { id, baseUrl: `http://127.0.0.1:${hostPort}`, password, directory: WORKDIR, harness: task.harness }
    } catch (err) {
      await exec("docker", ["rm", "-f", id]).catch(() => {})
      throw err
    }
  }

  async restore(task: Task): Promise<SandboxHandle | undefined> {
    const name = `squad-${task.id}`
    let container: { Id: string; State: { Running: boolean }; Config: { Env: string[]; Labels: Record<string, string> } }
    try {
      const { stdout } = await exec("docker", ["inspect", name])
      container = JSON.parse(stdout)[0]
    } catch { return undefined }
    if (container.Config.Labels?.["squad-task"] !== task.id || container.Config.Labels?.["squad-orchestrator"] !== "1") return undefined
    const password = container.Config.Env.find((env) => env.startsWith("KILO_SERVER_PASSWORD="))?.slice("KILO_SERVER_PASSWORD=".length)
    if (!password) return undefined
    if (!container.State.Running) await exec("docker", ["start", name])
    let baseUrl = `http://${name}:4096`
    if (!this.cfg.sandboxUseContainerDns) {
      const { stdout } = await exec("docker", ["port", name, "4096/tcp"])
      const port = stdout.trim().split("\n")[0]?.split(":").pop()
      if (!port) return undefined
      baseUrl = `http://127.0.0.1:${port}`
    }
    return { id: container.Id, baseUrl, password, directory: WORKDIR, harness: task.harness }
  }

  async destroy(handle: SandboxHandle) {
    await exec("docker", ["rm", "-f", handle.id]).catch(() => {})
  }

  execute(handle: SandboxHandle, command: string, args: string[], input = "") {
    const publication = command === "node" || (command === "git" && args[0] === "push")
    const invocation = publication ? ["node", "--input-type=module", "-e", PUBLICATION_EXEC] : [command, ...args]
    const payload = publication ? JSON.stringify({ command, args, input, token: process.env.GITHUB_TOKEN }) : input
    return new Promise<{ stdout: string; stderr: string; code: number }>((resolve, reject) => {
      const child = execFile("docker", ["exec", "-i", "-w", handle.directory, handle.id, ...invocation],
        { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
          if (err && typeof err.code !== "number") return reject(new Error("Não foi possível executar a operação na sandbox. Confira se o container está ativo."))
          resolve({ stdout, stderr, code: err ? Number(err.code) : 0 })
        })
      child.stdin?.on("error", () => {})
      child.stdin?.end(payload)
    })
  }

  async isAlive(handle: SandboxHandle) {
    try {
      const { stdout } = await exec("docker", ["inspect", "-f", "{{.State.Running}}", handle.id])
      return stdout.trim() === "true"
    } catch {
      return false
    }
  }

  async logs(handle: SandboxHandle, tail = 200) {
    const { stdout, stderr } = await exec("docker", ["logs", "--tail", String(tail), handle.id])
    return stdout + stderr
  }
}

/**
 * Aponta para um `kilo serve` (ou uma ponte da sandbox/bridge) já rodando: dev local, o mock
 * em scripts/mock-kilo.ts ou a ponte com BRIDGE_FAKE=1. Não clona nada: assume que o
 * diretório já é o repo. A URL depende do harness da tarefa (EXTERNAL_URL_CLAUDE_CODE/CODEX).
 */
export class ExternalSandboxDriver implements SandboxDriver {
  constructor(private cfg: Config) {}

  async provision(task: Task): Promise<SandboxHandle> {
    return {
      id: "external",
      harness: task.harness,
      baseUrl: this.cfg.externalUrls[task.harness],
      password: task.harness === "aic" ? this.cfg.aicExternalPassword : this.cfg.kiloExternalPassword,
      directory: this.cfg.kiloExternalDirectory,
    }
  }

  async destroy() {}
}

export function createDriver(cfg: Config): SandboxDriver {
  return cfg.sandboxDriver === "external" ? new ExternalSandboxDriver(cfg) : new DockerSandboxDriver(cfg)
}
