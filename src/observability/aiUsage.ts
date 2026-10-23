import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * provider 取值：bailian-token-plan（Token Plan 主用）、bailian（百炼按量付费；配了 Token Plan 时就是失败后的备用）、
 * openai-compatible（本机/其他兼容接口）。后台按它分路统计。
 */
export const PROVIDER_LABELS: Record<string, string> = {
  'bailian-token-plan': 'Token Plan（主用）',
  bailian: '百炼按量付费（配了 Token Plan 时为备用）',
  'openai-compatible': 'OpenAI 兼容接口',
  legacy: '历史识别日志（未记录线路）',
};
export const providerLabel = (name: string): string => PROVIDER_LABELS[name] ?? name;

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

const ERRORS = new Set(['timeout', 'cancelled', 'rate_limited', 'provider_error', 'unsupported', 'invalid_json', 'invalid_output', 'interrupted', 'internal',
  'network', 'authentication', 'permission', 'output_truncated']);
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
      PRAGMA journal_mode = WAL;
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
    for (const suffix of ['', '-wal', '-shm']) {
      const sidecar = suffix ? `${filename}${suffix}` : filename;
      if (fs.existsSync(sidecar)) fs.chmodSync(sidecar, 0o600);
    }
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
  const db = openUsageReader(filename);
  try { return listUsage(db, {}, Number.MAX_SAFE_INTEGER); }
  finally { db.close(); }
}

/** 管理后台明细最多带回这么多条；合计仍按全表算。 */
export const USAGE_DETAIL_CAP = 2000;
/** 不超过这个耗时样本数时，把样本读出来，才能和历史日志精确合并 P95。 */
export const USAGE_DURATION_CAP = 20_000;

export interface UsageQuery { from?: string; to?: string; model?: string; operation?: string }

export interface UsageAggregate {
  calls: number;
  succeeded: number;
  inputTokens: number | null;
  outputTokens: number | null;
  knownInputCalls: number;
  knownOutputCalls: number;
  timedCalls: number;
  durationSum: number;
  /** 升序。样本超过 USAGE_DURATION_CAP 时为 null，改用 p95Ms。 */
  durations: number[] | null;
  p95Ms: number | null;
}

/** 只读打开。不存在的库不要调用；打不开由调用方记成统计不完整。 */
export function openUsageReader(filename: string): DatabaseSync {
  return new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
}

export function usageHasId(db: DatabaseSync, id: string): boolean {
  return db.prepare('SELECT 1 AS ok FROM ai_usage WHERE id = ?').get(id) !== undefined;
}

export function usageNames(db: DatabaseSync): { models: string[]; operations: string[] } {
  const models = (db.prepare('SELECT DISTINCT model FROM ai_usage').all() as Array<{ model: string }>).map(row => row.model);
  const operations = (db.prepare('SELECT DISTINCT operation FROM ai_usage').all() as Array<{ operation: string }>).map(row => row.operation);
  return { models, operations };
}

export function usageTimeBounds(db: DatabaseSync): { firstAt: string | null; lastAt: string | null } {
  return db.prepare('SELECT MIN(started_at) AS firstAt, MAX(started_at) AS lastAt FROM ai_usage').get() as { firstAt: string | null; lastAt: string | null };
}

export function usageFailures(db: DatabaseSync, query: UsageQuery): Array<{ code: string; count: number }> {
  const filter = usageWhere(query);
  return db.prepare(`SELECT COALESCE(error_code, 'unknown') AS code, COUNT(*) AS count
    FROM ai_usage WHERE status = 'failed' AND ${filter.sql} GROUP BY code`).all(...filter.params) as Array<{ code: string; count: number }>;
}

export function aggregateUsage(db: DatabaseSync, query: UsageQuery): UsageAggregate {
  const filter = usageWhere(query);
  const row = db.prepare(`SELECT COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
      COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS knownInputCalls,
      COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS knownOutputCalls,
      COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS timedCalls,
      COALESCE(SUM(duration_ms), 0) AS durationSum
    FROM ai_usage WHERE ${filter.sql}`).get(...filter.params) as Omit<UsageAggregate, 'durations' | 'p95Ms'>;
  const durations = row.timedCalls > 0 && row.timedCalls <= USAGE_DURATION_CAP
    ? (db.prepare(`SELECT duration_ms AS duration FROM ai_usage WHERE duration_ms IS NOT NULL AND ${filter.sql} ORDER BY duration_ms`).all(...filter.params) as Array<{ duration: number }>).map(item => item.duration)
    : row.timedCalls === 0 ? [] : null;
  return { ...row, durations, p95Ms: durations ? percentile(durations) : selectDurationP95(db, filter.sql, filter.params) };
}

