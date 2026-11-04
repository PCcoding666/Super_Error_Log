import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import {
  assetPageQuery, createdAtRangeSql, DayFilterError, intakeListParams, instantInRange, isCalendarDay, parseAssetDayFilter,
  reduceUploadDayFilter, singaporeDayBounds, singaporeToday,
} from '../../src/materials/dayFilter.js';

describe('新加坡自然日', () => {
  it('把 UTC+8 的日界算到前一天 16:00 UTC，不含次日', () => {
    expect(singaporeDayBounds('2026-11-04')).toEqual({ start: '2026-11-03 16:00:00', end: '2026-11-04 16:00:00' });
    expect(singaporeToday(new Date('2026-11-03T15:59:59.000Z'))).toBe('2026-11-03');
    expect(singaporeToday(new Date('2026-11-03T16:00:00.000Z'))).toBe('2026-11-04');
    expect(isCalendarDay('2026-02-31')).toBe(false);
    expect(isCalendarDay('2026-11-04')).toBe(true);
  });

  it('没有参数就是不筛选；date 优先于起止日；起止颠倒或写错则拒绝', () => {
    expect(parseAssetDayFilter({})).toBeNull();
    expect(parseAssetDayFilter({ date: '2026-11-04', from: '2026-01-01', to: '2026-12-31' })).toMatchObject({
      date: '2026-11-04', from: null, to: null, start: '2026-11-03 16:00:00', end: '2026-11-04 16:00:00',
    });
    expect(parseAssetDayFilter({ from: '2026-11-03', to: '2026-11-04' })).toMatchObject({
      date: null, from: '2026-11-03', to: '2026-11-04', start: '2026-11-02 16:00:00', end: '2026-11-04 16:00:00',
    });
    expect(parseAssetDayFilter({ from: '2026-11-04' })?.end).toBeNull();
    expect(assetPageQuery(null)).toBe('');
    expect(assetPageQuery(parseAssetDayFilter({ date: '2026-11-04' }))).toBe('&date=2026-11-04');
    for (const query of [{ date: '2026-02-31' }, { date: '昨天' }, { date: '' }, { date: ['2026-11-04'] }, { from: '2026-11-06', to: '2026-11-05' }]) {
      expect(() => parseAssetDayFilter(query)).toThrow(DayFilterError);
    }
  });

  it('换一天或开关筛选都回到第 0 页；关掉之后请求不带参数', () => {
    let state = reduceUploadDayFilter({ enabled: false, day: '2026-11-04', page: 3 }, { type: 'toggle', enabled: true });
    expect(state).toEqual({ enabled: true, day: '2026-11-04', page: 0 });
    expect(intakeListParams(state)).toEqual({ date: '2026-11-04', page: '0' });
    state = reduceUploadDayFilter(state, { type: 'page', page: 2 });
    expect(intakeListParams(state).page).toBe('2');
    state = reduceUploadDayFilter(state, { type: 'day', day: '2026-11-05' });
    expect(state).toEqual({ enabled: true, day: '2026-11-05', page: 0 });
    expect(reduceUploadDayFilter(state, { type: 'day', day: '2026-02-31' })).toBe(state);
    state = reduceUploadDayFilter(state, { type: 'toggle', enabled: false });
    expect(state.page).toBe(0);
    expect(intakeListParams(state)).toEqual({});
  });

  it('SQL 按新加坡日界收照片，ISO 和空格两种时间戳都认，别的同学的不收', () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE material_asset (id TEXT, owner_id TEXT, created_at TEXT)');
    const insert = db.prepare('INSERT INTO material_asset(id, owner_id, created_at) VALUES (?, ?, ?)');
    for (const [id, owner, at] of [
      ['eve', 'a', '2026-11-03 15:59:59'],
      ['midnight', 'a', '2026-11-03 16:00:00'],
      ['iso', 'a', '2026-11-03T16:00:01.000Z'],
      ['late', 'a', '2026-11-04 15:59:59'],
      ['next', 'a', '2026-11-04 16:00:00'],
      ['other', 'b', '2026-11-03 18:00:00'],
    ] as const) insert.run(id, owner, at);
    const filter = parseAssetDayFilter({ date: '2026-11-04' })!;
    const range = createdAtRangeSql(filter);
    const ids = (db.prepare(`SELECT id FROM material_asset WHERE owner_id=?${range.sql} ORDER BY created_at, rowid`).all('a', ...range.params) as { id: string }[]).map(row => row.id);
    expect(ids).toEqual(['midnight', 'iso', 'late']);
    expect(instantInRange('2026-11-03T16:00:00.000Z', filter)).toBe(true);
    expect(instantInRange('2026-11-03 15:59:59', filter)).toBe(false);
    expect(instantInRange('2026-11-04 16:00:00', filter)).toBe(false);
    const open = createdAtRangeSql(null);
    expect(open.sql).toBe('');
    expect((db.prepare(`SELECT count(*) n FROM material_asset WHERE owner_id=?${open.sql}`).get('a', ...open.params) as { n: number }).n).toBe(5);
  });
});
