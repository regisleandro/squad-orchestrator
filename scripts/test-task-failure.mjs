import { build } from "../web/node_modules/esbuild/lib/main.js"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const root = fileURLToPath(new URL("../", import.meta.url))
const output = join(mkdtempSync(join(tmpdir(), "squad-failure-tests-")), "tests.cjs")
await build({
  entryPoints: [join(root, "scripts/task-failure.test.tsx")],
  outfile: output,
  bundle: true,
  platform: "node",
  format: "cjs",
  jsx: "automatic",
  nodePaths: [join(root, "web/node_modules")],
  define: { "import.meta.env": "{}" },
})
const result = spawnSync(process.execPath, [output], { stdio: "inherit" })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
