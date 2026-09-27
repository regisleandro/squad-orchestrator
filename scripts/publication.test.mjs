import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, writeFile, readFile, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { Publisher } from '../dist/publication.js'
import { TaskStore } from '../dist/store.js'
import { Relay } from '../dist/relay.js'
import { createRouter } from '../dist/routes.js'
const exec = promisify(execFile)

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'squad-publication-'))
  const repo = join(root, 'repo')
  const remote = join(root, 'remote.git')
  await exec('git', ['init', '--initial-branch=main', repo])
  await exec('git', ['init', '--bare', remote])
  const git = (args) => exec('git', args, { cwd: repo })
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.com'])
  await writeFile(join(repo, 'README.md'), '# Before\n')
  await git(['add', '.'])
  await git(['commit', '-m', 'initial'])
  await git(['remote', 'add', 'origin', 'https://github.com/example/repo.git'])
  await git(['update-ref', 'refs/squad/base', 'HEAD'])
  await git(['update-ref', 'refs/remotes/origin/main', 'HEAD'])
  await git(['config', 'squad.baseBranch', 'main'])
  await git(['checkout', '-b', 'squad/test'])
  const store = new TaskStore(join(root, 'data'))
  const task = store.create('test', { repoUrl: 'https://github.com/example/repo', prompt: 'Adicionar resultado', agent: 'squad-lead', harness: 'kilo' })
  store.update(task.id, { sessionID: 'root', status: 'idle', sandbox: { id: 'test', directory: repo, harness: 'kilo', password: 'not-a-key', baseUrl: 'http://invalid' } })
  const state = { calls: [], pushes: 0, creates: 0, commits: 0, pulls: [], deny: false, noToken: false, failPush: false, lostResponse: false, block: undefined }
  const driver = { async execute(handle, command, args, input) {
    if (command === 'node') {
      const request = JSON.parse(input)
      state.calls.push(request)
      let reply
      if (state.noToken) reply = { ok: false, status: 400, message: 'GITHUB_TOKEN não chegou à sandbox' }
      else if (request.path.includes('/pulls?')) reply = { ok: true, data: state.pulls }
      else if (request.method === 'POST') {
        state.creates++
        const pull = { number: 7, html_url: 'https://github.com/example/repo/pull/7', state: 'open', draft: request.body.draft, head: { sha: (await git(['rev-parse', 'HEAD'])).stdout.trim() } }
        state.pulls.push(pull)
        reply = state.lostResponse ? { ok: false, status: 502, message: 'Resposta perdida' } : { ok: true, data: pull }
      } else {
        if (state.block) await state.block
        reply = { ok: true, data: { default_branch: 'main', permissions: { push: !state.deny } } }
      }
      return { code: 0, stderr: '', stdout: JSON.stringify(reply) }
    }
    assert.equal(command, 'git')
    if (args[0] === 'push') {
      state.pushes++
      assert.equal(args.includes('--force'), false)
      if (state.failPush) return { code: 1, stderr: 'permission denied', stdout: '' }
      args = ['push', remote, ...args.slice(2)]
    }
    if (args[0] === 'commit') state.commits++
    try { const r = await git(args); return { ...r, code: 0 } }
    catch (err) { return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', code: typeof err.code === 'number' ? err.code : 1 } }
  }}
  const publisher = new Publisher(store, new Relay(store), driver)
  const input = (preview) => ({ title: 'feat: adicionar resultado', body: 'Mudança revisada. Testes executados.', version: preview.version, reviewed: true, draft: true })
  const change = () => writeFile(join(repo, 'README.md'), '# After\n\nNovo resultado.\n')
  return { root, repo, remote, git, store, task, state, driver, publisher, input, change }
}

