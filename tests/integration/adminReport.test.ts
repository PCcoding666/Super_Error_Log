import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudentRegistry } from '../../src/studentHost/registry.js';
import { recordAiUsage, type AiUsageRecord } from '../../src/observability/aiUsage.js';
import { parseAdminFilters, readAdminReport } from '../../src/admin/report.js';

let root: string;
let registry: StudentRegistry;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-admin-report-')); registry = StudentRegistry.open(root); });
afterEach(() => { registry.close(); fs.rmSync(root, { recursive: true, force: true }); });
const event = (fields: Partial<AiUsageRecord> = {}): AiUsageRecord => ({ id: crypto.randomUUID(), startedAt: '2026-10-20T02:00:00.000Z',
  operation: 'mobile_inventory', model: 'vision', provider: 'bailian', source: 'live', status: 'succeeded', inputTokens: 100, outputTokens: 20,
  durationMs: 1000, httpStatus: 200, errorCode: null, ...fields });
function legacy(dir: string, fields: Record<string, unknown> = {}): void {
  const folder = path.join(dir, 'jobs', crypto.randomUUID(), 'attempts'); fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'attempt.json'), JSON.stringify({ recordedAt: '2026-10-19T08:00:00.000Z', stage: 'inventory',
    request: { model: 'old-model', messages: 'private-prompt' }, responseRaw: 'private-response', httpStatus: 200,
    usage: { prompt_tokens: 10, completion_tokens: 5 }, error: null, ...fields }));
}

