/**
 * 按量付费备用通道的每日熔断（Token Plan 是主用，失败才会走这里）。
 *
 * - 只管“Token Plan 失败 → 改走原按量付费接口”这一段；没配 Token Plan 时按量付费就是主用，不受这里限制。
 * - 计数是跨进程的：每个学生 worker 是独立进程，所以账本放在一个共享 SQLite 里
 *   （SEL_AI_FALLBACK_LEDGER_DIR，进程池会把学生网关目录传给 worker；没有时退到 SEL_STUDENT_HOST_DIR、
 *   SEL_STUDENT_DATA_DIR，都没有才只在本进程内存里计数）。
 * - 日期按 Asia/Shanghai 计，零点自动恢复。
 * - 上限：SEL_AI_FALLBACK_DAILY_CALLS（缺省 200 次）、SEL_AI_FALLBACK_DAILY_TOKENS（缺省 2,000,000，按已报告的输入+输出）。
 *   设为 0 表示完全不用备用通道。写错（非整数）直接报配置错误，不会静默放开，也不会降级为 Mock。
 * - 账本读写失败时不放行（宁可这次失败，也不能在不知道花了多少的情况下继续花钱）。
 * - 每次真正走备用、以及每次被熔断，都往 stderr 打一行 JSON（event=sel_ai_fallback / sel_ai_fallback_blocked），
 *   进程池会把 worker 的 stderr 转进 journald，主机巡检据此告警。行里只有阶段、错误类别和计数，没有题目内容或密钥。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const FALLBACK_LEDGER_FILE = 'ai-fallback-ledger.db';
export const DEFAULT_FALLBACK_DAILY_CALLS = 200;
export const DEFAULT_FALLBACK_DAILY_TOKENS = 2_000_000;

export interface FallbackLimits { calls: number; tokens: number }
export interface FallbackToday { day: string; calls: number; tokens: number; blocked: number }
export interface FallbackContext { operation: string; primaryError: string; primaryHttpStatus?: number | null }

export class FallbackConfigError extends Error {}
export class FallbackBlockedError extends Error {
  constructor(readonly reason: 'calls' | 'tokens' | 'disabled' | 'ledger' | 'config', readonly today: FallbackToday | null, readonly limits: FallbackLimits) {
    super('备用 AI 通道已暂停');
    this.name = 'FallbackBlockedError';
  }
}

/** 给学生看的话：说清楚发生了什么、东西没丢、什么时候会好。不出现内部名词。 */
export const FALLBACK_BLOCKED_MESSAGE = 'AI 服务今天有点忙，备用线路今天的额度已经用完，先暂停处理。照片和已完成的内容都保存着，稍后会自动再试，最晚明天恢复。';

function limitFrom(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  if (!/^\d{1,12}$/.test(raw)) throw new FallbackConfigError(`${name} 必须是非负整数`);
  return Number(raw);
}

export function fallbackLimits(): FallbackLimits {
  return { calls: limitFrom('SEL_AI_FALLBACK_DAILY_CALLS', DEFAULT_FALLBACK_DAILY_CALLS), tokens: limitFrom('SEL_AI_FALLBACK_DAILY_TOKENS', DEFAULT_FALLBACK_DAILY_TOKENS) };
}

/** Asia/Shanghai 的日期 YYYY-MM-DD。 */
export function shanghaiDay(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function fallbackLedgerDir(): string | null {
  for (const name of ['SEL_AI_FALLBACK_LEDGER_DIR', 'SEL_STUDENT_HOST_DIR', 'SEL_STUDENT_DATA_DIR']) {
    const value = process.env[name]?.trim();
    if (value) return path.resolve(value);
  }
  return null;
}

const memory = new Map<string, { calls: number; tokens: number; blocked: number }>();
let nowForTests: (() => Date) | null = null;
/** 仅测试用：固定“现在”，并清空内存计数。 */
export function setFallbackClockForTests(now: (() => Date) | null): void { nowForTests = now; memory.clear(); }

const SCHEMA = `PRAGMA busy_timeout = 5000;
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS ai_fallback (
    id TEXT PRIMARY KEY, day TEXT NOT NULL, started_at TEXT NOT NULL, operation TEXT NOT NULL,
    status TEXT NOT NULL, tokens INTEGER
  );
  CREATE INDEX IF NOT EXISTS ai_fallback_day ON ai_fallback(day);`;

function openLedger(dir: string): DatabaseSync {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filename = path.join(dir, FALLBACK_LEDGER_FILE);
  const db = new DatabaseSync(filename, { timeout: 5000 });
  db.exec(SCHEMA);
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.chmodSync(`${filename}${suffix}`, 0o600); } catch { /* sidecar not created yet */ }
  }
  return db;
}

function tally(db: DatabaseSync, day: string): FallbackToday {
  const row = db.prepare(`SELECT COALESCE(SUM(CASE WHEN status <> 'blocked' THEN 1 ELSE 0 END), 0) AS calls,
      COALESCE(SUM(CASE WHEN status <> 'blocked' THEN COALESCE(tokens, 0) ELSE 0 END), 0) AS tokens,
      COALESCE(SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END), 0) AS blocked
    FROM ai_fallback WHERE day = ?`).get(day) as { calls: number; tokens: number; blocked: number };
  return { day, calls: row.calls, tokens: row.tokens, blocked: row.blocked };
}

