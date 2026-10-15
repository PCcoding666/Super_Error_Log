import fs from 'node:fs';
import { eventsLogPath } from '../config.js';
import { getDb, newId, now } from '../db/connection.js';

/** 最小事件：名称 + 实体 ID + 时间。禁止写入反思文本、图片内容、secret。 */
export function audit(name: string, entityType?: string, entityId?: string): void {
  const ts = now();
  getDb()
    .prepare('INSERT INTO audit_event (id, name, entity_type, entity_id, created_at) VALUES (?,?,?,?,?)')
    .run(newId('evt'), name, entityType ?? null, entityId ?? null, ts);
  try {
    fs.appendFileSync(eventsLogPath(), `${ts} ${name} ${entityType ?? ''} ${entityId ?? ''}\n`);
  } catch {
    // 日志文件不可写不阻断业务
  }
}

export function recordAiRun(input: {
  provider: string;
  operation: string;
  assetId?: string;
  itemId?: string;
  status: 'ok' | 'timeout' | 'invalid_json' | 'error';
  latencyMs: number;
  error?: string;
}): void {
  getDb()
    .prepare(
      'INSERT INTO ai_run (id, provider, operation, asset_id, item_id, status, latency_ms, error, created_at) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      newId('ai'),
      input.provider,
      input.operation,
      input.assetId ?? null,
      input.itemId ?? null,
      input.status,
      Math.round(input.latencyMs),
      input.error ?? null,
      now(),
    );
}