// Git real, mudanças novas e já rastreadas, shell literals e persistência.
{
 const f = await fixture(); await f.change(); await writeFile(join(f.repo,'novo.txt'),'arquivo novo\n')
 const p = await f.publisher.preview(f.task)
 assert.equal(p.files,2); assert.equal(p.hasUncommitted,true); assert.match(p.diff,/arquivo novo/)
 const i = f.input(p); i.title = 'feat: literal $(touch SHOULD_NOT_EXIST)'; i.body = 'Texto\ncom `backticks` e $(shell) literais.'
 const result = await f.publisher.publish(f.task,i)
 assert.equal(result.number,7); assert.equal(f.state.pushes,1); assert.equal(f.state.creates,1); assert.equal(f.state.commits,1)
 assert.equal(f.state.calls.find(c=>c.method==='POST').body.body,i.body)
 assert.match((await f.git(['log','-1','--format=%s'])).stdout,/\$\(touch/)
 await assert.rejects(readFile(join(f.repo,'SHOULD_NOT_EXIST')),/ENOENT/)
 assert.equal((await exec('git',['--git-dir',f.remote,'rev-parse','refs/heads/squad/test'])).stdout.trim(),result.commit)
 assert.deepEqual(await f.publisher.publish(f.task,i),result); assert.equal(f.state.creates,1)
 const restored = new TaskStore(join(f.root,'data')).get(f.task.id)
 assert.deepEqual(restored.publication.result,result)
 console.log('PASS: revisão, commit, push local, PR, shell literals, idempotência e persistência')
}
// Rejeita conteúdo alterado e mantém a revisão humana obrigatória.
{
 const f = await fixture(); await f.change(); const p = await f.publisher.preview(f.task)
 await assert.rejects(f.publisher.publish(f.task,{...f.input(p),reviewed:false}),/Confirme/)
 await writeFile(join(f.repo,'README.md'),'Mudou depois da revisão\n')
 await assert.rejects(f.publisher.publish(f.task,f.input(p)),/alteradas desde/)
 assert.equal(f.state.commits,0); assert.equal(f.state.pushes,0)
 console.log('PASS: revisão obrigatória e conteúdo alterado bloqueado antes do commit')
}
// Não publica alterações feitas por hooks sem uma nova revisão.
{
 const f = await fixture(); await f.change(); const p = await f.publisher.preview(f.task)
 const hook=join(f.repo,'.git/hooks/post-commit'); await writeFile(hook,'#!/bin/sh\nprintf "hook mudou o conteúdo\\n" >> README.md\n'); await chmod(hook,0o755)
 await assert.rejects(f.publisher.publish(f.task,f.input(p)),/mudou durante o commit/)
 assert.equal(f.state.pushes,0); assert.equal(f.state.creates,0)
 console.log('PASS: alterações por hook bloqueadas antes do push')
}
// Usa commits do agente e recupera resposta perdida sem PR duplicado.
{
 const f=await fixture(); await f.change(); await f.git(['add','.']); await f.git(['commit','-m','feito pelo agente'])
 const p=await f.publisher.preview(f.task); assert.equal(p.hasUncommitted,false)
 f.state.lostResponse=true; await f.publisher.publish(f.task,f.input(p))
 assert.equal(f.state.commits,0); assert.equal(f.state.creates,1); assert.equal(f.task.publication.status,'published')
 console.log('PASS: commits existentes e resposta perdida após criar PR')
}
// Falha no push não cria PR, e nova tentativa usa o mesmo commit.
{
 const f=await fixture(); await f.change(); let p=await f.publisher.preview(f.task); f.state.failPush=true
 await assert.rejects(f.publisher.publish(f.task,f.input(p)),/permission denied/)
 assert.equal(f.state.creates,0); assert.equal(f.task.publication.step,'pushing')
 f.state.failPush=false; p=await f.publisher.preview(f.task); await f.publisher.publish(f.task,f.input(p))
 assert.equal(f.state.commits,1); assert.equal(f.state.creates,1)
 console.log('PASS: falha no push recuperável sem commit ou PR duplicado')
}
// A segunda publicação não inicia em paralelo; turno em andamento é bloqueado.
{
 const f=await fixture(); await f.change(); const p=await f.publisher.preview(f.task)
 let release; f.state.block=new Promise(r=>release=r)
 const first=f.publisher.publish(f.task,f.input(p))
 await assert.rejects(f.publisher.publish(f.task,f.input(p)),/em andamento/)
 release(); await first
 const g=await fixture(); g.store.update(g.task.id,{status:'running'})
 await assert.rejects(g.publisher.preview(g.task),/turno concluir/)
 console.log('PASS: concorrência e turno ativo bloqueados')
}
// Permissões, credencial, branch incorreta, PR fechado e sandbox antiga.
{
 const f=await fixture(); await f.change(); f.state.deny=true
 await assert.rejects(f.publisher.preview(f.task),/escrita/)
 f.state.deny=false; f.state.noToken=true; await assert.rejects(f.publisher.preview(f.task),/GITHUB_TOKEN/)
 f.state.noToken=false; await f.git(['checkout','main']); await assert.rejects(f.publisher.preview(f.task),/branch squad/)
 await f.git(['checkout','squad/test']); await f.git(['update-ref','-d','refs/squad/base']); await f.git(['config','--unset','squad.baseBranch'])
 const p=await f.publisher.preview(f.task); assert.equal(p.baseBranch,'main')
 f.state.pulls=[{state:'closed'}]; await assert.rejects(f.publisher.publish(f.task,f.input(p)),/fechado ou mesclado/)
 assert.equal(f.state.pushes,0)
 console.log('PASS: credencial, permissões, branch, PR fechado e compatibilidade com sandbox antiga')
}
// Endpoints só aceitam tarefa do usuário autenticado.
{
 const f=await fixture(); await f.change()
 const route=createRouter({cfg:{apiToken:'test'},store:f.store,relay:new Relay(f.store),orch:{publisher:f.publisher}})
 const request=async(method,url,authorization,body)=>{
  const req=Readable.from(body?[JSON.stringify(body)]:[]); req.method=method; req.url=url; req.headers={authorization}
  const response={statusCode:200,headersSent:false,setHeader(){},writeHead(status){this.statusCode=status;this.headersSent=true;return this},end(text){this.text=text;return this}}
  await route(req,response);return response
 }
 assert.equal((await request('GET',`/tasks/${f.task.id}/publication`,'Bearer wrong')).statusCode,401)
 f.store.update(f.task.id,{owner:'other'})
 assert.equal((await request('GET',`/tasks/${f.task.id}/publication`,'Bearer test')).statusCode,404)
 f.store.update(f.task.id,{owner:'poc-user'})
 const r=await request('GET',`/tasks/${f.task.id}/publication`,'Bearer test');assert.equal(r.statusCode,200)
 assert.equal((await request('POST',`/tasks/${f.task.id}/publication`,'Bearer test',{...f.input(JSON.parse(r.text)),reviewed:false})).statusCode,400)
 console.log('PASS: autenticação, isolamento entre usuários e validação dos endpoints')
}
