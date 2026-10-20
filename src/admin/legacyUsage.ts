import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { safeErrorCode, tokenCount, type AiUsageRecord } from '../observability/aiUsage.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const STAGES = new Set(['inventory', 'transcribe', 'verify', 'ground']);
/** Refuse symlinks at each boundary, including historical directories. */
export function regularPath(filename: string, kind: 'file' | 'directory'): boolean {
  const stat = fs.lstatSync(filename, { throwIfNoEntry: false });
  return !!stat && (kind === 'file' ? stat.isFile() : stat.isDirectory());
}

export async function readLegacyUsage(dataDir: string): Promise<{ records: AiUsageRecord[]; incomplete: boolean }> {
  const records: AiUsageRecord[] = [];
  let incomplete = false;
  const jobs = path.join(dataDir, 'jobs');
  if (!fs.existsSync(jobs)) return { records, incomplete };
  if (!regularPath(jobs, 'directory')) return { records, incomplete: true };
  for (const job of await fs.promises.readdir(jobs, { withFileTypes: true })) {
    if (!UUID.test(job.name)) continue;
    if (!job.isDirectory()) { incomplete = true; continue; }
    const attempts = path.join(jobs, job.name, 'attempts');
    if (!fs.existsSync(attempts)) continue;
    if (!regularPath(attempts, 'directory')) { incomplete = true; continue; }
    for (const file of await fs.promises.readdir(attempts, { withFileTypes: true })) {
      if (!file.name.endsWith('.json')) continue;
      try {
        const filename = path.join(attempts, file.name);
        if (!file.isFile() || (await fs.promises.stat(filename)).size > 3_000_000) { incomplete = true; continue; }
        const row = JSON.parse(await fs.promises.readFile(filename, 'utf8')) as Record<string, any>;
        const time = row?.startedAt ?? row?.recordedAt;
        if (!row || !STAGES.has(row.stage) || typeof time !== 'string' || !Number.isFinite(Date.parse(time))
          || !(row.error === null || (row.error && typeof row.error === 'object'))) { incomplete = true; continue; }
        const id = typeof row.usageId === 'string' && UUID.test(row.usageId) ? row.usageId
          : `legacy-${crypto.createHash('sha256').update(`${job.name}/${file.name}`).digest('hex')}`;
        records.push({
          id, startedAt: new Date(time).toISOString(), operation: `mobile_${row.stage}`,
          model: typeof row.request?.model === 'string' ? row.request.model.slice(0, 200) : '未记录模型',
          provider: 'legacy', source: 'legacy', status: row.error ? 'failed' : 'succeeded',
          inputTokens: tokenCount(row.usage?.prompt_tokens), outputTokens: tokenCount(row.usage?.completion_tokens),
          durationMs: tokenCount(row.durationMs), httpStatus: tokenCount(row.httpStatus),
          errorCode: row.error ? safeErrorCode(row.error.code) : null,
        });
      } catch { incomplete = true; }
    }
  }
  return { records, incomplete };
}
