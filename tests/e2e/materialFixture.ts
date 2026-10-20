/** Synthetic protocol substitute. Loaded only by the guarded test/mock worker. No HTTP control surface. */
import fs from 'node:fs';
import { newId } from '../../src/db/connection.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { registerMaterialAnswers } from '../../src/materials/answers.js';
import { registerMaterialGrading } from '../../src/materials/grading.js';
import { MaterialProviderError } from '../../src/materials/provider.js';
import type { CloudAssemblyOverrides } from '../../src/mobile/cloudAssembly.js';
import type { Fragment } from '../../src/materials/contracts.js';
export type FixturePage = { parts: Array<Partial<Fragment>>; code?: string; date?: string; delayMs?: number; failOnce?: boolean };
export type FixtureControl = { pages?: FixturePage[]; delayMs?: number; failOnce?: ('answer'|'grade')[] };
export const configureMaterials: NonNullable<CloudAssemblyOverrides['configureMaterials']> = (jobs, uploads) => {
  const control = (): FixtureControl => JSON.parse(fs.readFileSync(process.env.SEL_E2E_MATERIAL_CONTROL!, 'utf8'));
  const register = jobs.register.bind(jobs);
  const failed = new Set<string>();
  jobs.register = (kind, handler) => register(kind, async (id, signal) => {
    const config=control();
    await new Promise<void>((resolve,reject)=>{const timer=setTimeout(resolve,config.delayMs??40);signal.addEventListener('abort',()=>{clearTimeout(timer);reject(signal.reason)},{once:true});});
    if(kind!=='extract'&&config.failOnce?.includes(kind)&&!failed.has(kind)){failed.add(kind);throw new MaterialProviderError('provider_unavailable','合成服务暂时不可用，请重试。',true);}
    await handler(id,signal);
  });
  registerMaterialAnswers(jobs.store,jobs,uploads,{mode:'mock'});
  registerMaterialGrading(jobs.store,jobs,uploads,{mode:'mock'});
  jobs.register('extract',async(id,signal)=>{
    const row=jobs.store.db.prepare('SELECT asset_id FROM material_job WHERE id=? AND owner_id=?').get(id,jobs.store.studentId) as {asset_id:string};
    const assets=jobs.store.db.prepare('SELECT id FROM material_asset WHERE owner_id=? ORDER BY rowid').all(jobs.store.studentId) as {id:string}[];
    const page=control().pages?.[assets.findIndex(a=>a.id===row.asset_id)]??{parts:[{role:'question',text:'1 + 1 = ?'},{role:'student_work',text:'3'},{role:'reference_answer',text:'2'}]};
    if(page.delayMs)await new Promise(resolve=>setTimeout(resolve,page.delayMs));
    if(page.failOnce&&!failed.has(id)){failed.add(id);throw new MaterialProviderError('provider_unavailable','合成提取暂时失败，原图已保存。',true);}
    await extractMaterial(jobs.store,{extract:async input=>jobs.request(id,'synthetic-extraction',async()=>({assetId:input.assetId,revision:input.revision,document:{title:'Synthetic acceptance paper',subject:'数学',date:page.date??null,printedCode:page.code??null,page:1},fragments:page.parts.map((part,order)=>({assetId:input.assetId,sourceHash:uploads.source(input.assetId).sourceHash,fragmentId:newId('mfr'),revision:input.revision,role:'question',text:'1 + 1 = ?',number:'1',subpart:null,page:1,order,box:{x:0,y:order/page.parts.length,width:1,height:1/page.parts.length},requiresDiagram:false,check:'passed',uncertainties:[],...part})),warnings:['synthetic_acceptance_only'],runs:[]}))},id,signal);
  });
};
