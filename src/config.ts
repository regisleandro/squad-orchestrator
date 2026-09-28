// Configuração via variáveis de ambiente (ver .env.example).

import { isHarness, type Harness } from "./harness.js"

export interface Config {
  port: number
  apiToken: string
  sandboxDriver: "docker" | "external"
  sandboxImage: string
  sandboxNetwork?: string
  sandboxUseContainerDns: boolean
  sandboxCpus: string
  sandboxMemory: string
  sandboxEnvPassthrough: string[]
  sandboxNativeIsolation: boolean
  /** Caminho absoluto no host do Docker para um bundle PEM de CAs confiáveis. */
  sandboxCaBundle?: string
  /** Arquivo de autenticação do AI Cockpit no host do Docker; montado só em tarefas aic. */
  aicAuthFile?: string
  kiloExternalUrl: string
  kiloExternalPassword: string
  kiloExternalDirectory: string
  aicExternalPassword: string
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
  if (env.SANDBOX_CA_BUNDLE && !isAbsoluteDockerHostPath(env.SANDBOX_CA_BUNDLE))
    throw new Error("SANDBOX_CA_BUNDLE exige um caminho absoluto no host do Docker")
  if (env.AIC_AUTH_FILE && !isAbsoluteDockerHostPath(env.AIC_AUTH_FILE))
    throw new Error("AIC_AUTH_FILE exige um caminho absoluto no host do Docker")
  if (env.SANDBOX_USE_CONTAINER_DNS === "true" && !env.SANDBOX_NETWORK)
    throw new Error("SANDBOX_USE_CONTAINER_DNS exige SANDBOX_NETWORK")
  const apiToken = env.API_TOKEN ?? ""
  const kiloExternalUrl = env.KILO_EXTERNAL_URL ?? "http://127.0.0.1:4096"
  const harnesses = (env.HARNESSES ?? "kilo,claude-code,codex").split(",").map((s) => s.trim()).filter(isHarness)
  if (env.SANDBOX_DRIVER === "external" && harnesses.includes("aic") && !env.EXTERNAL_URL_AIC)
    throw new Error("HARNESSES inclui aic, mas EXTERNAL_URL_AIC não foi definido")
  if (env.SANDBOX_DRIVER !== "external" && harnesses.includes("aic") && !env.AIC_AUTH_FILE)
    throw new Error("HARNESSES inclui aic em Docker, mas AIC_AUTH_FILE não foi definido")
  if (env.AIC_MODEL && !/^[^/]+\/.+$/.test(env.AIC_MODEL))
    throw new Error("AIC_MODEL deve usar provider/model")
  const defaultHarness = isHarness(env.DEFAULT_HARNESS) && harnesses.includes(env.DEFAULT_HARNESS)
    ? env.DEFAULT_HARNESS : (harnesses[0] ?? "kilo")
  if (!apiToken) console.warn("[config] API_TOKEN vazio: a API está sem autenticação (só para dev)")
  return {
    port: Number(env.PORT ?? 8080),
    apiToken,
    sandboxDriver: env.SANDBOX_DRIVER === "external" ? "external" : "docker",
    sandboxImage: env.SANDBOX_IMAGE ?? "squad-sandbox:dev",
    sandboxNetwork: env.SANDBOX_NETWORK || undefined,
    sandboxUseContainerDns: env.SANDBOX_USE_CONTAINER_DNS === "true",
    sandboxCpus: env.SANDBOX_CPUS ?? "2",
    sandboxMemory: env.SANDBOX_MEMORY ?? "4g",
    sandboxEnvPassthrough: (env.SANDBOX_ENV_PASSTHROUGH ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sandboxNativeIsolation: env.SANDBOX_NATIVE_ISOLATION === "true",
    sandboxCaBundle: env.SANDBOX_CA_BUNDLE || undefined,
    aicAuthFile: env.AIC_AUTH_FILE || undefined,
    kiloExternalUrl,
    kiloExternalPassword: env.KILO_EXTERNAL_PASSWORD ?? "",
    kiloExternalDirectory: env.KILO_EXTERNAL_DIRECTORY ?? "",
    aicExternalPassword: env.AIC_EXTERNAL_PASSWORD ?? "",
    externalUrls: {
      kilo: kiloExternalUrl,
      "claude-code": env.EXTERNAL_URL_CLAUDE_CODE || kiloExternalUrl,
      codex: env.EXTERNAL_URL_CODEX || kiloExternalUrl,
      aic: env.EXTERNAL_URL_AIC || kiloExternalUrl,
    },
    harnesses: harnesses.length ? harnesses : ["kilo"],
    defaultHarness,
    squadLeadAgent: env.SQUAD_LEAD_AGENT ?? "squad-lead",
    defaultModels: {
      kilo: env.DEFAULT_MODEL || undefined,
      "claude-code": env.CLAUDE_CODE_MODEL || undefined,
      codex: env.CODEX_MODEL || undefined,
      aic: env.AIC_MODEL || undefined,
    },
    idleTtlMs: Number(env.IDLE_TTL_MINUTES ?? 30) * 60_000,
    dataDir: env.DATA_DIR === undefined ? ".data" : env.DATA_DIR || undefined,
  }
}

function isAbsoluteDockerHostPath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(path)
}
