// Lê a squad do Kilo (sandbox/squad: kilo.jsonc + agents/*.md) para reaproveitar os mesmos
// agentes e a mesma política de permissões nos outros harnesses. A squad continua tendo uma
// fonte só; aqui só adaptamos nomes de tools.

import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"

export interface SquadAgent {
  name: string
  description: string
  mode: "primary" | "subagent" | "all"
  readOnly: boolean // permission.edit: deny no frontmatter
  prompt: string
}

export type Action = "allow" | "ask" | "deny"
type Rule = Action | Record<string, Action>

export function loadSquad(dir: string): Record<string, SquadAgent> {
  const agents: Record<string, SquadAgent> = {}
  let files: string[] = []
  try {
    files = readdirSync(join(dir, "agents")).filter((f) => f.endsWith(".md"))
  } catch {
    return agents
  }
  for (const file of files) {
    const raw = readFileSync(join(dir, "agents", file), "utf8")
    const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw)
    const front = match?.[1] ?? ""
    const name = file.replace(/\.md$/, "")
    agents[name] = {
      name,
      description: /^description:\s*(.+)$/m.exec(front)?.[1]?.trim() ?? name,
      mode: (/^mode:\s*(\w+)/m.exec(front)?.[1] as SquadAgent["mode"]) ?? "all",
      readOnly: /^\s+edit:\s*deny/m.test(front),
      prompt: (match?.[2] ?? raw).trim(),
    }
  }
  return agents
}

/**
 * Política de permissões no formato do `permission` do kilo.jsonc. Padrões com `*`,
 * e a última regra que casa vence (o `"*": "ask"` vem primeiro, as exceções depois).
 */
export class Policy {
  private rules: Record<string, Rule>
  private always: { key: string; pattern: string }[] = []

  constructor(rules: Record<string, Rule>) {
    this.rules = rules
  }

  static fromKiloConfig(dir: string): Policy {
    try {
      const text = readFileSync(join(dir, "kilo.jsonc"), "utf8")
        .split("\n")
        .filter((l) => !/^\s*\/\//.test(l))
        .join("\n")
      return new Policy(JSON.parse(text).permission ?? {})
    } catch {
      return new Policy({})
    }
  }

  evaluate(key: string, value: string): Action {
    if (this.always.some((a) => a.key === key && wildcard(a.pattern, value))) return "allow"
    const rule = this.rules[key]
    if (rule === undefined) return "ask"
    if (typeof rule === "string") return rule
    let result: Action = "ask"
    for (const [pattern, action] of Object.entries(rule)) if (wildcard(pattern, value)) result = action
    return result
  }

  /** "Sempre permitir" da UI: vale até a sandbox morrer. */
  allowAlways(key: string, pattern: string) {
    this.always.push({ key, pattern })
  }
}

function wildcard(pattern: string, value: string) {
  const re = new RegExp("^" + pattern.split("*").map(escape).join(".*") + "$", "s")
  return re.test(value)
}

function escape(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
}

/** Padrão sugerido para "Sempre": o comando sem argumentos (igual ao Kilo). */
export function alwaysPattern(key: string, value: string) {
  if (key === "bash") return (value.trim().split(/\s+/)[0] ?? value) + " *"
  return "*"
}
