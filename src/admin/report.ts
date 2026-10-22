import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InvitationRecord, StudentRecord, StudentRegistry } from '../studentHost/registry.js';
import {
  aggregateUsage, groupedUsage, listUsage, openUsageReader, usageFailures, usageHasId, usageNames, usageTimeBounds,
  USAGE_DETAIL_CAP, type AiUsageRecord, type UsageAggregate,
} from '../observability/aiUsage.js';
export { USAGE_DETAIL_CAP };
import { readLegacyUsage, regularPath } from './legacyUsage.js';
import { fallbackLimits, readFallbackToday, type FallbackLimits, type FallbackToday } from '../ai/fallbackBudget.js';

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
  summary: UsageSummary; records: AdminCall[]; pages: number; detailLimited: boolean;
  models: string[]; operations: string[]; byModel: Array<{ name: string; usage: UsageSummary }>;
  byOperation: Array<{ name: string; usage: UsageSummary }>; failures: Array<{ code: string; count: number }>;
  /** 按调用路线（Token Plan / 按量付费 …）分的次数、失败率、耗时。 */
  byProvider: Array<{ name: string; usage: UsageSummary }>;
  /** 今天（Asia/Shanghai）按量付费备用通道已用次数与上限。账本读不到时 today 为 null。 */
  fallback: { today: FallbackToday | null; limits: FallbackLimits | null; unreadable: boolean };
}

function readFallback(hostDir: string): AdminReport['fallback'] {
  let limits: FallbackLimits | null = null;
  try { limits = fallbackLimits(); } catch { /* 配置错误，页面上显示“未配置正确” */ }
  try { return { today: readFallbackToday(hostDir), limits, unreadable: false }; }
  catch { return { today: null, limits, unreadable: true }; }
}

