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
}

const WORKDIR = "/workspace/repo"

export class DockerSandboxDriver implements SandboxDriver {
  constructor(private cfg: Config) {}

  async provision(task: Task): Promise<SandboxHandle> {
    const password = randomBytes(24).toString("base64url")
    const env: Record<string, string> = {
      REPO_URL: task.repoUrl,
      REPO_BRANCH: task.branch,
      REPO_DIR: WORKDIR,
      KILO_SERVER_PASSWORD: password,
      // O entrypoint sobe `kilo serve` ou a ponte (sandbox/bridge) conforme o harness.
      HARNESS: task.harness,
    }
    // Sem isolamento nativo: desliga o bwrap do Kilo (KILO_CONFIG_CONTENT tem precedência sobre KILO_CONFIG_DIR)
    // e o container volta ao perfil de segurança padrão do Docker.
    if (!this.cfg.sandboxNativeIsolation) env.KILO_CONFIG_CONTENT = JSON.stringify({ sandbox: { enabled: false } })
    if (process.env.CODEX_SANDBOX_MODE) env.CODEX_SANDBOX_MODE = process.env.CODEX_SANDBOX_MODE
    for (const name of this.cfg.sandboxEnvPassthrough) {
      const value = process.env[name]
      if (value) env[name] = value
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

  async destroy(handle: SandboxHandle) {
    await exec("docker", ["rm", "-f", handle.id]).catch(() => {})
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
      password: this.cfg.kiloExternalPassword,
      directory: this.cfg.kiloExternalDirectory,
    }
  }

  async destroy() {}
}

export function createDriver(cfg: Config): SandboxDriver {
  return cfg.sandboxDriver === "external" ? new ExternalSandboxDriver(cfg) : new DockerSandboxDriver(cfg)
}
