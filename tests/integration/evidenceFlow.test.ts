import { beforeAll, describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { createProfile } from '../../src/services/studentService.js';
import { createBatch, processBatch } from '../../src/services/batchService.js';
import { getDb } from '../../src/db/connection.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { validateEvidence } from '../../src/ai/evidence.js';
import { discardEvidenceCandidate, getEvidence, saveEvidence, checkEvidenceCrops } from '../../src/services/evidenceService.js';
import { SyntheticCropClient } from '../helpers/syntheticCropClient.js';
import { StagedProvider } from '../../src/ai/stagedProvider.js';
import { getItem, submitReflection } from '../../src/services/itemService.js';
import { createApp } from '../../src/app.js';
import { createPacket } from '../../src/services/planService.js';
import { buildPacketPrintData } from '../../src/services/pdfService.js';
import fs from 'node:fs';

const content = () => validateEvidence({ version: 1, questionNumber: '13', questionText: '两根互为倒数，求m。', subject: '数学', chapter: '方程', knowledgeTags: ['根与系数'], questionType: '计算',
  questionRegion: { x: .1, y: .1, width: .8, height: .8 }, requiresDiagram: false,
  regions: [{ id: 's1', kind: 'student_work', box: { x: .2, y: .2, width: .2, height: .2 }, confidence: .8, cleanForPrint: false }],
  observations: [{ id: 'o1', kind: 'student_work', text: 'x1+x2=0，m=1', regionId: 's1', confidence: .8 }], uncertainties: [] });

describe('真实证据在应用中流转（合成 HTTP 以外的本地业务测试）', () => {
  let itemId: string;
  async function prepare(input: unknown) {
    await saveEvidence(itemId, input, false);
    setAiProviderForTest(new StagedProvider(new SyntheticCropClient()));
    await checkEvidenceCrops(itemId, getEvidence(itemId)!.revision);
  }
  beforeAll(async () => {
    class EvidenceProvider extends MockAiProvider {
      override async extractItems() { return { items: [{ itemIndex: 0, textExcerpt: '两根互为倒数，求m。', subject: '数学' as const, chapter: '方程', knowledgeTags: ['根与系数'], questionType: '计算', hasTeacherNote: false, hasAnswer: false, confidence: .99, fieldConfidence: { question: .99 }, evidence: content(), evidenceRuns: [] }] }; }
    }
    setAiProviderForTest(new EvidenceProvider());
    const student = createProfile({ nickname: '合成业务测试', subjects: ['数学'], weekendPref: '周六' });
    const buffer = await sharp({ create: { width: 100, height: 100, channels: 3, background: '#ffffff' } }).png().toBuffer();
    const { batchId } = await createBatch(student.id, [{ filename: 'synthetic.png', mime: 'image/png', buffer }]);
    await processBatch(batchId);
    itemId = (getDb().prepare('SELECT id FROM error_item WHERE batch_id=?').get(batchId) as { id: string }).id;
  });
  it('高置信度真实证据仍需校对，完整作答持久化', () => {
    expect(getItem(itemId)?.status).toBe('needs_review');
    expect(getEvidence(itemId)?.content.observations[0]!.text).toBe('x1+x2=0，m=1');
    expect(getEvidence(itemId)?.verified).toBe(false);
    expect(submitReflection(itemId, { attemptState: '其他', cause: '计算', masteryFeeling: 2, reviewValue: '可以再做' }, 'student').ok).toBe(false);
  });
  it('校对后允许反思；修改证据使历史诊断失效', async () => {
    await prepare(content());
    await saveEvidence(itemId, content(), true);
    expect(getItem(itemId)?.status).toBe('ready_for_reflection');
    const revision = getEvidence(itemId)!.revision;
    getDb().prepare("UPDATE evidence_record SET diagnosis_json='{}', coaching_json='{}' WHERE item_id=?").run(itemId);
    await saveEvidence(itemId, { ...content(), questionText: '完整题目已修正' }, false);
    expect(getEvidence(itemId)?.revision).toBe(revision + 1);
    expect(getEvidence(itemId)?.diagnosis).toBeNull();
    expect(getEvidence(itemId)?.coaching).toBeNull();
    expect(getItem(itemId)?.status).toBe('needs_review');
  });
  it('并发校对的失败方不会覆盖获胜版本的图示缓存', async () => {
    const version = { ...content(), requiresDiagram: true, regions: [...content().regions, { id: 'diagram', kind: 'diagram', box: { x: .1, y: .1, width: .3, height: .3 }, confidence: .9, cleanForPrint: true }] };
    await prepare(version);
    const writes = vi.spyOn(fs, 'writeFileSync');
    try {
      const outcomes = await Promise.allSettled([saveEvidence(itemId, version, true), saveEvidence(itemId, version, true)]);
      expect(outcomes.filter(o => o.status === 'fulfilled')).toHaveLength(1);
      expect(writes.mock.calls.filter(([p]) => String(p).includes('/evidence/'))).toHaveLength(1);
    } finally { writes.mockRestore(); }
  });
  it('学生可以排除非错题候选，不需要捏造四项错因反思', () => {
    discardEvidenceCandidate(itemId);
    expect(getItem(itemId)?.status).toBe('archived_not_worth_review');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM error_diagnosis WHERE item_id=?').get(itemId)).toEqual({ n: 0 });
    expect(getEvidence(itemId)).not.toBeNull();
  });
  it('真实打印只嵌入确认过的图示，不能嵌入整张带答案原图', async () => {
    const version = { ...content(), requiresDiagram: true, regions: [...content().regions, { id: 'diagram', kind: 'diagram', box: { x: .2, y: .2, width: .3, height: .3 }, confidence: .9, cleanForPrint: true }] };
    await prepare(version); await saveEvidence(itemId, version, true);
    submitReflection(itemId, { attemptState: '其他', cause: '计算', masteryFeeling: 2, reviewValue: '可以再做' }, 'student');
    const packet = createPacket(getItem(itemId)!.student_id, [itemId]);
    expect(packet.ok).toBe(true);
    const data = buildPacketPrintData(packet.packetId!)!;
    const asset = getDb().prepare('SELECT storage_path FROM source_asset WHERE id=?').get(getItem(itemId)!.asset_id) as {storage_path:string};
    expect(data.questionPart).not.toContain(fs.readFileSync(asset.storage_path).toString('base64'));
    expect(data.questionPart).toContain('data:image/jpeg;base64,');
    expect(data.questionPart).not.toContain('x1+x2=0，m=1');
    expect(data.questionPart).toContain('两根互为倒数');
    expect(data.answersPart).toContain('尚未提供');
  });
  it('已经进入纸质复习包的证据不能原地改写', async () => {
    const db = getDb(); const student = getItem(itemId)!.student_id;
    db.prepare("INSERT INTO review_packet(id,student_id,week,created_at) VALUES ('lock-packet',?,'2026-W37',datetime('now'))").run(student);
    db.prepare("INSERT INTO review_packet_item(packet_id,item_id,position) VALUES ('lock-packet',?,0)").run(itemId);
    await expect(saveEvidence(itemId, content(), true)).rejects.toThrow(/复习包/);
  });
  it('证据校对页面实际可读，家长直接访问被拒绝', async () => {
    const server = createApp().listen(0, '127.0.0.1');
    await new Promise<void>(r => server.once('listening', r));
    try {
      const url = `http://127.0.0.1:${(server.address() as {port:number}).port}/items/${itemId}/evidence`;
      const response = await fetch(url);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('x1+x2=0，m=1');
      expect((await fetch(url, { headers: { cookie: 'sel_role=parent' } })).status).toBe(403);
    } finally { server.close(); }
  });
});
