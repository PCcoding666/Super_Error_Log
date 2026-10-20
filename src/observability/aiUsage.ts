import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Metadata only. Never pass prompts, provider bodies, credentials or raw Error messages. */
export interface AiUsageRecord {
  id: string;
  startedAt: string;
  operation: string;
  model: string;
  provider: string;
  status: 'succeeded' | 'failed';
  inputTokens: number | null;
  outputTokens: number | null;
  durationMs: number | null;
  httpStatus: number | null;
  errorCode: string | null;
  source: 'live' | 'legacy';
}

export function tokenCount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

const ERRORS = new Set(['timeout', 'cancelled', 'rate_limited', 'provider_error', 'unsupported', 'invalid_json', 'invalid_output', 'interrupted', 'internal']);
export function safeErrorCode(value: unknown): string {
  return typeof value === 'string' && ERRORS.has(value) ? value : 'unknown';
}

/** Each student process owns its directory. A failed observer never changes the provider result. */
export function recordAiUsage(record: AiUsageRecord, dataDir = process.env.SEL_STUDENT_DATA_DIR): boolean {
  if (!dataDir) return false;
  let db: DatabaseSync | undefined;
  try {
    const filename = path.join(dataDir, 'ai-usage.db');
    db = new DatabaseSync(filename);
    fs.chmodSync(filename, 0o600);
    db.exec(`PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS ai_usage (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, operation TEXT NOT NULL, model TEXT NOT NULL,
        provider TEXT NOT NULL, status TEXT NOT NULL,
        input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER, http_status INTEGER, error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS ai_usage_time ON ai_usage(started_at);
    `);
    db.prepare(`INSERT OR IGNORE INTO ai_usage
      (id, started_at, operation, model, provider, status, input_tokens, output_tokens, duration_ms, http_status, error_code)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      record.id, record.startedAt, record.operation.slice(0, 100), record.model.slice(0, 200), record.provider.slice(0, 100),
      record.status, tokenCount(record.inputTokens), tokenCount(record.outputTokens), tokenCount(record.durationMs),
      record.httpStatus, record.status === 'failed' ? safeErrorCode(record.errorCode) : null,
    );
    return true;
  } catch {
    // The dashboard exposes this persistent coverage warning; no exception text is retained.
    try { fs.writeFileSync(path.join(dataDir, 'ai-usage-warning'), new Date().toISOString(), { mode: 0o600 }); } catch { /* directory itself unavailable */ }
    return false;
  } finally { db?.close(); }
}

/** Read-only: viewing an account must not create a DB or run student recovery logic. */
export function readAiUsage(dataDir: string): AiUsageRecord[] {
  const filename = path.join(dataDir, 'ai-usage.db');
  if (!fs.existsSync(filename)) return [];
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return db.prepare(`SELECT id, started_at AS startedAt, operation, model, provider, status,
      input_tokens AS inputTokens, output_tokens AS outputTokens, duration_ms AS durationMs,
      http_status AS httpStatus, error_code AS errorCode, 'live' AS source
      FROM ai_usage ORDER BY started_at DESC, id DESC`).all() as unknown as AiUsageRecord[];
  } finally { db.close(); }
}