describe('admin account and usage report', () => {
  it('aggregates by account, not invitation, preserving unknowns and correct success/P95 denominators', async () => {
    const a = registry.createStudent(); const b = registry.createStudent();
    registry.issueInvitation(a.studentId); const redeemed = registry.issueInvitation(a.studentId); registry.redeem(redeemed.code);
    registry.issueInvitation(b.studentId);
    recordAiUsage(event(), a.studentDir);
    recordAiUsage(event({ status: 'failed', errorCode: 'timeout', inputTokens: null, outputTokens: null, durationMs: 3000, httpStatus: null }), a.studentDir);
    recordAiUsage(event({ inputTokens: 0, outputTokens: 0, durationMs: 500 }), b.studentDir);
    const report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.accounts).toHaveLength(2);
    expect(report.summary).toMatchObject({ calls: 3, succeeded: 2, failed: 1, inputTokens: 100, outputTokens: 20, totalTokens: 120,
      knownInputCalls: 2, knownOutputCalls: 2, timedCalls: 3, averageMs: 1500, p95Ms: 3000 });
    expect(report.summary.successRate).toBeCloseTo(2 / 3);
    const account = report.accounts.find(row => row.studentId === a.studentId)!;
    expect(account.invitations.map(row => row.status).sort()).toEqual(['active', 'pending']);
    expect(account.invitations[0]!.invitationId).toMatch(/^[a-f0-9-]{36}$/);
    expect(account.usage.calls).toBe(2);
    expect(JSON.stringify(report)).not.toMatch(/code_hash|token_hash/);
    expect(JSON.stringify(report)).not.toContain(redeemed.code);
  });
  it('keeps empty and entirely unknown usage distinct from known zero', async () => {
    const a = registry.createStudent();
    let report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.summary).toMatchObject({ calls: 0, successRate: null, inputTokens: null, outputTokens: null, averageMs: null, p95Ms: null });
    expect(report.accounts[0]!.activity.photos).toBe(0);
    expect(fs.existsSync(path.join(a.studentDir, 'app.db'))).toBe(false);
    recordAiUsage(event({ inputTokens: null, outputTokens: null }), a.studentDir);
    report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.summary).toMatchObject({ inputTokens: null, outputTokens: null, totalTokens: null });
  });
  it('filters Singapore calendar dates, account, model and stage before computing metrics and pagination', async () => {
    const a = registry.createStudent(); const b = registry.createStudent();
    for (const startedAt of ['2026-10-19T15:59:59.999Z', '2026-10-19T16:00:00.000Z', '2026-10-20T15:59:59.999Z', '2026-10-20T16:00:00.000Z']) {
      recordAiUsage(event({ startedAt }), a.studentDir);
    }
    recordAiUsage(event({ model: 'other' }), a.studentDir);
    recordAiUsage(event(), b.studentDir);
    const report = await readAdminReport(registry, parseAdminFilters({ from: '2026-10-20', to: '2026-10-20', studentId: a.studentId, model: 'vision', operation: 'mobile_inventory' }));
    expect(report.summary.calls).toBe(2);
    expect(report.records).toHaveLength(2);
    expect(report.records.every(row => row.studentId === a.studentId)).toBe(true);
    expect(report.accounts).toHaveLength(1);
    expect(report.accountOptions).toHaveLength(2);
  });
  it('paginates records without truncating full-filter aggregates', async () => {
    const a = registry.createStudent();
    for (let i = 0; i < 52; i++) recordAiUsage(event({ durationMs: i + 1 }), a.studentDir);
    const first = await readAdminReport(registry, parseAdminFilters({ page: '1' }));
    const second = await readAdminReport(registry, parseAdminFilters({ page: '2' }));
    expect(first.summary.calls).toBe(52); expect(second.summary.calls).toBe(52);
    expect(first.records).toHaveLength(50); expect(second.records).toHaveLength(2);
    expect(second.summary.p95Ms).toBe(50);
    expect(new Set([...first.records, ...second.records].map(row => row.id)).size).toBe(52);
  });
  it('recovers legacy metadata but never duplicates new attempt IDs or exposes prompts', async () => {
    const a = registry.createStudent(); const current = event(); recordAiUsage(current, a.studentDir);
    legacy(a.studentDir);
    legacy(a.studentDir, { usageId: current.id });
    const report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.summary).toMatchObject({ calls: 2, inputTokens: 110, outputTokens: 25, timedCalls: 1, averageMs: 1000 });
    expect(report.records.find(row => row.source === 'legacy')?.durationMs).toBeNull();
    expect(JSON.stringify(report)).not.toMatch(/private-prompt|private-response|messages|responseRaw/);
    expect(report.accounts[0]!.legacyCalls).toBe(1);
  });
  it('preserves controlled historical failure reasons without retaining raw errors', async () => {
    const a = registry.createStudent();
    for (const code of ['network', 'authentication', 'permission', 'output_truncated', 'private-unknown-error']) {
      legacy(a.studentDir, { error: { code, message: 'private-error-body' } });
    }
    const report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.records.map(row => row.errorCode).sort()).toEqual(['authentication', 'network', 'output_truncated', 'permission', 'unknown']);
    expect(JSON.stringify(report)).not.toMatch(/private-error-body|private-unknown-error/);
  });
  it('keeps activity tracking nonblocking and best-effort while the registry has a writer lock', () => {
    const a = registry.createStudent();
    const invitation = registry.issueInvitation(a.studentId);
    const session = registry.redeem(invitation.code);
    const writer = new DatabaseSync(path.join(root, 'registry.db'));
    try {
      for (const lastSeen of [new Date().toISOString(), null]) {
        writer.prepare('UPDATE students SET last_seen_at = ? WHERE id = ?').run(lastSeen, a.studentId);
        writer.exec('BEGIN IMMEDIATE');
        try {
          const started = performance.now();
          expect(registry.authenticate(session.sessionToken)?.studentId).toBe(a.studentId);
          expect(() => registry.recordActivity(a.studentId)).not.toThrow();
          expect(performance.now() - started).toBeLessThan(1000);
        } finally { writer.exec('ROLLBACK'); }
      }
      registry.recordActivity(a.studentId);
      expect(registry.listStudents()[0]!.lastActiveAt).not.toBeNull();
    } finally { writer.close(); }
  }, 15_000);
  it('reports broken stores as unavailable, and refuses linked data files', async () => {
    const a = registry.createStudent(); const b = registry.createStudent();
    fs.writeFileSync(path.join(a.studentDir, 'ai-usage.db'), 'broken');
    fs.writeFileSync(path.join(a.studentDir, 'app.db'), 'broken');
    recordAiUsage(event(), b.studentDir);
    fs.symlinkSync(path.join(b.studentDir, 'ai-usage.db'), path.join(a.studentDir, 'linked.db'));
    const report = await readAdminReport(registry, parseAdminFilters({}));
    const broken = report.accounts.find(row => row.studentId === a.studentId)!;
    expect(broken.warnings.length).toBeGreaterThan(0);
    expect(broken.activity.photos).toBeNull();
    expect(report.summary.calls).toBe(1);
    fs.unlinkSync(path.join(a.studentDir, 'ai-usage.db'));
    fs.symlinkSync(path.join(b.studentDir, 'ai-usage.db'), path.join(a.studentDir, 'ai-usage.db'));
    expect((await readAdminReport(registry, parseAdminFilters({}))).summary.calls).toBe(1);
  });
  it('reads only counts from the learning DB and reports last activity', async () => {
    const a = registry.createStudent(); const db = new DatabaseSync(path.join(a.studentDir, 'app.db'));
    db.exec(`CREATE TABLE student_profile (nickname TEXT); INSERT INTO student_profile VALUES ('小林');
      CREATE TABLE v2_photo (id INTEGER); INSERT INTO v2_photo VALUES (1),(2);
      CREATE TABLE error_item (id INTEGER); INSERT INTO error_item VALUES (1);
      CREATE TABLE review_packet (id INTEGER); INSERT INTO review_packet VALUES (1);
      CREATE TABLE v2_print_snapshot (status TEXT); INSERT INTO v2_print_snapshot VALUES ('ready'),('failed');
      CREATE TABLE error_diagnosis (id INTEGER, student_words TEXT); INSERT INTO error_diagnosis VALUES (1,'private-student-words');
      CREATE TABLE review_attempt (id INTEGER); INSERT INTO review_attempt VALUES (1);
      CREATE TABLE audit_event (created_at TEXT); INSERT INTO audit_event VALUES ('2026-10-20T05:00:00.000Z');`);
    db.close();
    const report = await readAdminReport(registry, parseAdminFilters({}));
    expect(report.accounts[0]).toMatchObject({ label: '小林', lastActiveAt: '2026-10-20T05:00:00.000Z',
      activity: { photos: 2, items: 1, packets: 1, printed: 1, reflections: 1, returns: 1 } });
    expect(JSON.stringify(report)).not.toContain('private-student-words');
  });
  it('migrates old invitation records without changing redemption or public IDs on reopen', () => {
    registry.close();
    fs.rmSync(path.join(root, 'registry.db'));
    const db = new DatabaseSync(path.join(root, 'registry.db'));
    const studentId = crypto.randomUUID();
    const code = '0123456789AB';
    db.exec(`CREATE TABLE students(id TEXT PRIMARY KEY, created_at TEXT NOT NULL);
      CREATE TABLE invitations(code_hash TEXT PRIMARY KEY, student_id TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL, redeemed_at TEXT);`);
    db.prepare('INSERT INTO students VALUES (?, ?)').run(studentId, '2026-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO invitations VALUES (?, ?, ?, ?, NULL)').run(crypto.createHash('sha256').update(code).digest('hex'), studentId,
      '2026-01-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z');
    db.close();
    registry = StudentRegistry.open(root, { now: () => new Date('2026-10-20T00:00:00.000Z') });
    const id = registry.listInvitations()[0]!.invitationId;
    expect(registry.redeem(code).studentId).toBe(studentId);
    registry.close();
    registry = StudentRegistry.open(root);
    expect(registry.listInvitations()[0]).toMatchObject({ invitationId: id, status: 'redeemed' });
    expect(() => registry.redeem(code)).toThrow();
  });
  it('shows expired invitations and malformed legacy data explicitly without double-counting refreshes', async () => {
    const a = registry.createStudent();
    const folder = path.join(a.studentDir, 'jobs', crypto.randomUUID(), 'attempts'); fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, 'broken.json'), '{');
    legacy(a.studentDir);
    const before = await readAdminReport(registry, parseAdminFilters({}));
    const after = await readAdminReport(registry, parseAdminFilters({}));
    expect(before.summary.calls).toBe(1); expect(after.summary.calls).toBe(1);
    expect(after.accounts[0]!.warnings).toContain('部分历史调用记录无法读取，当前合计可能不完整。');
    registry.close();
    registry = StudentRegistry.open(root, { now: () => new Date('2026-01-01T00:00:00.000Z') });
    registry.issueInvitation(a.studentId);
    registry.close(); registry = StudentRegistry.open(root, { now: () => new Date('2026-03-02T00:00:00.000Z') });
    expect(registry.listInvitations()[0]!.status).toBe('expired');
  });
  it.each([{ from: '2026-02-30' }, { to: 'yesterday' }, { from: '2026-10-21', to: '2026-10-20' },
    { page: '-1' }, { page: '1 OR 1=1' }, { model: ['a', 'b'] }, { studentId: '../../other' }])('rejects malformed filters: %j', query => {
    expect(() => parseAdminFilters(query)).toThrow();
  });
});
