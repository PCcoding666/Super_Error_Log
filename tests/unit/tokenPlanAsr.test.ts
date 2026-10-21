import { afterEach, describe, expect, it, vi } from 'vitest';
import { ASR_BAILIAN_ENDPOINT, ASR_NATIVE_ENDPOINT, createTranscriber } from '../../src/ai/asr.js';
const primary='https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation';
const cfg={aiMode:'bailian',aiBaseUrl:ASR_BAILIAN_ENDPOINT,aiApiKey:'synthetic-backup',aiAsrModel:'qwen-audio-3.1-asr-flash',aiTimeoutMs:1000};
const ok=()=>new Response(JSON.stringify({output:{text:'合成转写'},usage:{duration:5}}));
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});
describe('Token Plan ASR primary and native backup',()=>{
 it('uses backup after primary timeout and preserves the same audio bytes',async()=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');
  const fetcher=vi.fn().mockImplementationOnce((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}))).mockResolvedValueOnce(ok());vi.stubGlobal('fetch',fetcher);
  expect(await createTranscriber({...cfg,aiTimeoutMs:10}).transcribe(Buffer.from('synthetic'),'audio/mp4')).toBe('合成转写');
  expect(fetcher).toHaveBeenCalledTimes(2);
  const bodies=fetcher.mock.calls.map(c=>JSON.parse(c[1].body));expect(bodies[0].input).toEqual(bodies[1].input);
 });
 it.each(['audio/mp4','audio/webm;codecs=opus'])('uses the native Token Plan endpoint and requested model (%s)',async mime=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');
  const fetcher=vi.fn().mockImplementation(ok);vi.stubGlobal('fetch',fetcher);
  expect(await createTranscriber(cfg).transcribe(Buffer.from('synthetic-audio'),mime)).toBe('合成转写');
  expect(fetcher).toHaveBeenCalledTimes(1);expect(fetcher.mock.calls[0]![0]).toBe(primary);
  const init=fetcher.mock.calls[0]![1];expect(init.headers.authorization).toBe('Bearer synthetic-plan');
  const body=JSON.parse(init.body);expect(body.model).toBe('qwen-audio-3.0-asr-flash');
  expect(body.parameters.format).toBe(mime.startsWith('audio/webm')?'webm':'m4a');
  expect(init.body).not.toContain('synthetic-plan');
 });
 it.each([401,403,404,408,429,500,503])('uses the original key/model once after HTTP %s',async status=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');
  const fetcher=vi.fn().mockResolvedValueOnce(new Response('{}',{status})).mockResolvedValueOnce(ok());vi.stubGlobal('fetch',fetcher);
  expect(await createTranscriber(cfg).transcribe(Buffer.from('synthetic'),'audio/mp4')).toBe('合成转写');
  expect(fetcher).toHaveBeenCalledTimes(2);expect(fetcher.mock.calls[1]![0]).toBe(ASR_NATIVE_ENDPOINT);
  expect(fetcher.mock.calls[1]![1].headers.authorization).toBe('Bearer synthetic-backup');
  expect(JSON.parse(fetcher.mock.calls[1]![1].body).model).toBe(cfg.aiAsrModel);
 });
 it.each([200,400,422])('does not hide malformed output or bad input (HTTP %s)',async status=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');
  const fetcher=vi.fn().mockResolvedValue(new Response('{}',{status}));vi.stubGlobal('fetch',fetcher);
  await expect(createTranscriber(cfg).transcribe(Buffer.from('synthetic'),'audio/mp4')).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('bounds network failures to one primary and one backup attempt',async()=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');
  const fetcher=vi.fn().mockRejectedValue(new Error('private provider detail'));vi.stubGlobal('fetch',fetcher);
  await expect(createTranscriber(cfg).transcribe(Buffer.from('synthetic'),'audio/mp4')).rejects.toThrow('暂时连不上');expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it('does not start backup when the caller cancels',async()=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');
  const fetcher=vi.fn().mockImplementation((_url,init)=>new Promise((_resolve,reject)=>init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})));vi.stubGlobal('fetch',fetcher);
  const controller=new AbortController();const pending=createTranscriber(cfg).transcribe(Buffer.from('synthetic'),'audio/mp4',controller.signal);
  await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));controller.abort(new Error('cancelled'));
  await expect(pending).rejects.toThrow();expect(fetcher).toHaveBeenCalledTimes(1);
 });
 it('keeps original routing without the Token Plan key and keeps mock offline',async()=>{
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','');const fetcher=vi.fn().mockImplementation(ok);vi.stubGlobal('fetch',fetcher);
  await createTranscriber(cfg).transcribe(Buffer.from('synthetic'),'audio/mp4');expect(fetcher.mock.calls[0]![0]).toBe(ASR_NATIVE_ENDPOINT);
  vi.stubEnv('SEL_TOKEN_PLAN_API_KEY','synthetic-plan');await createTranscriber({...cfg,aiMode:'mock'}).transcribe(Buffer.from('synthetic'),'audio/mp4');expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
