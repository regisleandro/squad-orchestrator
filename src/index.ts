// Bootstrap do servidor HTTP do orquestrador.

import { createServer } from "node:http"
import { loadConfig } from "./config.js"
import { Orchestrator } from "./orchestrator.js"
import { Relay } from "./relay.js"
import { createRouter } from "./routes.js"
import { createDriver } from "./sandbox.js"
import { TaskStore } from "./store.js"

const cfg = loadConfig()
const store = new TaskStore(cfg.dataDir)
const relay = new Relay(store)
const orch = new Orchestrator(cfg, store, relay, createDriver(cfg))
await orch.restore()
orch.startReaper()

const server = createServer(createRouter({ cfg, store, relay, orch }))
server.listen(cfg.port, () => {
  console.log(`squad-orchestrator ouvindo em :${cfg.port} (driver=${cfg.sandboxDriver})`)
})

let closing = false
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, async () => {
    if (closing) process.exit(1)
    closing = true
    console.log(`${signal}: encerrando sandboxes...`)
    server.close()
    server.closeAllConnections()
    await orch.shutdown()
    process.exit(0)
  })
}