export function groupedUsage(db: DatabaseSync, query: UsageQuery, column: 'model' | 'operation' | 'provider'): Array<{ name: string } & UsageAggregate> {
  const filter = usageWhere(query);
  const rows = db.prepare(`SELECT ${column} AS name, COUNT(*) AS calls,
      COALESCE(SUM(CASE WHEN status = 'succeeded' THEN 1 ELSE 0 END), 0) AS succeeded,
      SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
      COALESCE(SUM(CASE WHEN input_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS knownInputCalls,
      COALESCE(SUM(CASE WHEN output_tokens IS NOT NULL THEN 1 ELSE 0 END), 0) AS knownOutputCalls,
      COALESCE(SUM(CASE WHEN duration_ms IS NOT NULL THEN 1 ELSE 0 END), 0) AS timedCalls,
      COALESCE(SUM(duration_ms), 0) AS durationSum
    FROM ai_usage WHERE ${filter.sql} GROUP BY ${column}`).all(...filter.params) as Array<{ name: string } & Omit<UsageAggregate, 'durations' | 'p95Ms'>>;
  const timed = rows.reduce((sum, item) => sum + item.timedCalls, 0);
  const samples = new Map<string, number[]>();
  if (timed > 0 && timed <= USAGE_DURATION_CAP) {
    for (const item of db.prepare(`SELECT ${column} AS name, duration_ms AS duration FROM ai_usage
      WHERE duration_ms IS NOT NULL AND ${filter.sql}`).all(...filter.params) as Array<{ name: string; duration: number }>) {
      const list = samples.get(item.name) ?? [];
      list.push(item.duration);
      samples.set(item.name, list);
    }
    for (const list of samples.values()) list.sort((a, b) => a - b);
  }
  const p95 = new Map<string, number>();
  if (timed > USAGE_DURATION_CAP) {
    for (const item of db.prepare(`WITH ranked AS (
        SELECT ${column} AS name, duration_ms AS duration,
          ROW_NUMBER() OVER (PARTITION BY ${column} ORDER BY duration_ms) AS rn,
          COUNT(*) OVER (PARTITION BY ${column}) AS n
        FROM ai_usage WHERE duration_ms IS NOT NULL AND ${filter.sql}
      ) SELECT name, duration FROM ranked WHERE rn = (n * 95 + 99) / 100`).all(...filter.params) as Array<{ name: string; duration: number }>) {
      p95.set(item.name, item.duration);
    }
  }
  return rows.map(item => {
    const durations = item.timedCalls === 0 ? [] : timed <= USAGE_DURATION_CAP ? (samples.get(item.name) ?? []) : null;
    return { ...item, durations, p95Ms: durations ? percentile(durations) : (p95.get(item.name) ?? null) };
  });
}

export function listUsage(db: DatabaseSync, query: UsageQuery, limit: number): AiUsageRecord[] {
  const filter = usageWhere(query);
  return db.prepare(`SELECT id, started_at AS startedAt, operation, model, provider, status,
      input_tokens AS inputTokens, output_tokens AS outputTokens, duration_ms AS durationMs,
      http_status AS httpStatus, error_code AS errorCode, 'live' AS source
    FROM ai_usage WHERE ${filter.sql} ORDER BY started_at DESC, id DESC LIMIT ?`).all(...filter.params, limit) as unknown as AiUsageRecord[];
}

/** 与 summarize() 的 ceil(n * 0.95) 同一位置：第 (n * 95 + 99) / 100 小的耗时。 */
export function selectDurationP95(db: DatabaseSync, whereSql: string, params: string[]): number | null {
  const hit = db.prepare(`WITH ranked AS (
      SELECT duration_ms AS duration, ROW_NUMBER() OVER (ORDER BY duration_ms) AS rn, COUNT(*) OVER () AS n
      FROM ai_usage WHERE duration_ms IS NOT NULL AND ${whereSql}
    ) SELECT duration FROM ranked WHERE rn = (n * 95 + 99) / 100`).get(...params) as { duration: number } | undefined;
  return hit?.duration ?? null;
}

function percentile(durations: number[]): number | null {
  if (durations.length === 0) return null;
  return durations[Math.ceil(durations.length * 0.95) - 1] ?? null;
}

function usageWhere(query: UsageQuery): { sql: string; params: string[] } {
  const clauses = ['1 = 1'];
  const params: string[] = [];
  if (query.from) { clauses.push('started_at >= ?'); params.push(query.from); }
  if (query.to) { clauses.push('started_at < ?'); params.push(query.to); }
  if (query.model) { clauses.push('model = ?'); params.push(query.model); }
  if (query.operation) { clauses.push('operation = ?'); params.push(query.operation); }
  return { sql: clauses.join(' AND '), params };
}
