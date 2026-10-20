import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { chromium } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.js';
import { dbPath } from '../../src/config.js';
import { getDb, resetDbForTest } from '../../src/db/connection.js';
import { attemptsForPacket, recordAttempt } from '../../src/services/attemptService.js';

const REAL_PACKET = 'pkt_real_dates';
const MOCK_PACKET = 'pkt_mock_legacy';
const GENERATED_AT = '2026-09-01T23:30:00+08:00';
const realItems = [
  'itm_real_missing',
  'itm_real_bad_calendar',
  'itm_real_future',
  'itm_real_before_print',
  'itm_real_same_day',
  'itm_real_delay',
  'itm_real_route',
  'itm_real_unrecorded',
  'itm_real_browser',
  'itm_runtime_completion',
  'itm_runtime_correct',
  'itm_runtime_stuck_type',
  'itm_runtime_stuck_length',
  'itm_runtime_performed_type',
];

function localDay(date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function tomorrow(): string {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  return localDay(date);
}

function inputTag(html: string, name: string): string {
  const tag = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*>`))?.[0];
  if (!tag) throw new Error(`missing input ${name}`);
  return tag;
}

function insertFixtureData(): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO student_profile (id, nickname, grade, subjects, weekend_pref, created_at)
     VALUES ('stu_dates', '日期测试', '初中', '["数学"]', '周六', '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO source_batch (id, student_id, status, created_at)
     VALUES ('bat_dates', 'stu_dates', 'done', '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO source_asset
     (id, batch_id, filename, mime, size, content_hash, status, storage_path, created_at)
     VALUES ('ast_dates', 'bat_dates', 'synthetic.jpg', 'image/jpeg', 1, 'synthetic', 'done', '/tmp/synthetic.jpg', '2026-08-01T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO review_packet (id, student_id, week, status, generated_at, created_at)
     VALUES (?, 'stu_dates', '2026-W36', 'generated', ?, '2026-09-01T12:00:00.000Z')`,
  ).run(REAL_PACKET, GENERATED_AT);
  db.prepare(
    `INSERT INTO review_packet (id, student_id, week, status, generated_at, created_at)
     VALUES (?, 'stu_dates', '2026-W36', 'generated', ?, '2026-09-01T12:00:00.000Z')`,
  ).run(MOCK_PACKET, new Date().toISOString());

  const insertItem = db.prepare(
    `INSERT INTO error_item
     (id, short_id, student_id, batch_id, asset_id, item_index, subject, knowledge_tags,
      status, confidence, created_at, updated_at)
     VALUES (?, ?, 'stu_dates', 'bat_dates', 'ast_dates', ?, '数学', '[]', 'packet_generated', 1,
             '2026-08-01T00:00:00.000Z', '2026-09-01T12:00:00.000Z')`,
  );
  const insertPacketItem = db.prepare(
    'INSERT INTO review_packet_item (packet_id, item_id, position) VALUES (?, ?, ?)',
  );
  const insertEvidence = db.prepare(
    `INSERT INTO evidence_record (item_id, content_json, provenance_json, updated_at)
     VALUES (?, '{}', '[]', '2026-08-01T00:00:00.000Z')`,
  );
  realItems.forEach((itemId, index) => {
    insertItem.run(itemId, `R-${index + 1}`, index);
    insertPacketItem.run(REAL_PACKET, itemId, index);
    insertEvidence.run(itemId);
  });
  insertItem.run('itm_mock_legacy', 'M-1', 100);
  insertPacketItem.run(MOCK_PACKET, 'itm_mock_legacy', 0);
}

