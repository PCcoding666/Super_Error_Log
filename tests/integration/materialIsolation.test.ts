/** Authenticated parent gateway + separate real worker databases. No router/auth bypass. */
import { afterEach, expect, it } from 'vitest';
import fs from 'node:fs';
import sharp from 'sharp';
import { materialGateway, type MaterialGateway } from '../helpers/materialGateway.js';
const active:MaterialGateway[]=[];afterEach(async()=>{for(const g of active.splice(0))await g.close();});
class Browser {
 cookies=new Map<string,string>();namespace='';
 constructor(readonly base:string){}
 async request(url:string,init:RequestInit={}){const headers=new Headers(init.headers);headers.set('accept','application/json');if(this.cookies.size)headers.set('cookie',[...this.cookies].map(([k,v])=>`${k}=${v}`).join('; '));if(init.method==='POST'){if(!headers.has('origin'))headers.set('origin',this.base);if(!headers.has('x-draft-namespace'))headers.set('x-draft-namespace',this.namespace);}
 const response=await fetch(this.base+url,{...init,headers,redirect:'manual'});for(const line of response.headers.getSetCookie()){const pair=line.split(';')[0]!;const i=pair.indexOf('=');this.cookies.set(pair.slice(0,i),pair.slice(i+1));}return response;}
 post(url:string,body:unknown,headers:Record<string,string>={}){return this.request(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify(body)});}
 async login(code:string){expect((await this.request('/s/login',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code})})).status).toBe(303);this.namespace=(await(await this.request('/s/materials/session')).json()).draftNamespace;}
}
async function setup(){const g=await materialGateway({pages:[{code:'SAME',parts:[{role:'question',text:'Same 1 + 1'},{role:'student_work',text:'3'},{role:'reference_answer',text:'2'}]}]});active.push(g);const a=new Browser(g.base),b=new Browser(g.base),anonymous=new Browser(g.base);await a.login(g.codes[0]!);await b.login(g.codes[1]!);const photo=await sharp({create:{width:80,height:120,channels:3,background:'#fff'}}).jpeg().toBuffer();
 for(const browser of [a,b]){const cap=await(await browser.post('/s/materials/captures',{requestId:crypto.randomUUID()})).json();const form=new FormData();form.append('photo',new Blob([new Uint8Array(photo)]),'same.jpg');form.append('captureId',cap.id);form.append('hints',JSON.stringify({label:'同题号同标签同文件'}));expect((await browser.request('/s/materials/uploads',{method:'POST',headers:{'x-upload-id':crypto.randomUUID()},body:form})).status).toBe(200);}
 for(const student of [0,1])await expect.poll(async()=>{const s=await g.snapshot(student);return s.material_job!.every(j=>j.state==='succeeded')}).toBe(true);
 return {g,a,b,anonymous};}
