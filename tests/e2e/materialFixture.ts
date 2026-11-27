/** Synthetic protocol substitute. Loaded only by the guarded test/mock worker. No HTTP control surface. */
import fs from 'node:fs';
import { newId } from '../../src/db/connection.js';
import { extractMaterial } from '../../src/materials/extraction.js';
import { registerMaterialAnswers } from '../../src/materials/answers.js';
import { registerMaterialGrading } from '../../src/materials/grading.js';
import { MaterialProviderError } from '../../src/materials/provider.js';
import type { CloudAssemblyOverrides } from '../../src/mobile/cloudAssembly.js';
import type { Extraction, Fragment } from '../../src/materials/contracts.js';
import type { ExtractedMaterial } from '../../src/materials/provider.js';
import { unsupportedSubject } from '../../src/materials/subjects.js';
export type FixturePage = { parts: Array<Partial<Fragment>>; code?: string; date?: string; delayMs?: number; failOnce?: boolean; failAlways?: boolean; subject?: string };
export type FixtureControl = { progressStage?: 'located'|'read'|'done'; pages?: FixturePage[]; delayMs?: number; failOnce?: ('answer'|'grade')[] };
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
    if(page.failAlways)throw new MaterialProviderError('provider_unavailable','合成提取暂时失败，原图已保存。',true);
    await extractMaterial(jobs.store,{extract:async input=>{ const result = await jobs.request<ExtractedMaterial>(id,'synthetic-extraction',async()=>{
      const assetsNow=jobs.store.db.prepare('SELECT id FROM material_asset WHERE owner_id=? ORDER BY rowid').all(jobs.store.studentId) as {id:string}[];
      const specFor=(assetId:string):FixturePage=>{
        const configured=control().pages?.[assetsNow.findIndex(asset=>asset.id===assetId)];
        return configured??(assetId===input.assetId?page:{parts:[{role:'question',text:'1 + 1 = ?'}]});
      };
      const one=(assetId:string,revision:number,sourceHash:string):Extraction=>{
        const spec=specFor(assetId);
        const parts=unsupportedSubject(spec.subject)?[]:spec.parts;
        return {assetId,revision,document:{title:'Synthetic acceptance paper',subject:spec.subject??'数学',date:spec.date??null,printedCode:spec.code??null,page:1},fragments:parts.map((part,order)=>({assetId,sourceHash,fragmentId:newId('mfr'),revision,role:'question',text:'1 + 1 = ?',number:'1',subpart:null,page:1,order,box:{x:0,y:parts.length?order/parts.length:0,width:1,height:parts.length?1/parts.length:1},requiresDiagram:false,check:'passed',uncertainties:[],...part})),warnings:['synthetic_acceptance_only'],runs:[]};
      };
      const lead=one(input.assetId,input.revision,uploads.source(input.assetId).sourceHash);
      const pages=input.pages??[];
      if(pages.length<2)return lead;
      return {...lead,set:pages.map(item=>one(item.assetId,item.revision??input.revision,item.sourceHash??uploads.source(item.assetId).sourceHash))};
    });
      if (control().progressStage) {
        const waitWhile = async (stage: string) => { while(control().progressStage===stage) { signal.throwIfAborted(); await new Promise(resolve=>setTimeout(resolve,40)); } };
        await input.onProgress?.({phase:'located',extraction:{...result,fragments:result.fragments.map(f=>({...f,text:'',check:'unchecked'}))}});
        await waitWhile('located');
        await input.onProgress?.({phase:'enriching',extraction:{...result,fragments:result.fragments.map(f=>({...f,check:'unchecked'}))}});
        await waitWhile('read');
      }
      return result;
    }},id,signal);
  });
};
