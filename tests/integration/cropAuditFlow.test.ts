import fs from 'node:fs';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { validateEvidence, type Evidence } from '../../src/ai/evidence.js';
import { StagedProvider } from '../../src/ai/stagedProvider.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { SyntheticCropClient } from '../helpers/syntheticCropClient.js';
import { createProfile } from '../../src/services/studentService.js';
import { createBatch, processBatch } from '../../src/services/batchService.js';
import * as service from '../../src/services/evidenceService.js';
import { getDb } from '../../src/db/connection.js';
import { getItem, submitReflection } from '../../src/services/itemService.js';
import { createPacket } from '../../src/services/planService.js';
import { buildPacketPrintData } from '../../src/services/pdfService.js';
import { createApp } from '../../src/app.js';
import type { StageRun } from '../../src/ai/chatClient.js';
import { chromium } from '@playwright/test';
import path from 'node:path';
import { packetsDir } from '../../src/config.js';
import { cropCheckHash } from '../../src/ai/cropAuditor.js';

describe('裁图检查必须接到确认和打印业务门禁（合成）', () => {
  let itemId: string; let content: Evidence; let client: SyntheticCropClient; let fixtureIndex = 0;
  beforeEach(async () => {
    content = validateEvidence({ version: 1, questionNumber: '9', questionText: '已知2x−1，求B。', subject: '数学', chapter: '', knowledgeTags: ['测试'], questionType: '',
      questionRegion: { x: .1, y: .1, width: .8, height: .3 }, requiresDiagram: false, regions: [], observations: [], uncertainties: [] });
    class FixtureProvider extends MockAiProvider { override async extractItems() { return { items: [{ itemIndex: 0, textExcerpt: content.questionText,
      subject: '数学' as const, knowledgeTags: ['测试'], hasTeacherNote: false, hasAnswer: false, confidence: 1, fieldConfidence: {}, evidence: content }] }; } }
    setAiProviderForTest(new FixtureProvider());
    const student = createProfile({ nickname: '合成裁图测试', subjects: ['数学'], weekendPref: '周六' });
    const buffer = await sharp({ create: { width: 200 + fixtureIndex++, height: 300, channels: 3, background: 'white' } }).png().toBuffer();
    const batch = await createBatch(student.id, [{ filename: 'synthetic.png', mime: 'image/png', buffer }]);
    await processBatch(batch.batchId);
    itemId = (getDb().prepare('SELECT id FROM error_item WHERE batch_id=?').get(batch.batchId) as {id:string}).id;
    client = new SyntheticCropClient(); setAiProviderForTest(new StagedProvider(client));
  });
  it('未检查和调用成功但题干缺失均不能确认，结果不会自动替人确认', async () => {
    await expect(service.saveEvidence(itemId, content, true)).rejects.toThrow(/检查/);
    client.visibility = 'missing';
    await service.checkEvidenceCrops(itemId, 1);
    expect(service.getEvidence(itemId)!.cropAudit!.targets[0]).toMatchObject({ technicalStatus: 'completed', completeness: 'missing' });
    await expect(service.saveEvidence(itemId, content, true)).rejects.toThrow(/完整/);
    expect(service.getEvidence(itemId)!.verified).toBe(false);
  });
  it('完整性通过后才允许人工确认；改题干使结果和诊断失效', async () => {
    await service.checkEvidenceCrops(itemId, 1);
    expect(service.getEvidence(itemId)!.verified).toBe(false);
    await service.saveEvidence(itemId, content, true);
    expect(service.getEvidence(itemId)!.verified).toBe(true);
    expect(client.calls).toHaveLength(2);
    await service.saveEvidence(itemId, { ...content, questionText: '修改题干' }, false);
    expect(service.getEvidence(itemId)!.cropAudit).toBeNull();
    expect(service.getEvidence(itemId)!.verified).toBe(false);
  });
  it('检查期间修改裁框，过期返回不覆盖新版本；重复点击不重复付费', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }); client.beforeResponse = () => gate;
    const pending = service.checkEvidenceCrops(itemId, 1);
    await expect(service.checkEvidenceCrops(itemId, 1)).rejects.toThrow(/正在/);
    await service.saveEvidence(itemId, { ...content, questionRegion: { x: 0, y: 0, width: 1, height: 1 } }, false);
    release(); await expect(pending).rejects.toThrow(/更新/);
    expect(service.getEvidence(itemId)!.cropAudit).toBeNull();
  });
  it('原图变化后不能反思、选入复习包或打印旧的通过结果', async () => {
    await service.checkEvidenceCrops(itemId, 1); await service.saveEvidence(itemId, content, true);
    const reflection = { attemptState: '其他' as const, cause: '计算' as const, masteryFeeling: 2 as const, reviewValue: '可以再做' as const };
    expect(submitReflection(itemId, reflection, 'student').ok).toBe(true);
    const packet = createPacket(getItem(itemId)!.student_id, [itemId]); expect(packet.ok).toBe(true);
    expect(buildPacketPrintData(packet.packetId!)!.questionPart).toContain('已知2x−1');
    fs.appendFileSync(service.evidenceSource(itemId).storagePath, 'SYNTHETIC_SOURCE_CHANGED');
    expect(submitReflection(itemId, reflection, 'student').ok).toBe(false);
    expect(() => buildPacketPrintData(packet.packetId!)).toThrow(/过期/);
    const pdf = path.join(packetsDir(), 'synthetic-stale.pdf'); fs.writeFileSync(pdf, '%PDF-SYNTHETIC');
    getDb().prepare('UPDATE review_packet SET pdf_path=? WHERE id=?').run(pdf, packet.packetId!);
    const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/packets/${packet.packetId}`;
      expect((await fetch(`${url}/pdf`)).status).toBe(409);
      expect((await fetch(`${url}/print-preview`)).status).toBe(409);
    } finally { server.close(); }
  });
  it('页面有整题裁图和独立检查状态；GET无付费调用，家长不能触发检查', async () => {
    const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/items/${itemId}/evidence`;
      const html = await (await fetch(url)).text();
      expect(html).toContain('裁图完整性'); expect(html).toContain('未经检查');
      expect(html).toContain('/question-crop');
      expect(client.calls).toHaveLength(0);
      expect((await fetch(`${url}/check-crops`, { method: 'POST', headers: { cookie: 'sel_role=parent' } })).status).toBe(403);
      expect((await fetch(`${url}/question-crop`)).headers.get('content-type')).toContain('image/jpeg');
    } finally { server.close(); }
  });
  it('真实提取链路自动附带裁图检查，不将残缺候选吞掉或标成已确认', async () => {
    const run: StageRun = { stage: 'layout', model: 'synthetic', durationMs: 1, promptTokens: 1, completionTokens: 1, maxTokens: 128, thinking: false, promptVersion: 'synthetic' };
    class ExtractionFixture extends StagedProvider {
      override async layout() { return { value: { questions: [{ questionNumber: '9', box: content.questionRegion, confidence: 1, selectionEvidence: 'unclear' as const }] }, run }; }
      override async transcribe() { return { value: content, run: { ...run, stage: 'transcribe' as const } }; }
    }
    client.visibility = 'missing';
    const result = await new ExtractionFixture(client).extractItems(service.evidenceSource(itemId));
    expect(result.items[0]!.cropAudit?.targets[0]).toMatchObject({ completeness: 'missing', technicalStatus: 'completed' });
    expect(result.items[0]!.evidence?.questionText).toBe('已知2x−1，求B。');
  });
  it('POST检查保存实际结果，扩大框使旧检查失效且保持草稿', async () => {
    const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/items/${itemId}/evidence`;
      const post = (suffix: string, body: Record<string, string>) => fetch(url + suffix, { method: 'POST', body: new URLSearchParams(body), redirect: 'manual' });
      expect((await post('/check-crops', { revision: '0' })).headers.get('location')).toContain('err=');
      expect(client.calls).toHaveLength(0);
      expect((await post('/check-crops', { revision: '1' })).headers.get('location')).not.toContain('err=');
      expect(service.getEvidence(itemId)!.cropAudit!.targets[0]!.completeness).toBe('pass');
      expect((await post('/expand-crop', { revision: '1', target: 'question' })).headers.get('location')).not.toContain('err=');
      const record = service.getEvidence(itemId)!;
      expect(record.content.questionRegion.x).toBeLessThan(.1);
      expect(record.content.questionRegion.width).toBeGreaterThan(.8);
      expect(record.cropAudit).toBeNull(); expect(record.verified).toBe(false);
    } finally { server.close(); }
  });
  it('手机浏览器改整题框、保存、自动检查再人工确认的实际表单流程', async () => {
    const server = createApp().listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/items/${itemId}/evidence`;
      await page.goto(url);
      await page.locator('input[name="question_x"]').fill('0.05');
      await page.getByRole('button', { name: '保存草稿，刷新预览', exact: true }).click();
      await page.waitForURL(url);
      expect(service.getEvidence(itemId)!.content.questionRegion.x).toBe(.05);
      await page.getByRole('button', { name: '对已保存版本运行自动裁图检查（调用模型）', exact: true }).click();
      await page.waitForURL(url);
      expect(service.getEvidence(itemId)!.cropAudit!.targets[0]!.completeness).toBe('pass');
      expect(service.getEvidence(itemId)!.verified).toBe(false);
      await page.getByRole('button', { name: '已核对完整题目、图示与作答归属，确认', exact: true }).click();
      await page.waitForURL(url);
      expect(service.getEvidence(itemId)!.verified).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    } finally { await browser.close(); server.close(); }
  });
  it('模型误报可由有依据的人工逐项复核解决，保留原判定且改框后失效', async () => {
    client.visibility = 'missing'; await service.checkEvidenceCrops(itemId, 1);
    const decision = { modelCheckHash: cropCheckHash(service.getEvidence(itemId)!.cropAudit!.targets[0]!), requiredElements: ['完整2x−1条件', '求B的要求'], notes: '已对照原图和实际裁图逐项检查，两个必需内容均完整可见。',
      sourceCompared: true, complete: true, textMatches: true, pure: true, coveredDiagramIds: [] };
    expect(() => service.resolveEvidenceCrop(itemId, 1, 'question', { ...decision, notes: '' })).toThrow();
    service.resolveEvidenceCrop(itemId, 1, 'question', decision);
    expect(service.getEvidence(itemId)!.cropAudit!.targets[0]!.completeness).toBe('missing');
    expect(service.getEvidence(itemId)!.cropAudit!.humanResolutions[0]!.reviewedBy).toBe('student');
    expect(service.getEvidence(itemId)!.verified).toBe(false);
    await service.saveEvidence(itemId, content, true);
    expect(service.getEvidence(itemId)!.verified).toBe(true);
    await service.saveEvidence(itemId, { ...content, questionRegion: { x: 0, y: 0, width: 1, height: 1 } }, false);
    expect(service.getEvidence(itemId)!.cropAudit).toBeNull();
    await expect(service.saveEvidence(itemId, service.getEvidence(itemId)!.content, true)).rejects.toThrow(/检查/);
  });
});