it('rejects every protected URL without auth, every foreign resource, CSRF mutation and foreign reference without changing A',async()=>{
 const {g,a,b,anonymous}=await setup();const before=await g.snapshot(0),other=await g.snapshot(1);const q=before.material_question![0]!,asset=before.material_asset![0]!,fragment=before.material_fragment![0]!,attempt=before.material_attempt![0]!,answer=before.material_answer![0]!,job=before.material_job![0]!;const own=other.material_question![0]!,ownAsset=other.material_asset![0]!;
 const reads=['/s/capture','/s/materials','/s/materials/session','/s/materials/answers/imports',`/s/capture?questionId=${q.id}&attemptId=${attempt.id}`,`/s/materials/questions/${q.id}`,`/s/materials/questions/${q.id}/answers`,`/s/materials/assets/${asset.id}/match`,`/s/materials/assets/${asset.id}/image`,`/s/materials/fragments/${fragment.id}/crop`];
 const writes:Array<[string,Record<string,unknown>]>=[['/s/capture',{}],['/s/materials/captures',{requestId:crypto.randomUUID()}],['/s/materials/uploads',{}],[`/s/materials/questions/${q.id}/inclusion`,{included:true,expectedRevision:q.revision}],[`/s/materials/assets/${asset.id}/hints`,{label:'malicious'}],[`/s/materials/assets/${asset.id}/document`,{documentId:q.document_id,expectedRevision:asset.link_revision}],['/s/materials/answers/manual',{questionId:q.id,subpart:null,text:'bad',expectedRevision:q.revision}],['/s/materials/answers/import',{documentId:q.document_id,text:'1. bad'}],['/s/materials/answers/generate',{questionIds:[q.id],requestId:crypto.randomUUID()}],['/s/materials/answers/basis',{questionId:q.id,answerIds:[answer.id],expectedRevision:q.revision}],['/s/materials/grades',{questionIds:[q.id],attemptId:attempt.id,requestId:crypto.randomUUID()}],['/s/materials/links',{fragmentIds:[fragment.id],questionId:q.id,expectedRevision:3}],[`/s/materials/links/${before.material_link_event![0]!.id}/undo`,{expectedRevision:3}],[`/s/materials/jobs/${job.id}/retry`,{requestId:crypto.randomUUID()}]];
 const matrix:Array<{method:string;path:string;identity:string;status:number}>=[];
 for(const url of reads){const r=await anonymous.request(url);matrix.push({method:'GET',path:url,identity:'anonymous',status:r.status});expect(r.status,url).toBe(200);expect(await r.text()).toContain('12 位邀请码');}
 for(const [url,body] of writes){for(const [identity,browser,headers,status] of [['anonymous',anonymous,{},401],['csrf',a,{origin:'https://foreign.invalid'},403],['stale-namespace',a,{'x-draft-namespace':b.namespace},409]] as const){const r=await browser.post(url,body,headers);matrix.push({method:'POST',path:url,identity,status:r.status});expect(r.status,identity+' '+url).toBe(status);}}
 const foreignReads=reads.slice(4);for(const url of foreignReads){const r=await b.request(url);matrix.push({method:'GET',path:url,identity:'student-B',status:r.status});expect(r.status,url).toBe(404);}
 for(const [url,body] of writes.slice(3)){const r=await b.post(url,body);matrix.push({method:'POST',path:url,identity:'student-B',status:r.status});expect(r.status,url).toBe(404);}
 const references:Array<[string,Record<string,unknown>,number]>=[
 [`/s/materials/assets/${ownAsset.id}/document`,{candidateAssetId:asset.id,candidateRevision:asset.link_revision,expectedRevision:ownAsset.link_revision},404],
 [`/s/materials/assets/${ownAsset.id}/hints`,{assetIds:[asset.id],label:'bad'},404],
 ['/s/materials/links',{questionId:own.id,fragmentIds:[fragment.id],expectedRevision:3},404],
 ['/s/materials/grades',{questionIds:[own.id],attemptId:attempt.id,requestId:crypto.randomUUID()},200],
 ['/s/materials/answers/basis',{questionId:own.id,answerIds:[answer.id],expectedRevision:own.revision},400],
 ];
 for(const [url,body,status] of references){const r=await b.post(url,body);matrix.push({method:'POST',path:url,identity:'foreign-reference',status:r.status});expect(r.status,url).toBe(status);if(url==='/s/materials/grades'){const body=await r.json();expect(body.jobs).toEqual([]);expect(body.skipped[0].reason).toBe('所选作答不存在');}}
 const image=await sharp({create:{width:32,height:32,channels:3,background:'#fff'}}).jpeg().toBuffer();
 for(const [captureId,hints] of [[asset.capture_id,{}],[ownAsset.capture_id,{questionId:q.id}],[ownAsset.capture_id,{questionId:own.id,attemptId:attempt.id}],[ownAsset.capture_id,{documentId:q.document_id}]] as const){const form=new FormData();form.append('captureId',captureId);form.append('hints',JSON.stringify(hints));form.append('photo',new Blob([new Uint8Array(image)]),'same.jpg');const r=await b.request('/s/materials/uploads',{method:'POST',headers:{'x-upload-id':crypto.randomUUID()},body:form});matrix.push({method:'POST',path:'/s/materials/uploads',identity:'foreign-upload-reference',status:r.status});expect(r.status).toBe(404);}
 expect(await g.snapshot(0)).toEqual(before);expect(await g.snapshot(1)).toEqual(other);
 fs.mkdirSync('/tmp/task10-material',{recursive:true});fs.writeFileSync('/tmp/task10-material/isolation-matrix.json',JSON.stringify(matrix,null,2));
},60000);
it('accepts 40000 Chinese characters through parent auth and rejects stale CAS, invalid limits and oversized body',async()=>{
 const {g,a}=await setup();const s=await g.snapshot();const q=s.material_question![0]!;const body={questionId:q.id,subpart:null,text:'答'.repeat(40000),claimedSource:'合成输入',expectedRevision:q.revision};
 expect((await a.post('/s/materials/answers/manual',body)).status).toBe(200);expect((await a.post('/s/materials/answers/manual',body)).status).toBe(409);expect((await a.post('/s/materials/answers/manual',{...body,text:'答'.repeat(40001)})).status).toBe(400);expect((await a.post('/s/materials/answers/manual',{...body,claimedSource:'源'.repeat(201)})).status).toBe(400);expect((await a.post('/s/materials/answers/manual',{...body,text:'x'.repeat(530000)})).status).toBe(413);
 const after=await g.snapshot();expect(after.material_answer!.find(r=>r.source==='manual')!.content_json).toContain('答'.repeat(40000));expect(after.material_job!.filter(j=>j.kind!=='extract')).toHaveLength(0);
},60000);