/** 后台/巡检读今天的计数。只读打开；库不存在返回 null。 */
export function readFallbackToday(dir: string, now = new Date()): FallbackToday | null {
  const filename = path.join(dir, FALLBACK_LEDGER_FILE);
  if (!fs.existsSync(filename)) return null;
  const db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
  try { return tally(db, shanghaiDay(now)); }
  finally { db.close(); }
}

function overLimit(today: Pick<FallbackToday, 'calls' | 'tokens'>, limits: FallbackLimits): FallbackBlockedError['reason'] | null {
  if (limits.calls === 0 || limits.tokens === 0) return 'disabled';
  if (today.calls >= limits.calls) return 'calls';
  if (today.tokens >= limits.tokens) return 'tokens';
  return null;
}

function logEvent(event: 'sel_ai_fallback' | 'sel_ai_fallback_blocked', context: FallbackContext, today: FallbackToday | null, limits: FallbackLimits, reason?: string): void {
  const line = { event, level: event === 'sel_ai_fallback' ? 'warn' : 'error', at: new Date().toISOString(),
    operation: context.operation.slice(0, 60), primaryError: context.primaryError.slice(0, 40), primaryHttpStatus: context.primaryHttpStatus ?? null,
    day: today?.day ?? null, callsToday: today?.calls ?? null, tokensToday: today?.tokens ?? null,
    callLimit: limits.calls, tokenLimit: limits.tokens, ...(reason ? { reason } : {}) };
  try { process.stderr.write(`${JSON.stringify(line)}\n`); } catch { /* stderr closed */ }
}

interface Reservation { id: string; dir: string | null; day: string }

function reserve(context: FallbackContext, limits: FallbackLimits): Reservation {
  const now = nowForTests?.() ?? new Date();
  const day = shanghaiDay(now);
  const id = crypto.randomUUID();
  const dir = fallbackLedgerDir();
  if (!dir) {
    const entry = memory.get(day) ?? { calls: 0, tokens: 0, blocked: 0 };
    memory.set(day, entry);
    const reason = overLimit(entry, limits);
    if (reason) {
      entry.blocked += 1;
      const today = { day, ...entry };
      logEvent('sel_ai_fallback_blocked', context, today, limits, reason);
      throw new FallbackBlockedError(reason, today, limits);
    }
    entry.calls += 1;
    logEvent('sel_ai_fallback', context, { day, ...entry }, limits);
    return { id, dir, day };
  }
  let db: DatabaseSync | undefined;
  let blocked: FallbackBlockedError | null = null;
  let today: FallbackToday | null = null;
  try {
    db = openLedger(dir);
    db.exec('BEGIN IMMEDIATE');
    try {
      const current = tally(db, day);
      const reason = overLimit(current, limits);
      db.prepare('INSERT INTO ai_fallback (id, day, started_at, operation, status, tokens) VALUES (?, ?, ?, ?, ?, NULL)')
        .run(id, day, now.toISOString(), context.operation.slice(0, 60), reason ? 'blocked' : 'reserved');
      db.exec('COMMIT');
      if (reason) { today = { ...current, blocked: current.blocked + 1 }; blocked = new FallbackBlockedError(reason, today, limits); }
      else today = { ...current, calls: current.calls + 1 };
    } catch (error) { try { db.exec('ROLLBACK'); } catch { /* already closed */ } throw error; }
  } catch {
    const error = new FallbackBlockedError('ledger', null, limits);
    logEvent('sel_ai_fallback_blocked', context, null, limits, 'ledger');
    throw error;
  } finally { db?.close(); }
  if (blocked) { logEvent('sel_ai_fallback_blocked', context, today, limits, blocked.reason); throw blocked; }
  logEvent('sel_ai_fallback', context, today, limits);
  return { id, dir, day };
}

function settle(reservation: Reservation, status: 'succeeded' | 'failed', tokens: number | null): void {
  if (!reservation.dir) {
    const entry = memory.get(reservation.day);
    if (entry && tokens) entry.tokens += tokens;
    return;
  }
  let db: DatabaseSync | undefined;
  try {
    db = openLedger(reservation.dir);
    db.prepare('UPDATE ai_fallback SET status = ?, tokens = ? WHERE id = ?').run(status, tokens, reservation.id);
  } catch { /* 预留行已经计了一次调用；token 没记上只会让上限偏松，下一次读取失败会直接拒绝 */ } finally { db?.close(); }
}

/**
 * 在备用通道上做一次调用。超过当日上限时抛出 blocked() 给的错误（由调用方决定错误类型和文案），不发请求。
 * tokensOf 从结果里取已报告的输入+输出 token，用来累计 token 上限。
 */
export async function withFallbackBudget<T>(context: FallbackContext, work: () => Promise<T>, blocked: (error: FallbackBlockedError) => Error,
  tokensOf: (result: T) => number | null = () => null): Promise<T> {
  let limits: FallbackLimits;
  try { limits = fallbackLimits(); }
  catch (error) {
    if (!(error instanceof FallbackConfigError)) throw error;
    logEvent('sel_ai_fallback_blocked', context, null, { calls: 0, tokens: 0 }, 'config');
    throw blocked(new FallbackBlockedError('config', null, { calls: 0, tokens: 0 }));
  }
  let reservation: Reservation;
  try { reservation = reserve(context, limits); }
  catch (error) { if (error instanceof FallbackBlockedError) throw blocked(error); throw error; }
  try {
    const result = await work();
    settle(reservation, 'succeeded', tokensOf(result));
    return result;
  } catch (error) {
    settle(reservation, 'failed', null);
    throw error;
  }
}
