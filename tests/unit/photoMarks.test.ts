import type { Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { readPhotoMarks, writePhotoMarks, type PhotoMarks } from '../../src/web/session.js';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('上传历史的本机标记容量', () => {
  for (const kind of ['pickDone', 'dismissed'] as const) {
    it(`已有 80 条历史标记时，新的 ${kind} 操作仍保存，且 cookie 大小有界`, () => {
      const oldIds = Array.from({ length: 80 }, (_, n) => uuid(n));
      const cookie = oldIds.map((id, n) => `${n % 2 ? 'd' : 'p'}-${id}`).join('.');
      const request = { headers: { host: 'localhost', cookie: `sel_photos=${encodeURIComponent(cookie)}` } } as Request;
      const marks = readPhotoMarks(request);
      const newest = uuid(80);
      marks[kind].add(newest);
      let header = '';
      const response = { append: (_name: string, value: string) => { header = value; } } as unknown as Response;

      writePhotoMarks(request, response, marks, [...oldIds, newest], { kind, id: newest });

      const savedRequest = { headers: { cookie: header.split(';')[0] } } as Request;
      const saved = readPhotoMarks(savedRequest);
      expect(saved[kind].has(newest)).toBe(true);
      expect(saved.pickDone.size + saved.dismissed.size).toBe(80);
      expect(Buffer.byteLength(header)).toBeLessThan(4096);
      // 再操作一张旧照片时，该次操作也必须被优先保留。
      const oldest = oldIds.at(-1)!;
      saved[kind].add(oldest);
      writePhotoMarks(savedRequest, response, saved, [...oldIds, newest], { kind, id: oldest });
      expect(readPhotoMarks({ headers: { cookie: header.split(';')[0] } } as Request)[kind].has(oldest)).toBe(true);
    });
  }

  it('不保留已不存在的任务，也不从旧 cookie 恢复已经清除的标记', () => {
    const keep = uuid(1);
    const removed = uuid(2);
    const request = { headers: { host: 'localhost', cookie: `sel_photos=p-${removed}.d-${keep}` } } as Request;
    const marks: PhotoMarks = { pickDone: new Set([keep, removed]), dismissed: new Set() };
    let header = '';
    const response = { append: (_name: string, value: string) => { header = value; } } as unknown as Response;
    writePhotoMarks(request, response, marks, [keep], { kind: 'pickDone', id: keep });
    const saved = readPhotoMarks({ headers: { cookie: header.split(';')[0] } } as Request);
    expect([...saved.pickDone]).toEqual([keep]);
    expect(saved.dismissed.size).toBe(0);
  });
});
