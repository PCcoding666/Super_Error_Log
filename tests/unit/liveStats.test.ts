import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LIVE_STATUS_FILE, LiveStats } from '../../src/studentHost/liveStats.js';
import type { CapacitySnapshot } from '../../src/studentHost/workers.js';

describe('LiveStats', () => {
  it('counts students active in the last 5 minutes, keeps 5-minute and daily peaks, and counts capacity rejections', () => {
    let clock = Date.parse('2026-10-24T02:00:00.000Z');
    const snap: CapacitySnapshot = { live: 0, maxLive: 3, aiLimit: 1, aiInUse: 0, aiWaiting: 0, aiAverageMs: null };
    let waiting = 0;
    const live = new LiveStats({ snapshot: () => ({ ...snap }), waitingOutside: () => waiting, now: () => clock });

    live.seen('stu-a'); live.seen('stu-b'); live.seen('stu-a');
    Object.assign(snap, { live: 3, aiInUse: 1, aiWaiting: 6, aiAverageMs: 18_000 });
    live.sample();
    live.rejected('stu-c'); live.rejected('stu-c'); live.rejected('stu-d');
    waiting = 2;
    let status = live.status();
    expect(status).toMatchObject({ activeStudents: 2, live: 3, maxLive: 3, aiInUse: 1, aiWaiting: 6, waitingOutside: 2 });
    expect(status.last5m).toEqual({ peakLive: 3, peakActive: 2, peakAiInUse: 1, peakAiWaiting: 6, capacityRejections: 3, rejectedStudents: 2 });

    // 6 分钟后：最近 5 分钟清空，今天的峰值还在；没再来的人不算在用。
    clock += 6 * 60_000;
    Object.assign(snap, { live: 1, aiInUse: 0, aiWaiting: 0 });
    waiting = 0;
    status = live.status();
    expect(status.activeStudents).toBe(0);
    expect(status.last5m).toEqual({ peakLive: 1, peakActive: 0, peakAiInUse: 0, peakAiWaiting: 0, capacityRejections: 0, rejectedStudents: 0 });
    expect(status.today).toMatchObject({ day: '2026-10-24', peakLive: 3, peakActive: 2, peakAiWaiting: 6, capacityRejections: 3, rejectedStudents: 2 });

    // 北京时间过了零点：今天重新算。
    clock = Date.parse('2026-10-24T16:00:30.000Z');
    status = live.status();
    expect(status.today).toMatchObject({ day: '2026-10-25', peakLive: 1, capacityRejections: 0 });
  });

  it('writes live-status.json for the health check, readable only by the app user, with no student ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-live-'));
    try {
      const live = new LiveStats({ snapshot: () => ({ live: 1, maxLive: 3, aiLimit: 1, aiInUse: 0, aiWaiting: 0, aiAverageMs: null }) });
      live.seen('0000aaaa-synthetic-student');
      live.start(dir);
      live.stop();
      const file = path.join(dir, LIVE_STATUS_FILE);
      const text = fs.readFileSync(file, 'utf8');
      expect(JSON.parse(text)).toMatchObject({ activeStudents: 1, live: 1, maxLive: 3 });
      expect(text).not.toContain('0000aaaa');
      if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o077).toBe(0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
