// Configuração via variáveis de ambiente (ver .env.example).

import { HARNESSES, isHarness, type Harness } from "./harness.js"

export interface Config {
  port: number
  apiToken: string
  sandboxDriver: "docker" | "external"
  sandboxImage: string
  sandboxNetwork?: string
  sandboxCpus: string
  sandboxMemory: string
  sandboxEnvPassthrough: string[]
  sandboxNativeIsolation: boolean
  kiloExternalUrl: string
  kiloExternalPassword: string
  kiloExternalDirectory: string
  /** Driver external: URL por harness (a ponte da sandbox/bridge ou o kilo serve). */
  externalUrls: Record<Harness, string>
  harnesses: Harness[]
  defaultHarness: Harness
  squadLeadAgent: string
  /** Modelo padrão por harness (DEFAULT_MODEL é o do Kilo, no formato provider/model). */
  defaultModels: Partial<Record<Harness, string>>
  idleTtlMs: number
  /** Pasta onde tarefas e logs de eventos são gravados (vazio = só memória). */
  dataDir?: string
}

export function loadConfig(env = process.env): Config {
  const apiToken = env.API_TOKEN ?? ""
  const kiloExternalUrl = env.KILO_EXTERNAL_URL ?? "http://127.0.0.1:4096"
  const harnesses = (env.HARNESSES ?? HARNESSES.join(",")).split(",").map((s) => s.trim()).filter(isHarness)
  const defaultHarness = isHarness(env.DEFAULT_HARNESS) ? env.DEFAULT_HARNESS : (harnesses[0] ?? "kilo")
  if (!apiToken) console.warn("[config] API_TOKEN vazio: a API está sem autenticação (só para dev)")
  return {
    port: Number(env.PORT ?? 8080),
    apiToken,
    sandboxDriver: env.SANDBOX_DRIVER === "external" ? "external" : "docker",
    sandboxImage: env.SANDBOX_IMAGE ?? "squad-sandbox:dev",
    sandboxNetwork: env.SANDBOX_NETWORK || undefined,
    sandboxCpus: env.SANDBOX_CPUS ?? "2",
    sandboxMemory: env.SANDBOX_MEMORY ?? "4g",
    sandboxEnvPassthrough: (env.SANDBOX_ENV_PASSTHROUGH ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sandboxNativeIsolation: env.SANDBOX_NATIVE_ISOLATION === "true",
    kiloExternalUrl,
    kiloExternalPassword: env.KILO_EXTERNAL_PASSWORD ?? "",
    kiloExternalDirectory: env.KILO_EXTERNAL_DIRECTORY ?? "",
    externalUrls: {
      kilo: kiloExternalUrl,
      "claude-code": env.EXTERNAL_URL_CLAUDE_CODE || kiloExternalUrl,
      codex: env.EXTERNAL_URL_CODEX || kiloExternalUrl,
    },
    harnesses: harnesses.length ? harnesses : ["kilo"],
    defaultHarness,
    squadLeadAgent: env.SQUAD_LEAD_AGENT ?? "squad-lead",
    defaultModels: {
      kilo: env.DEFAULT_MODEL || undefined,
      "claude-code": env.CLAUDE_CODE_MODEL || undefined,
      codex: env.CODEX_MODEL || undefined,
    },
    idleTtlMs: Number(env.IDLE_TTL_MINUTES ?? 30) * 60_000,
    dataDir: env.DATA_DIR === undefined ? ".data" : env.DATA_DIR || undefined,
  }
}
