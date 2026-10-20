import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InvitationRecord, StudentRecord, StudentRegistry } from '../studentHost/registry.js';
import { readAiUsage, type AiUsageRecord } from '../observability/aiUsage.js';
import { readLegacyUsage, regularPath } from './legacyUsage.js';

export const PAGE_SIZE = 50;
export interface AdminFilters { studentId: string; from: string; to: string; model: string; operation: string; page: number }
export class FilterError extends Error {}
export function parseAdminFilters(query: Record<string, unknown>): AdminFilters {
  const text = (key: string): string => {
    const value = query[key];
    if (value === undefined) return '';
    if (typeof value !== 'string' || value.length > 200) throw new FilterError('筛选条件不正确。');
    return value;
  };
  const from = text('from'); const to = text('to'); const studentId = text('studentId');
  for (const date of [from, to]) {
    if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date)) throw new FilterError('请输入有效日期。');
  }
  if (from && to && from > to) throw new FilterError('开始日期不能晚于结束日期。');
  if (studentId && !/^[a-f0-9-]{36}$/i.test(studentId)) throw new FilterError('账号筛选不正确。');
  const page = text('page') || '1';
  if (!/^[1-9]\d{0,5}$/.test(page)) throw new FilterError('页码不正确。');
  return { studentId, from, to, model: text('model'), operation: text('operation'), page: Number(page) };
}

export interface UsageSummary {
  calls: number; succeeded: number; failed: number; successRate: number | null;
  inputTokens: number | null; outputTokens: number | null; totalTokens: number | null;
  knownInputCalls: number; knownOutputCalls: number; timedCalls: number; averageMs: number | null; p95Ms: number | null;
}
export function summarize(records: AiUsageRecord[]): UsageSummary {
  const input = records.filter(row => row.inputTokens !== null);
  const output = records.filter(row => row.outputTokens !== null);
  const duration = records.flatMap(row => row.durationMs === null ? [] : [row.durationMs]).sort((a, b) => a - b);
  const succeeded = records.filter(row => row.status === 'succeeded').length;
  const inputTokens = input.length ? input.reduce((sum, row) => sum + row.inputTokens!, 0) : null;
  const outputTokens = output.length ? output.reduce((sum, row) => sum + row.outputTokens!, 0) : null;
  return { calls: records.length, succeeded, failed: records.length - succeeded, successRate: records.length ? succeeded / records.length : null,
    inputTokens, outputTokens, totalTokens: inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0),
    knownInputCalls: input.length, knownOutputCalls: output.length, timedCalls: duration.length,
    averageMs: duration.length ? duration.reduce((sum, value) => sum + value, 0) / duration.length : null,
    p95Ms: duration.length ? duration[Math.ceil(duration.length * 0.95) - 1]! : null };
}

export interface AccountActivity { photos: number | null; items: number | null; packets: number | null; printed: number | null; reflections: number | null; returns: number | null }
export interface AdminAccount extends StudentRecord {
  label: string; grade: string | null; invitations: InvitationRecord[]; activity: AccountActivity; usage: UsageSummary;
  legacyCalls: number; firstCollectedAt: string | null; warnings: string[];
}
export interface AdminCall extends AiUsageRecord { studentId: string; accountLabel: string }
export interface AdminReport {
  filters: AdminFilters; accounts: AdminAccount[]; accountOptions: Array<{ studentId: string; label: string }>;
  summary: UsageSummary; records: AdminCall[]; pages: number;
  models: string[]; operations: string[]; byModel: Array<{ name: string; usage: UsageSummary }>;
  byOperation: Array<{ name: string; usage: UsageSummary }>; failures: Array<{ code: string; count: number }>;
}

function readActivity(dataDir: string, warnings: string[]): { label: string | null; grade: string | null; lastActiveAt: string | null; activity: AccountActivity } {
  const activity: AccountActivity = { photos: 0, items: 0, packets: 0, printed: 0, reflections: 0, returns: 0 };
  let label: string | null = null; let grade: string | null = null; let lastActiveAt: string | null = null;
  const filename = path.join(dataDir, 'app.db');
  if (!fs.existsSync(filename)) return { label, grade, lastActiveAt, activity };
  let db: DatabaseSync | undefined;
  try {
    if (!regularPath(filename, 'file')) throw new Error();
    db = new DatabaseSync(filename, { readOnly: true });
    const queries: Record<keyof AccountActivity, string> = {
      photos: 'SELECT COUNT(*) AS n FROM v2_photo', items: 'SELECT COUNT(*) AS n FROM error_item',
      packets: 'SELECT COUNT(*) AS n FROM review_packet', printed: "SELECT COUNT(*) AS n FROM v2_print_snapshot WHERE status = 'ready'",
      reflections: 'SELECT COUNT(*) AS n FROM error_diagnosis', returns: 'SELECT COUNT(*) AS n FROM review_attempt',
    };
    for (const [key, query] of Object.entries(queries)) {
      try { activity[key as keyof AccountActivity] = (db.prepare(query).get() as { n: number }).n; }
      catch { activity[key as keyof AccountActivity] = null; }
    }
    try { label = (db.prepare('SELECT nickname FROM student_profile LIMIT 1').get() as { nickname?: string } | undefined)?.nickname?.slice(0, 100) || null; } catch { /* older schema */ }
    try {
      const stored = (db.prepare('SELECT grade FROM student_profile LIMIT 1').get() as { grade?: string } | undefined)?.grade?.trim();
      grade = stored || null;
    } catch { /* older schema has no grade column */ }
    try { lastActiveAt = (db.prepare('SELECT MAX(created_at) AS t FROM audit_event').get() as { t: string | null }).t; } catch { /* older schema */ }
  } catch {
    for (const key of Object.keys(activity)) activity[key as keyof AccountActivity] = null;
  } finally { db?.close(); }
  if (Object.values(activity).some(value => value === null)) warnings.push('部分学习使用统计暂时无法读取。');
  return { label, grade, lastActiveAt, activity };
}

