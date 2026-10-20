import { assertTaskWritable, taskLifecycle } from './practiceTasks.js';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { getDb, newId } from '../db/connection.js';
import { getPractice } from './practiceService.js';
import { validateHandwriting, type HandwritingRecognizer } from '../ai/handwriting.js';

export interface PracticeWork { id: string; packet_id: string; item_id: string; status: string; text: string | null; uncertain: number; attempts: number }
const active = new Set<string>();
let lastReceived = 0;
function receivedAt(): string {
  lastReceived = Math.max(Date.now() * 1000, lastReceived + 1);
  return new Date(Math.floor(lastReceived / 1000)).toISOString().replace('Z', `${String(lastReceived % 1000).padStart(3,'0')}Z`);
}
export function latestWork(packetId: string, itemId: string): PracticeWork | null {
  return getDb().prepare('SELECT id, packet_id, item_id, status, text, uncertain, attempts FROM practice_work WHERE packet_id = ? AND item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(packetId, itemId) as unknown as PracticeWork ?? null;
}
export async function attachWork(packetId: string, itemId: string, key: string, bytes: Buffer): Promise<PracticeWork> {
  assertTaskWritable(packetId);
  if (!getPractice(packetId)?.items.some(item => item.id === itemId)) throw new Error('题目不在此练习中');
  if (!/^[0-9a-f-]{36}$/i.test(key)) throw new Error('上传标识无效，请重新选择照片');
  if (!bytes.length || bytes.length > 15 * 1024 * 1024) throw new Error('照片大小须在 15 MB 以内');
  const hash = crypto.createHash('sha256').update(bytes).digest('hex');
  const db = getDb();
  const find = () => db.prepare('SELECT * FROM practice_work WHERE request_key = ?').get(key) as unknown as PracticeWork & {source_hash: string} | undefined;
  const previous = find();
  if (previous) {
    if (previous.packet_id !== packetId || previous.item_id !== itemId || previous.source_hash !== hash) throw new Error('上传标识已用于另一份作答');
    return previous;
  }
  const startedAt = receivedAt();
  const normalized = await sharp(bytes, {limitInputPixels: 40_000_000}).rotate().resize({width:2048,height:2048,fit:'inside',withoutEnlargement:true}).jpeg({quality:88}).toBuffer();
  assertTaskWritable(packetId);
  // Recheck after decoding: two retries may have reached this await together.
  const raced = find();
  if (raced) {
    if (raced.packet_id !== packetId || raced.item_id !== itemId || raced.source_hash !== hash) throw new Error('上传标识冲突');
    return raced;
  }
  const count = db.prepare('SELECT COUNT(*) AS n FROM practice_work WHERE packet_id = ? AND item_id = ?').get(packetId,itemId) as {n:number};
  if (count.n >= 10) throw new Error('这道题已保存 10 张作答照片，可直接核对');
  const id = newId('wrk');
  db.prepare('INSERT INTO practice_work(id,packet_id,item_id,request_key,source_hash,image,status,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id,packetId,itemId,key,hash,normalized,'pending',startedAt);
  return db.prepare('SELECT id,packet_id,item_id,status,text,uncertain,attempts FROM practice_work WHERE id = ?').get(id) as unknown as PracticeWork;
}
export async function recognizeWork(id: string, recognizer: HandwritingRecognizer): Promise<void> {
  if (active.has(id)) return;
  const row = getDb().prepare('SELECT image,status,attempts,packet_id FROM practice_work WHERE id = ?').get(id) as {image: Uint8Array; status:string; attempts:number;packet_id:string} | undefined;
  if (!row || taskLifecycle(row.packet_id)==='cancelled' || row.status === 'ready' || row.attempts >= 3) return;
  active.add(id);
  getDb().prepare("UPDATE practice_work SET status = 'recognizing', attempts = attempts + 1 WHERE id = ?").run(id);
  try {
    const result = validateHandwriting(await recognizer.recognize(Buffer.from(row.image)));
    if(taskLifecycle(row.packet_id)==='cancelled')return;
    getDb().prepare("UPDATE practice_work SET status = 'ready', text = ?, uncertain = ? WHERE id = ?").run(result.text,result.uncertain?1:0,id);
  } catch {
    getDb().prepare("UPDATE practice_work SET status = 'failed' WHERE id = ?").run(id);
  } finally { active.delete(id); }
}
export function workImage(packetId: string,itemId: string,id:string): Buffer | null {
  const row = getDb().prepare('SELECT image FROM practice_work WHERE id = ? AND packet_id = ? AND item_id = ?').get(id,packetId,itemId) as {image:Uint8Array} | undefined;
  return row ? Buffer.from(row.image) : null;
}
