/** P0-7 界面部分：「人有点多」页只说网关真有的数据，并且自己定时重试。 */
import { describe, expect, it, vi } from 'vitest';
import { CAPACITY_RETRY_SECONDS, CapacityWaitlist, capacityLines } from '../../src/studentHost/busy.js';
import { capacityPageHtml } from '../../src/studentHost/busyView.js';
import { PermitPool } from '../../src/studentHost/permits.js';
import type { CapacitySnapshot } from '../../src/studentHost/workers.js';

const full: CapacitySnapshot = { live: 3, maxLive: 3, aiLimit: 1, aiInUse: 1, aiWaiting: 2, aiAverageMs: 60_000 };

describe('capacity waiting page', () => {
  it('counts other students still retrying and forgets those who got in or stopped retrying', () => {
    let now = 0;
    const list = new CapacityWaitlist(() => now, 90_000);
    expect(list.rejected('a')).toBe(0);
    expect(list.rejected('b')).toBe(1);
    expect(list.rejected('a')).toBe(1);
    list.admitted('b');
    expect(list.rejected('c')).toBe(1);
    now = 200_000; // a and c stopped retrying long ago
    expect(list.rejected('d')).toBe(0);
  });

  it('tells the truth instead of promising one or two minutes', () => {
    const text = capacityLines({ snapshot: full, othersWaiting: 4 }).join('\n');
    expect(text).toContain('最多同时开 3 个同学的错题本，3 个都在用');
    expect(text).toContain('还有 4 位同学也在等');
    expect(text).toContain('AI 现在正在做 1 件、排着 2 件，最近每件大约 60 秒');
    expect(text).toContain('不决定你什么时候能进');
    expect(text).toContain('要等多久说不准');
    // No invented minute bound: a slot can free whenever any open notebook goes idle.
    expect(text).not.toMatch(/至少|还要约 \d+ 分钟/);
    expect(text).not.toContain('一两分钟再试');
    const unknown = capacityLines({ snapshot: { ...full, aiInUse: 0, aiWaiting: 0, aiAverageMs: null }, othersWaiting: 0 }).join('\n');
    expect(unknown).toContain('说不准');
    expect(unknown).not.toContain('AI 现在');
    expect(unknown).not.toContain('位同学也在等');
  });

  it('renders a page that retries by itself without scripts and keeps the requested address', () => {
    const html = capacityPageHtml({ snapshot: full, othersWaiting: 0 }, '/s/items?subject=x');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain(`<meta http-equiv="refresh" content="${CAPACITY_RETRY_SECONDS}"/>`);
    expect(html).toContain('href="/s/items?subject=x"');
    expect(html).toContain('人有点多');
    expect(html).toContain('不会丢');
  });
});

describe('permit hold time', () => {
  it('averages how long granted permits are held, ignoring dropped owners', () => {
    vi.useFakeTimers();
    try {
      const pool = new PermitPool(1);
      expect(pool.averageHoldMs).toBeNull();
      pool.acquire('a', '1', () => undefined);
      pool.acquire('b', '1', () => undefined);
      expect(pool.inUse).toBe(1); expect(pool.waiting).toBe(1);
      vi.advanceTimersByTime(10_000);
      pool.release('a', '1');
      expect(pool.averageHoldMs).toBe(10_000);
      vi.advanceTimersByTime(20_000);
      pool.release('b', '1');
      expect(pool.averageHoldMs).toBe(13_000);
      pool.acquire('c', '1', () => undefined);
      pool.dropOwner('c');
      expect(pool.averageHoldMs).toBe(13_000);
    } finally { vi.useRealTimers(); }
  });
});