function readActivity(dataDir: string, warnings: string[]): { label: string | null; grade: string | null; lastActiveAt: string | null; activity: AccountActivity } {
  const activity: AccountActivity = { photos: 0, items: 0, packets: 0, printed: 0, reflections: 0, returns: 0 };
  let label: string | null = null; let grade: string | null = null; let lastActiveAt: string | null = null;
  const filename = path.join(dataDir, 'app.db');
  if (!fs.existsSync(filename)) return { label, grade, lastActiveAt, activity };
  let db: DatabaseSync | undefined;
  try {
    if (!regularPath(filename, 'file')) throw new Error();
    db = new DatabaseSync(filename, { readOnly: true, timeout: 5000 });
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

interface Measurable { usage: UsageSummary; durations: number[] | null }

function fromAggregate(agg: UsageAggregate): Measurable {
  const inputTokens = agg.knownInputCalls ? (agg.inputTokens ?? 0) : null;
  const outputTokens = agg.knownOutputCalls ? (agg.outputTokens ?? 0) : null;
  const averageMs = agg.timedCalls === 0 ? null
    : agg.durations ? agg.durations.reduce((sum, value) => sum + value, 0) / agg.durations.length
    : agg.durationSum / agg.timedCalls;
  const p95Ms = agg.timedCalls === 0 ? null
    : agg.durations ? agg.durations[Math.ceil(agg.durations.length * 0.95) - 1]! : agg.p95Ms;
  return { durations: agg.durations, usage: {
    calls: agg.calls, succeeded: agg.succeeded, failed: agg.calls - agg.succeeded,
    successRate: agg.calls ? agg.succeeded / agg.calls : null, inputTokens, outputTokens,
    totalTokens: inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0),
    knownInputCalls: agg.knownInputCalls, knownOutputCalls: agg.knownOutputCalls, timedCalls: agg.timedCalls, averageMs, p95Ms,
  } };
}

function fromRecords(records: AiUsageRecord[]): Measurable {
  return { usage: summarize(records), durations: records.flatMap(row => row.durationMs === null ? [] : [row.durationMs]).sort((a, b) => a - b) };
}

/** 各账号的合计相加。耗时样本没读全、又要和别的账号合在一起时，不假装 P95 仍然精确。 */
function mergeMeasurable(parts: Measurable[]): { usage: UsageSummary; incomplete: boolean } {
  const calls = parts.reduce((sum, part) => sum + part.usage.calls, 0);
  const succeeded = parts.reduce((sum, part) => sum + part.usage.succeeded, 0);
  const knownInputCalls = parts.reduce((sum, part) => sum + part.usage.knownInputCalls, 0);
  const knownOutputCalls = parts.reduce((sum, part) => sum + part.usage.knownOutputCalls, 0);
  const inputTokens = knownInputCalls ? parts.reduce((sum, part) => sum + (part.usage.inputTokens ?? 0), 0) : null;
  const outputTokens = knownOutputCalls ? parts.reduce((sum, part) => sum + (part.usage.outputTokens ?? 0), 0) : null;
  const timed = parts.filter(part => part.usage.timedCalls > 0);
  const timedCalls = timed.reduce((sum, part) => sum + part.usage.timedCalls, 0);
  const missing = timed.filter(part => part.durations === null);
  let averageMs: number | null = null;
  let p95Ms: number | null = null;
  if (timedCalls > 0 && missing.length === 0) {
    const durations = timed.flatMap(part => part.durations!).sort((a, b) => a - b);
    averageMs = durations.reduce((sum, value) => sum + value, 0) / durations.length;
    p95Ms = durations[Math.ceil(durations.length * 0.95) - 1]!;
  } else if (timed.length === 1) {
    averageMs = timed[0]!.usage.averageMs;
    p95Ms = timed[0]!.usage.p95Ms;
  } else if (timedCalls > 0) {
    averageMs = timed.reduce((sum, part) => sum + (part.usage.averageMs ?? 0) * part.usage.timedCalls, 0) / timedCalls;
  }
  return { incomplete: missing.length > 0 && timed.length > 1, usage: {
    calls, succeeded, failed: calls - succeeded, successRate: calls ? succeeded / calls : null, inputTokens, outputTokens,
    totalTokens: inputTokens === null && outputTokens === null ? null : (inputTokens ?? 0) + (outputTokens ?? 0),
    knownInputCalls, knownOutputCalls, timedCalls, averageMs, p95Ms,
  } };
}

/**
 * 后台账号名（P1-5）：自助注册的账号显示登记姓名 + 手机尾号（只给管理员看）；
 * 管理员 CLI 建的号没有登记资料，退回学生库里的昵称（缺省昵称「学生」时带上账号前 8 位以便区分）。
 */
export function accountLabel(student: Pick<StudentRecord, 'studentId' | 'registeredName' | 'phoneLast4' | 'disabledAt'>, nickname: string | null): string {
  const suffix = student.disabledAt ? '（已停用）' : '';
  if (student.registeredName) return `${student.registeredName.slice(0, 60)}${student.phoneLast4 ? ` · 尾号 ${student.phoneLast4}` : ''}${suffix}`;
  if (nickname && nickname !== '学生') return nickname + suffix;
  return `${nickname ?? '账号'} ${student.studentId.slice(0, 8)}${suffix}`;
}

const EMPTY_ACTIVITY: AccountActivity = { photos: null, items: null, packets: null, printed: null, reflections: null, returns: null };

export async function readAdminReport(registry: StudentRegistry, filters: AdminFilters): Promise<AdminReport> {
  const students = registry.listStudents();
  const invitations = registry.listInvitations();
  const accounts: AdminAccount[] = [];
  const query = {
    from: filters.from ? new Date(`${filters.from}T00:00:00+08:00`).toISOString() : '',
    to: filters.to ? new Date(Date.parse(`${filters.to}T00:00:00+08:00`) + 86_400_000).toISOString() : '',
    model: filters.model, operation: filters.operation,
  };
  const matchesLegacy = (row: AiUsageRecord): boolean => (!query.from || row.startedAt >= query.from) && (!query.to || row.startedAt < query.to)
    && (!query.model || row.model === query.model) && (!query.operation || row.operation === query.operation);
  const models = new Set<string>();
  const operations = new Set<string>();
  const included: Measurable[] = [];
  const modelParts = new Map<string, Measurable[]>();
  const operationParts = new Map<string, Measurable[]>();
  const providerParts = new Map<string, Measurable[]>();
  const failureCounts = new Map<string, number>();
  const details: AdminCall[] = [];
  let selectedCalls = 0;

  const pushGroup = (bucket: Map<string, Measurable[]>, name: string, part: Measurable): void => {
    const list = bucket.get(name) ?? [];
    list.push(part);
    bucket.set(name, list);
  };

  for (const student of students) {
    const dataDir = registry.studentDir(student.studentId);
    const warnings: string[] = [];
    let learning: ReturnType<typeof readActivity> = { label: null, grade: null, lastActiveAt: null, activity: { ...EMPTY_ACTIVITY } };
    let legacyRows: AiUsageRecord[] = [];
    let bounds = { firstAt: null as string | null, lastAt: null as string | null };
    let live: Measurable = fromAggregate({ calls: 0, succeeded: 0, inputTokens: null, outputTokens: null, knownInputCalls: 0, knownOutputCalls: 0, timedCalls: 0, durationSum: 0, durations: [], p95Ms: null });
    let liveModels: string[] = [];
    let liveOperations: string[] = [];
    let liveGroups: { model: Array<{ name: string } & UsageAggregate>; operation: Array<{ name: string } & UsageAggregate>; provider: Array<{ name: string } & UsageAggregate> } = { model: [], operation: [], provider: [] };
    let liveFailures: Array<{ code: string; count: number }> = [];
    let liveDetails: AiUsageRecord[] = [];
    if (regularPath(dataDir, 'directory')) {
      learning = readActivity(dataDir, warnings);
      let db: DatabaseSync | undefined;
      try {
        const filename = path.join(dataDir, 'ai-usage.db');
        if (fs.existsSync(filename)) {
          if (!regularPath(filename, 'file')) throw new Error('linked usage db');
          db = openUsageReader(filename);
          bounds = usageTimeBounds(db);
          const names = usageNames(db);
          liveModels = names.models;
          liveOperations = names.operations;
          live = fromAggregate(aggregateUsage(db, query));
          liveGroups = { model: groupedUsage(db, query, 'model'), operation: groupedUsage(db, query, 'operation'), provider: groupedUsage(db, query, 'provider') };
          liveFailures = usageFailures(db, query);
          liveDetails = listUsage(db, query, USAGE_DETAIL_CAP);
        }
      } catch { warnings.push('调用统计库暂时无法读取，当前合计可能不完整。'); }
      try {
        const legacy = await readLegacyUsage(dataDir);
        for (const row of legacy.records) if (!db || !usageHasId(db, row.id)) legacyRows.push(row);
        if (legacy.incomplete) warnings.push('部分历史调用记录无法读取，当前合计可能不完整。');
      } catch { warnings.push('历史调用记录暂时无法读取。'); }
      finally { db?.close(); }
      if (fs.existsSync(path.join(dataDir, 'ai-usage-warning'))) warnings.push('曾发生调用统计写入失败，当前合计可能不完整。');
    } else warnings.push('账号数据目录暂时无法读取。');

    const filteredLegacy = legacyRows.filter(matchesLegacy);
    const legacyPart = fromRecords(filteredLegacy);
    const merged = mergeMeasurable([live, legacyPart]);
    if (merged.incomplete) warnings.push('调用太多，这次没能把全部耗时放在一起算 P95。');
    for (const name of liveModels) models.add(name);
    for (const name of liveOperations) operations.add(name);
    for (const row of legacyRows) { models.add(row.model); operations.add(row.operation); }
    const label = accountLabel(student, learning.label);
    const lastActiveAt = [student.lastActiveAt, learning.lastActiveAt, bounds.lastAt, ...legacyRows.map(row => row.startedAt)]
      .filter((value): value is string => !!value && Number.isFinite(Date.parse(value))).sort().at(-1) ?? null;
    accounts.push({ ...student, label, grade: learning.grade, lastActiveAt, activity: learning.activity, warnings,
      invitations: invitations.filter(row => row.studentId === student.studentId), usage: merged.usage,
      legacyCalls: legacyRows.length, firstCollectedAt: bounds.firstAt });
    if (filters.studentId && filters.studentId !== student.studentId) continue;
    included.push(live, legacyPart);
    for (const group of liveGroups.model) pushGroup(modelParts, group.name, fromAggregate(group));
    for (const group of liveGroups.operation) pushGroup(operationParts, group.name, fromAggregate(group));
    for (const group of liveGroups.provider) pushGroup(providerParts, group.name, fromAggregate(group));
    for (const row of filteredLegacy) {
      const part = fromRecords([row]);
      pushGroup(modelParts, row.model, part);
      pushGroup(operationParts, row.operation, part);
      pushGroup(providerParts, row.provider, part);
      if (row.status === 'failed') failureCounts.set(row.errorCode ?? 'unknown', (failureCounts.get(row.errorCode ?? 'unknown') ?? 0) + 1);
    }
    for (const row of liveFailures) failureCounts.set(row.code, (failureCounts.get(row.code) ?? 0) + row.count);
    details.push(...liveDetails.map(row => ({ ...row, studentId: student.studentId, accountLabel: label })));
    details.push(...filteredLegacy.map(row => ({ ...row, studentId: student.studentId, accountLabel: label })));
    selectedCalls += live.usage.calls + filteredLegacy.length;
  }

  details.sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
  const window = details.slice(0, USAGE_DETAIL_CAP);
  const finishGroup = (bucket: Map<string, Measurable[]>) => [...bucket.keys()].sort()
    .map(name => ({ name, usage: mergeMeasurable(bucket.get(name)!).usage }));
  const summary = mergeMeasurable(included).usage;
  return { filters, accounts: accounts.filter(row => !filters.studentId || row.studentId === filters.studentId),
    accountOptions: accounts.map(({ studentId, label }) => ({ studentId, label })), summary,
    pages: Math.max(1, Math.ceil(Math.min(selectedCalls, USAGE_DETAIL_CAP) / PAGE_SIZE)),
    records: window.slice((filters.page - 1) * PAGE_SIZE, filters.page * PAGE_SIZE),
    detailLimited: selectedCalls > USAGE_DETAIL_CAP,
    models: [...models].sort(), operations: [...operations].sort(),
    byModel: finishGroup(modelParts), byOperation: finishGroup(operationParts), byProvider: finishGroup(providerParts),
    fallback: readFallback(registry.hostDir),
    failures: [...failureCounts].map(([code, count]) => ({ code, count })) };
}
