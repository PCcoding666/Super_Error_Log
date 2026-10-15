/**
 * Slice B 集成测试：推荐 → 建包 → 打印 HTML → PDF 生成与程序化校验。
 * 覆盖 J4/J5：可解释推荐、5–8 题、A4 版式、答案与题目页分离。
 */
import fs from 'node:fs';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { getDb } from '../../src/db/connection.js';
import { createBatch, processBatch } from '../../src/services/batchService.js';
import { correctItem, listItems, submitReflection } from '../../src/services/itemService.js';
import { computeRecommendations, createPacket, getPacket, packetItems } from '../../src/services/planService.js';
import { buildPacketPrintData, generatePacketPdf } from '../../src/services/pdfService.js';
import { createProfile } from '../../src/services/studentService.js';
import { WEEK1_DIR } from '../../src/fixtures/generate.js';
import type { Subject } from '../../src/domain/types.js';

function loadFixtures(): Array<{ filename: string; mime: string; buffer: Buffer }> {
  return fs.readdirSync(WEEK1_DIR).sort().map((filename) => ({
    filename,
    mime: filename.endsWith('.pdf') ? 'application/pdf' : filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png',
    buffer: fs.readFileSync(path.join(WEEK1_DIR, filename)),
  }));
}

describe('Slice B：选题到打印', () => {
  let studentId = '';
  let packetId = '';

  beforeAll(async () => {
    setAiProviderForTest(new MockAiProvider());
    studentId = createProfile({ nickname: '打印测试', subjects: ['数学', '物理', '化学'], weekendPref: '周六上午' }).id;
    const { batchId } = await createBatch(studentId, loadFixtures());
    await processBatch(batchId);

    // 订正全部低置信题
    for (const item of listItems(studentId).filter((i) => i.status === 'needs_review')) {
      correctItem(item.id, {
        subject: (item.subject ?? '数学') as Subject,
        chapter: '单元',
        knowledgeTags: JSON.parse(item.knowledge_tags) as string[],
        questionType: '计算题',
        isKeyGap: false,
      });
    }
    // 学生本人完成全部反思 → eligible_for_review
    for (const item of listItems(studentId).filter((i) => i.status === 'ready_for_reflection')) {
      const r = submitReflection(item.id, {
        attemptState: '完全不会',
        cause: '知识概念',
        masteryFeeling: 1,
        reviewValue: '必须再做',
      }, 'student');
      expect(r.ok).toBe(true);
    }
  }, 60000);

  it('推荐可解释：每题有分数与理由，按分数降序', () => {
    const recs = computeRecommendations(studentId, new Date('2026-09-05'));
    expect(recs.length).toBe(20);
    for (const r of recs) {
      expect(r.score).toBeGreaterThan(0);
      expect(r.reasons.length).toBeGreaterThan(0);
    }
    const scores = recs.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // 深因（概念不清 +30）+ 必须再做（+15）+ 掌握度≤1（+10）→ 全员 ≥55
    expect(Math.min(...scores)).toBeGreaterThanOrEqual(55);
  });

  it('建包校验：非候选题/超上限被拒绝', () => {
    const recs = computeRecommendations(studentId, new Date('2026-09-05'));
    expect(createPacket(studentId, ['not-an-item']).ok).toBe(false);
    expect(createPacket(studentId, recs.slice(0, 9).map((r) => r.itemId)).ok).toBe(false);
    expect(createPacket(studentId, Array(5).fill(recs[0]!.itemId)).ok).toBe(false);
  });
  it('来源缺失的旧条目不能被误当成演示题并打印整张答案页', () => {
    const db = getDb();
    const item = listItems(studentId)[0]!;
    const origin = db.prepare('SELECT mode FROM asset_origin WHERE asset_id=?').get(item.asset_id) as { mode: string };
    db.prepare('DELETE FROM asset_origin WHERE asset_id=?').run(item.asset_id);
    try {
      expect(computeRecommendations(studentId, new Date()).some(r => r.itemId === item.id)).toBe(false);
      expect(submitReflection(item.id, { attemptState: '完全不会', cause: '计算', masteryFeeling: 1, reviewValue: '必须再做' }, 'student').ok).toBe(false);
    } finally { db.prepare('INSERT INTO asset_origin(asset_id,mode) VALUES(?,?)').run(item.asset_id, origin.mode); }
  });

  it('建包 8 题：状态 scheduled，题目进入 scheduled', () => {
    const recs = computeRecommendations(studentId, new Date('2026-09-05'));
    const r = createPacket(studentId, recs.slice(0, 8).map((x) => x.itemId));
    expect(r.ok).toBe(true);
    packetId = r.packetId!;
    expect(getPacket(packetId)?.status).toBe('scheduled');
    const items = packetItems(packetId);
    expect(items).toHaveLength(8);
    expect(items.every((i) => i.status === 'scheduled')).toBe(true);
    // 剩余候选仍为 eligible
    expect(listItems(studentId).filter((i) => i.status === 'eligible_for_review')).toHaveLength(12);
  });

  it('打印 HTML：题目部分绝不含提示/答案内容', () => {
    const data = buildPacketPrintData(packetId)!;
    expect(data.itemCount).toBe(8);
    const items = packetItems(packetId);
    for (const it of items) {
      if (it.hint_text) expect(data.questionPart).not.toContain(it.hint_text);
      if (it.answer_text) expect(data.questionPart).not.toContain(it.answer_text);
      expect(data.questionPart).toContain(it.short_id);
      expect(data.answersPart).toContain(it.short_id);
    }
    expect(data.questionPart).not.toContain('答案核对要点');
    expect(data.answersPart).toContain('答案核对要点');
    // 演算区与勾选框存在
    expect(data.questionPart).toContain('演算区');
    expect(data.questionPart).toContain('独立完成');
  });

  it('生成 PDF：A4 版式、页数 ≥ 封面+8题+答案、状态推进', async () => {
    const r = await generatePacketPdf(packetId);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(r.path!)).toBe(true);

    const pdf = await PDFDocument.load(fs.readFileSync(r.path!));
    // A4 = 595.28 × 841.89 pt
    const { width, height } = pdf.getPage(0).getSize();
    expect(Math.abs(width - 595.28)).toBeLessThan(1);
    expect(Math.abs(height - 841.89)).toBeLessThan(1);
    expect(pdf.getPageCount()).toBeGreaterThanOrEqual(10);

    const packet = getPacket(packetId)!;
    expect(packet.status).toBe('generated');
    expect(packetItems(packetId).every((i) => i.status === 'packet_generated')).toBe(true);
  }, 90000);

  it('PDF 文本层：题目页无答案文字，答案页在题目页之后', async () => {
    const { pdf_path } = getPacket(packetId)!;
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(pdf_path!)) });
    const doc = await loadingTask.promise;
    const pageText = async (n: number) => {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      return tc.items.map((i) => ('str' in i ? i.str : '')).join('');
    };

    const items = packetItems(packetId);
    const firstHint = items.map((i) => i.hint_text).find(Boolean)!;
    // 封面+全部题目页：不含任何提示/答案原文与答案章节标题
    for (let n = 2; n <= 1 + items.length; n++) {
      const text = await pageText(n);
      expect(text).not.toContain('答案核对要点');
      expect(text).not.toContain(firstHint.replace(/\s/g, ''));
    }
    // 第 2 页（第一道题）含题号与演算区
    expect(await pageText(2)).toContain(items[0]!.short_id);
    // 最后一页为答案章
    expect(await pageText(doc.numPages)).toContain('答案核对要点');
    await loadingTask.destroy();
  }, 60000);

  it('重复生成 PDF 幂等：路径稳定、状态不回退', async () => {
    const before = getPacket(packetId)!;
    const r = await generatePacketPdf(packetId);
    expect(r.ok).toBe(true);
    const after = getPacket(packetId)!;
    expect(after.pdf_path).toBe(before.pdf_path);
    expect(after.status).toBe('generated');
    expect(after.generated_at).toBe(before.generated_at);
    const db = getDb();
    const events = db
      .prepare("SELECT COUNT(*) AS n FROM audit_event WHERE name = 'packet_generated' AND entity_id = ?")
      .get(packetId) as { n: number };
    expect(events.n).toBe(2); // 允许重复生成，但每次留痕
  }, 90000);
});
