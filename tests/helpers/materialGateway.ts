import { fork } from 'node:child_process';
import path from 'node:path';
import type { FixtureControl } from '../e2e/materialFixture.js';
export type Snapshot = Record<string, Array<Record<string, any>>>;
export async function materialGateway(config: FixtureControl = {}) {
 const child=fork(path.resolve('tests/e2e/studentHostServer.ts'),[],{execArgv:['--import','tsx'],env:{...process.env,NODE_ENV:'test',SEL_AI_MODE:'mock',SEL_E2E_MATERIAL_CAPTURE:'1',SEL_E2E_MATERIAL_JOURNEY:'1',SEL_E2E_MATERIAL_CONFIG:JSON.stringify(config)},stdio:['ignore','ignore','pipe','ipc']});
 let stderr='';child.stderr?.on('data',data=>{stderr+=String(data)});
 const ready=await new Promise<{base:string;codes:string[]}>((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('fixture startup timeout: '+stderr)),20000);child.once('message',m=>{clearTimeout(timer);resolve(m as {base:string;codes:string[]})});child.once('exit',()=>{clearTimeout(timer);reject(Error('fixture exited: '+stderr))});});
 async function command(action:string,student=0,config?:FixtureControl):Promise<Snapshot>{const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.off('message',listener);reject(Error('fixture command timeout'))},10000);const listener=(m:any)=>{if(m.id!==id)return;clearTimeout(timer);child.off('message',listener);if(m.error)reject(Error(m.error));else resolve(m.result);};child.on('message',listener);child.send({id,action,student,config});});}
 return {...ready,legacy:async(student=0)=>await command('legacy',student) as unknown as {jobId:string},snapshot:(student=0)=>command('snapshot',student),age:(student=0)=>command('age',student),configure:(config:FixtureControl)=>command('configure',0,config),close:async()=>{if(child.exitCode!==null)return;await new Promise<void>(resolve=>{const timer=setTimeout(()=>child.kill('SIGKILL'),10000);child.once('exit',()=>{clearTimeout(timer);resolve()});child.send({stop:true});});}};
}
export type MaterialGateway = Awaited<ReturnType<typeof materialGateway>>;
