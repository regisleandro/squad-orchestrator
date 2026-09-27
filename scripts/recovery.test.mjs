import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TaskStore } from '../dist/store.js'
import { Relay } from '../dist/relay.js'
import { Orchestrator } from '../dist/orchestrator.js'
import { KiloClient } from '../dist/kilo.js'
const dir=await mkdtemp(join(tmpdir(),'squad-recovery-test-'))
const store=new TaskStore(dir)
const task=store.create('test',{repoUrl:'https://example.com/repo',prompt:'Tarefa',agent:'lead',harness:'kilo'})
store.update(task.id,{status:'idle',sessionID:'root'})
const ended=store.create('test',{repoUrl:'https://example.com/repo',prompt:'Encerrada',agent:'lead',harness:'kilo'})
store.update(ended.id,{status:'stopped',sessionID:'ended'})
const recovered=new TaskStore(dir)
assert.deepEqual(recovered.recoveryCandidates().map(c=>c.task.id),[task.id])
const originals={waitHealthy:KiloClient.prototype.waitHealthy,subscribe:KiloClient.prototype.subscribe,status:KiloClient.prototype.status}
let prompts=0
const originalPrompt=KiloClient.prototype.promptAsync
KiloClient.prototype.promptAsync=async()=>{prompts++}
KiloClient.prototype.waitHealthy=async()=> 'test'
KiloClient.prototype.subscribe=async(_handler,_signal,onState)=>onState?.('open')
KiloClient.prototype.status=async()=>({root:{type:'idle'}})
const relay=new Relay(recovered)
const handle={id:'surviving-container',baseUrl:'http://invalid',directory:'/repo',password:'not-a-key',harness:'kilo'}
const driver={restore:async()=>handle,provision:async()=>{throw new Error('Não pode provisionar novamente')},destroy:async()=>{throw new Error('Não pode destruir na recuperação')}}
try {
 const orch=new Orchestrator({},recovered,relay,driver)
 await orch.restore()
 assert.equal(recovered.get(task.id).status,'idle')
 assert.equal(recovered.get(task.id).error,undefined)
 assert.equal(recovered.get(task.id).sandbox.id,handle.id)
 assert.equal(recovered.get(ended.id).status,'stopped')
 assert.equal(prompts,0)
 console.log('PASS: reconecta sandbox sobrevivente, não reenvia prompt e respeita encerramento explícito')
} finally {
 relay.detach(task.id)
 Object.assign(KiloClient.prototype,originals)
 KiloClient.prototype.promptAsync=originalPrompt
}
