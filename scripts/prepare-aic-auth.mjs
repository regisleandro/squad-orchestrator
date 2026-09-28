// Exporta somente as credenciais da conta AI Cockpit para as sandboxes Docker.
// Nunca imprime o conteúdo nem o inclui na imagem.
import { readFile, mkdir, writeFile, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { randomUUID } from "node:crypto"

const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
const source = process.env.AIC_AUTH_SOURCE || join(dataHome, "aicockpit", "auth.json")
const target = resolve(process.env.AIC_AUTH_OUTPUT || ".data/aic-auth.json")
const auth = JSON.parse(await readFile(source, "utf8"))
const selected = Object.fromEntries(
  ["aicockpit-v2", "aicockpit"].filter((name) => auth[name]).map((name) => [name, auth[name]]),
)
if (!Object.keys(selected).length) throw new Error("Nenhuma credencial da conta AI Cockpit foi encontrada")

await mkdir(dirname(target), { recursive: true, mode: 0o700 })
const temporary = `${target}.${randomUUID()}.tmp`
await writeFile(temporary, JSON.stringify(selected), { mode: 0o600, flag: "wx" })
await rename(temporary, target)
console.log(`Credenciais AI Cockpit preparadas em ${target}`)
