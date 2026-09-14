/**
 * F2 回归：彻底清空必须连 uploads/、packets/（已生成 PDF）和 events.log 一起删，
 * 否则磁盘残留学生照片与复习包。
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config, eventsLogPath, packetsDir, uploadsDir } from '../../src/config.js';
import { getDb } from '../../src/db/connection.js';
import { resetAllData } from '../../src/routes/parent.js';
import { createProfile, getProfile } from '../../src/services/studentService.js';

describe('resetAllData 彻底清空', () => {
  it('数据库 + uploads + packets + events.log 全部清除', () => {
    getDb();
    createProfile({ nickname: '清除测试', subjects: ['数学'], weekendPref: '周六上午' });
    fs.writeFileSync(path.join(uploadsDir(), 'a.png'), 'x');
    fs.writeFileSync(path.join(packetsDir(), 'packet_x.pdf'), 'x');
    fs.writeFileSync(eventsLogPath(), 'x');
    const evidenceDir = path.join(config.dataDir, 'evidence');
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, 'private-crop.jpg'), 'synthetic');

    resetAllData();

    expect(getProfile()).toBeNull();
    expect(fs.readdirSync(uploadsDir())).toHaveLength(0);
    expect(fs.readdirSync(packetsDir())).toHaveLength(0);
    expect(fs.existsSync(eventsLogPath())).toBe(false);
    expect(fs.existsSync(evidenceDir)).toBe(false);
  });
});
