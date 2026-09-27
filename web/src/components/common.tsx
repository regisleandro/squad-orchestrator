import type { TaskStatus } from "../api"

export const STATUS_LABEL: Record<TaskStatus, string> = {
  queued: "Na fila",
  provisioning: "Criando sandbox",
  starting: "Subindo o agente",
  running: "Trabalhando",
  waiting_permission: "Aguardando você",
  idle: "Concluído",
  error: "Erro",
  stopped: "Encerrado",
}

export function StatusDot({ status }: { status: string }) {
  const cls = status === "waiting_permission" ? "waiting" : status === "busy" ? "running" : status
  return <span className={`dot ${cls}`} aria-hidden />
}

export function StatusTag({ status }: { status: TaskStatus }) {
  const variant = status === "waiting_permission" ? "solid" : status === "error" ? "alert" : ""
  return (
    <span className={`tag ${variant}`}>
      <StatusDot status={status} />
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

export function repoName(url: string) {
  return url.replace(/^(https:\/\/|git@)[^/:]+[/:]/, "").replace(/\.git$/, "")
}

export function timeAgo(ts: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.round(s / 60)}min`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

export function clock(ts: number) {
  return new Date(ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}
