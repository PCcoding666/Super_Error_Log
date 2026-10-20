import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb } from '../../src/db/connection.js';
import { SCHEMA_SQL } from '../../src/db/schema.js';
import { aggregateUsage, listUsage, openUsageReader, recordAiUsage, selectDurationP95, type AiUsageRecord } from '../../src/observability/aiUsage.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })); });

const event = (fields: Partial<AiUsageRecord> = {}): AiUsageRecord => ({
  id: crypto.randomUUID(), startedAt: '2026-10-20T02:00:00.000Z', operation: 'mobile_inventory', model: 'vision',
  provider: 'bailian', source: 'live', status: 'succeeded', inputTokens: 1, outputTokens: 1, durationMs: 1,
  httpStatus: 200, errorCode: null, ...fields,
});

describe('sqlite capacity fixes', () => {
  it('sets busy_timeout on app.db and creates the two item indexes idempotently', () => {
    const db = getDb();
    expect(db.prepare('PRAGMA busy_timeout').get()).toEqual({ timeout: 5000 });
    const names = (): Array<{ name: string }> => db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index'
      AND name IN ('idx_error_diagnosis_item', 'idx_review_packet_item_item') ORDER BY name`).all() as Array<{ name: string }>;
    expect(names()).toEqual([{ name: 'idx_error_diagnosis_item' }, { name: 'idx_review_packet_item_item' }]);
    db.exec(SCHEMA_SQL);
    expect(names()).toHaveLength(2);

    const memory = new DatabaseSync(':memory:');
    memory.exec('CREATE TABLE error_diagnosis (item_id TEXT); CREATE TABLE review_packet_item (item_id TEXT);');
    const add = `CREATE INDEX IF NOT EXISTS idx_error_diagnosis_item ON error_diagnosis(item_id);
      CREATE INDEX IF NOT EXISTS idx_review_packet_item_item ON review_packet_item(item_id);`;
    memory.exec(add);
    memory.exec(add);
    expect(memory.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index'
      AND name IN ('idx_error_diagnosis_item', 'idx_review_packet_item_item')`).get()).toEqual({ n: 2 });
    memory.close();
  });

  it('writes ai-usage.db in WAL mode and aggregates without loading every row', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-usage-'));
    roots.push(dir);
    for (let i = 0; i < 30; i += 1) recordAiUsage(event({ durationMs: i + 1, startedAt: `2026-10-20T02:00:${String(i).padStart(2, '0')}.000Z` }), dir);
    const filename = path.join(dir, 'ai-usage.db');
    expect(fs.statSync(filename).mode & 0o777).toBe(0o600);
    const db = openUsageReader(filename);
    try {
      expect(db.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
      expect(aggregateUsage(db, {}).calls).toBe(30);
      expect(aggregateUsage(db, {}).p95Ms).toBe(29);
      expect(selectDurationP95(db, '1 = 1', [])).toBe(29);
      expect(listUsage(db, {}, 10)).toHaveLength(10);
    } finally { db.close(); }
  });
});
