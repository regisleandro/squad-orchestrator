import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PUBLICATION_EXEC } from '../dist/sandbox.js'

function run(request, env = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', PUBLICATION_EXEC], { env: { ...process.env, ...env } }, (error, stdout) => error ? reject(error) : resolve(stdout))
    child.stdin.end(JSON.stringify(request))
  })
}
const check = 'let input="";for await(const chunk of process.stdin)input+=chunk;console.log(JSON.stringify({current:process.env.GITHUB_TOKEN==="test-current",input,args:process.argv.slice(1)}))'
const output = JSON.parse(await run({ command: process.execPath, args: ['--input-type=module', '-e', check, 'literal-argument'], input: 'literal input', token: 'test-current' }, { GITHUB_TOKEN: 'old-token' }))
assert.equal(output.current, true)
assert.equal(output.input, 'literal input')
assert.deepEqual(output.args, ['literal-argument'])
const fallback = JSON.parse(await run({ command: process.execPath, args: ['--input-type=module', '-e', check], input: '' }, { GITHUB_TOKEN: 'test-current' }))
assert.equal(fallback.current, true)
const root = await mkdtemp(join(tmpdir(), 'squad-credential-'))
await writeFile(join(root, 'git'), `#!${process.execPath}\nconst args=process.argv.slice(2);console.log(JSON.stringify({current:process.env.GITHUB_TOKEN==='test-current',noninteractive:process.env.GIT_TERMINAL_PROMPT==='0',cleared:args[1]==='credential.helper=',helper:args[3]?.includes('$GITHUB_TOKEN'),push:args[4]==='push',noSecretArgument:!args.some(a=>a.includes('test-current'))}));\n`, { mode: 0o700 })
const push = JSON.parse(await run({ command: 'git', args: ['push', 'https://github.com/example/repo.git', 'abc:refs/heads/squad/test'], input: '', token: 'test-current' }, { PATH: `${root}:${process.env.PATH}` }))
assert.ok(Object.values(push).every(Boolean))
console.log('PASS: token atual por stdin, fallback da sandbox, argumentos sem segredo e helper temporário para push')