export async function readAdminReport(registry: StudentRegistry, filters: AdminFilters): Promise<AdminReport> {
  const students = registry.listStudents();
  const invitations = registry.listInvitations();
  const all: AdminCall[] = [];
  const accounts: AdminAccount[] = [];
  const from = filters.from ? new Date(`${filters.from}T00:00:00+08:00`).toISOString() : '';
  const to = filters.to ? new Date(Date.parse(`${filters.to}T00:00:00+08:00`) + 86_400_000).toISOString() : '';
  const matches = (row: AiUsageRecord): boolean => (!from || row.startedAt >= from) && (!to || row.startedAt < to)
    && (!filters.model || row.model === filters.model) && (!filters.operation || row.operation === filters.operation);

  for (const student of students) {
    const dataDir = registry.studentDir(student.studentId);
    const warnings: string[] = [];
    let records: AiUsageRecord[] = [];
    let learning: ReturnType<typeof readActivity> = { label: null, grade: null, lastActiveAt: null,
      activity: { photos: null, items: null, packets: null, printed: null, reflections: null, returns: null } };
    if (regularPath(dataDir, 'directory')) {
      learning = readActivity(dataDir, warnings);
      try {
        if (fs.existsSync(path.join(dataDir, 'ai-usage.db')) && !regularPath(path.join(dataDir, 'ai-usage.db'), 'file')) throw new Error();
        records = readAiUsage(dataDir);
      } catch { warnings.push('调用统计库暂时无法读取，当前合计可能不完整。'); }
      try {
        const legacy = await readLegacyUsage(dataDir);
        const ids = new Set(records.map(row => row.id));
        for (const row of legacy.records) if (!ids.has(row.id)) { records.push(row); ids.add(row.id); }
        if (legacy.incomplete) warnings.push('部分历史调用记录无法读取，当前合计可能不完整。');
      } catch { warnings.push('历史调用记录暂时无法读取。'); }
      if (fs.existsSync(path.join(dataDir, 'ai-usage-warning'))) warnings.push('曾发生调用统计写入失败，当前合计可能不完整。');
    } else warnings.push('账号数据目录暂时无法读取。');
    const label = learning.label ?? `账号 ${student.studentId.slice(0, 8)}`;
    const lastActiveAt = [student.lastActiveAt, learning.lastActiveAt, ...records.map(row => row.startedAt)]
      .filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort().at(-1) ?? null;
    const selected = records.filter(matches);
    accounts.push({ ...student, label, grade: learning.grade, lastActiveAt, activity: learning.activity, warnings,
      invitations: invitations.filter(row => row.studentId === student.studentId), usage: summarize(selected),
      legacyCalls: records.filter(row => row.source === 'legacy').length,
      firstCollectedAt: records.filter(row => row.source === 'live').map(row => row.startedAt).sort()[0] ?? null });
    all.push(...records.map(row => ({ ...row, studentId: student.studentId, accountLabel: label })));
  }
  const selected = all.filter(row => (!filters.studentId || row.studentId === filters.studentId) && matches(row))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const group = (key: 'model' | 'operation') => [...new Set(selected.map(row => row[key]))].sort()
    .map(name => ({ name, usage: summarize(selected.filter(row => row[key] === name)) }));
  const failures = new Map<string, number>();
  for (const row of selected) if (row.status === 'failed') failures.set(row.errorCode ?? 'unknown', (failures.get(row.errorCode ?? 'unknown') ?? 0) + 1);
  return { filters, accounts: accounts.filter(row => !filters.studentId || row.studentId === filters.studentId),
    accountOptions: accounts.map(({ studentId, label }) => ({ studentId, label })), summary: summarize(selected),
    pages: Math.max(1, Math.ceil(selected.length / PAGE_SIZE)), records: selected.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE),
    models: [...new Set(all.map(row => row.model))].sort(), operations: [...new Set(all.map(row => row.operation))].sort(),
    byModel: group('model'), byOperation: group('operation'), failures: [...failures].map(([code, count]) => ({ code, count })) };
}