describe.sequential('离线真实作答日期', () => {
  const originalTimezone = process.env.TZ;

  beforeAll(() => {
    process.env.TZ = 'Asia/Singapore';
    resetDbForTest();
    fs.mkdirSync(path.dirname(dbPath()), { recursive: true });
    const legacy = new DatabaseSync(dbPath());
    legacy.exec(`
      CREATE TABLE review_attempt (
        id TEXT PRIMARY KEY,
        packet_id TEXT NOT NULL,
        item_id TEXT NOT NULL,
        completion TEXT NOT NULL,
        correct INTEGER NOT NULL DEFAULT 0,
        stuck_step TEXT,
        submitted_by TEXT NOT NULL DEFAULT 'student',
        created_at TEXT NOT NULL
      );
    `);
    legacy.close();
    insertFixtureData();
  });

  afterAll(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
  });

  it('migrates legacy review_attempt and keeps performed_at separate from created_at', () => {
    const columns = getDb().prepare('PRAGMA table_info(review_attempt)').all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain('performed_at');
  });

  it('requires an explicit YYYY-MM-DD for real evidence items', () => {
    const result = recordAttempt(
      REAL_PACKET,
      'itm_real_missing',
      { completion: 'independent', correct: true },
      'student',
    );
    expect(result).toMatchObject({ ok: false });
    expect(result.error).toContain('实际作答日期');
  });

  it.each([
    ['wrong shape', '2026/09/04'],
    ['impossible calendar day', '2026-02-30'],
  ])('rejects %s', (_description, performedAt) => {
    const result = recordAttempt(
      REAL_PACKET,
      'itm_real_bad_calendar',
      { completion: 'independent', correct: true, performedAt },
      'student',
    );
    expect(result.ok).toBe(false);
    expect(result.error).toContain('日期');
  });

  it('rejects future dates and dates before the first print', () => {
    const future = recordAttempt(
      REAL_PACKET,
      'itm_real_future',
      { completion: 'independent', correct: true, performedAt: tomorrow() },
      'student',
    );
    expect(future.ok).toBe(false);
    expect(future.error).toContain('未来');

    const beforePrint = recordAttempt(
      REAL_PACKET,
      'itm_real_before_print',
      { completion: 'independent', correct: true, performedAt: '2026-08-31' },
      'student',
    );
    expect(beforePrint.ok).toBe(false);
    expect(beforePrint.error).toContain('打印');
  });

  it('uses local calendar days, persists performed_at, and schedules confirmation from the performed day', () => {
    const result = recordAttempt(
      REAL_PACKET,
      'itm_real_delay',
      { completion: 'independent', correct: true, performedAt: '2026-09-04' },
      'student',
    );
    expect(result).toMatchObject({ ok: true, toStatus: 'temporarily_mastered' });

    const attempt = getDb()
      .prepare('SELECT performed_at, created_at FROM review_attempt WHERE packet_id = ? AND item_id = ?')
      .get(REAL_PACKET, 'itm_real_delay') as { performed_at: string; created_at: string };
    expect(attempt.performed_at).toBe('2026-09-04');
    expect(attempt.created_at).not.toBe(attempt.performed_at);
    const item = getDb()
      .prepare('SELECT next_review_at FROM error_item WHERE id = ?')
      .get('itm_real_delay') as { next_review_at: string };
    expect(item.next_review_at).toBe('2026-09-14');
  });

  it('does not turn a same-day paper attempt into delayed mastery when it is uploaded later', () => {
    const result = recordAttempt(
      REAL_PACKET,
      'itm_real_same_day',
      { completion: 'independent', correct: true, performedAt: '2026-09-01' },
      'student',
    );
    expect(result).toMatchObject({ ok: true, toStatus: 'attempted' });
    expect(attemptsForPacket(REAL_PACKET).find((row) => row.item_id === 'itm_real_same_day')?.performed_at)
      .toBe('2026-09-01');
  });

  it('keeps legacy Mock attempts compatible by using the current local day when omitted', () => {
    const result = recordAttempt(
      MOCK_PACKET,
      'itm_mock_legacy',
      { completion: 'independent', correct: true },
      'student',
    );
    expect(result.ok).toBe(true);
    expect(attemptsForPacket(MOCK_PACKET)[0]!.performed_at).toBe(localDay());
  });

  it('rejects invalid runtime service input without writing an attempt or changing item state', () => {
    const invalidCases: Array<{ itemId: string; input: unknown }> = [
      {
        itemId: 'itm_runtime_completion',
        input: { completion: 'not-a-completion', correct: true, performedAt: '2026-09-04' },
      },
      {
        itemId: 'itm_runtime_correct',
        input: { completion: 'independent', correct: 1, performedAt: '2026-09-04' },
      },
      {
        itemId: 'itm_runtime_stuck_type',
        input: { completion: 'independent', correct: true, stuckStep: 123, performedAt: '2026-09-04' },
      },
      {
        itemId: 'itm_runtime_stuck_length',
        input: { completion: 'independent', correct: true, stuckStep: 'x'.repeat(101), performedAt: '2026-09-04' },
      },
      {
        itemId: 'itm_runtime_performed_type',
        input: { completion: 'independent', correct: true, performedAt: 20260904 },
      },
    ];

    for (const { itemId, input } of invalidCases) {
      let result: ReturnType<typeof recordAttempt> | undefined;
      expect(() => {
        result = recordAttempt(REAL_PACKET, itemId, input as never, 'student');
      }).not.toThrow();
      expect(result).toMatchObject({ ok: false });
      expect(getDb().prepare('SELECT 1 FROM review_attempt WHERE item_id = ?').get(itemId)).toBeUndefined();
      expect(getDb().prepare('SELECT status FROM error_item WHERE id = ?').get(itemId))
        .toEqual({ status: 'packet_generated' });
    }
  });

  it('passes each submitted date through HTTP and renders recorded dates disabled without defaulting fresh rows', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const body = new URLSearchParams({
        [`completion_itm_real_route`]: 'independent',
        [`correct_itm_real_route`]: '1',
        [`performed_itm_real_route`]: '2026-09-04',
      });
      const invalidBody = new URLSearchParams({
        [`completion_itm_real_bad_calendar`]: 'independent',
        [`correct_itm_real_bad_calendar`]: '1',
        [`performed_itm_real_bad_calendar`]: '2026-02-30',
      });
      const invalidResponse = await fetch(`${base}/packets/${REAL_PACKET}/return`, {
        method: 'POST',
        body: invalidBody,
        redirect: 'manual',
      });
      expect(invalidResponse.status).toBe(302);
      expect(invalidResponse.headers.get('location')).toContain('err=');
      expect(attemptsForPacket(REAL_PACKET).some((row) => row.item_id === 'itm_real_bad_calendar')).toBe(false);

      const response = await fetch(`${base}/packets/${REAL_PACKET}/return`, {
        method: 'POST',
        body,
        redirect: 'manual',
      });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toContain('ok=');
      expect(attemptsForPacket(REAL_PACKET).find((row) => row.item_id === 'itm_real_route')?.performed_at)
        .toBe('2026-09-04');

      const page = await fetch(`${base}/packets/${REAL_PACKET}/return`);
      const html = await page.text();
      expect(html).toContain('请填写纸上真实作答日期');
      const recordedDate = inputTag(html, 'performed_itm_real_route');
      expect(recordedDate).toContain('type="date"');
      expect(recordedDate).toContain('value="2026-09-04"');
      expect(recordedDate).toContain('disabled=""');
      expect(inputTag(html, 'completion_itm_real_route')).toContain('disabled=""');
      expect(inputTag(html, 'correct_itm_real_route')).toContain('disabled=""');
      expect(inputTag(html, 'stuck_itm_real_route')).toContain('disabled=""');
      const freshDate = inputTag(html, 'performed_itm_real_unrecorded');
      expect(freshDate).toContain('type="date"');
      expect(freshDate).not.toContain('value=');
    } finally {
      server.close();
    }
  });

  it('lets the browser submit one selected item without dates on untouched items', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const browser = await chromium.launch();
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const page = await browser.newPage();
      await page.goto(`${base}/packets/${REAL_PACKET}/return`);
      await page.locator('input[name="completion_itm_real_browser"][value="independent"]').check();
      await page.locator('input[name="correct_itm_real_browser"][value="1"]').check();
      await page.locator('input[name="performed_itm_real_browser"]').fill('2026-09-04');

      const form = page.locator(`form[action="/packets/${REAL_PACKET}/return"]`);
      expect(await form.evaluate((element) => (element as HTMLFormElement).checkValidity())).toBe(true);
      await Promise.all([
        page.waitForURL(/\?ok=/),
        form.locator('button[type="submit"]').click(),
      ]);

      expect(attemptsForPacket(REAL_PACKET).find((row) => row.item_id === 'itm_real_browser')?.performed_at)
        .toBe('2026-09-04');
      expect(attemptsForPacket(REAL_PACKET).some((row) => row.item_id === 'itm_real_unrecorded')).toBe(false);
    } finally {
      await browser.close();
      server.close();
    }
  }, 30_000);
});
