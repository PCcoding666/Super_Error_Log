import { beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { createProfile } from '../../src/services/studentService.js';
import { createBatch, processBatch } from '../../src/services/batchService.js';
import { getDb } from '../../src/db/connection.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import { StagedProvider } from '../../src/ai/stagedProvider.js';
import { validateEvidence } from '../../src/ai/evidence.js';
import { analyzeEvidence, getEvidence, saveEvidence, checkEvidenceCrops } from '../../src/services/evidenceService.js';
import { SyntheticCropClient } from '../helpers/syntheticCropClient.js';
import type { StageRun } from '../../src/ai/chatClient.js';

describe('AI 提示不能绑定到过期诊断（合成并发测试）', () => {
  it('生成提示期间更新诊断后丢弃旧提示', async () => {
    const content = validateEvidence({ version: 1, questionNumber: '1', questionText: '合成题', subject: '数学', chapter: '', knowledgeTags: ['测试'], questionType: '', questionRegion: { x: 0, y: 0, width: 1, height: 1 }, requiresDiagram: false,
      regions: [{ id: 's1', kind: 'student_work', box: { x: 0, y: 0, width: 1, height: 1 }, confidence: 1, cleanForPrint: false }], observations: [{ id: 'o1', kind: 'student_work', text: '合成作答', regionId: 's1', confidence: 1 }], uncertainties: [] });
    class FixtureProvider extends MockAiProvider {
      override async extractItems() { return { items: [{ itemIndex: 0, textExcerpt: '合成题', subject: '数学' as const, knowledgeTags: ['测试'], hasTeacherNote: false, hasAnswer: false, confidence: 1, fieldConfidence: {}, evidence: content }] }; }
    }
    setAiProviderForTest(new FixtureProvider());
    const student = createProfile({ nickname: '合成并发', subjects: ['数学'], weekendPref: '周六' });
    const buffer = await sharp({ create: { width: 10, height: 10, channels: 3, background: 'white' } }).png().toBuffer();
    const batch = await createBatch(student.id, [{ filename: 'synthetic.png', mime: 'image/png', buffer }]);
    await processBatch(batch.batchId);
    const item = getDb().prepare('SELECT id FROM error_item WHERE batch_id=?').get(batch.batchId) as {id:string};
    setAiProviderForTest(new StagedProvider(new SyntheticCropClient()));
    await checkEvidenceCrops(item.id, 1); await saveEvidence(item.id, content, true);
    const run: StageRun = { stage: 'diagnose', model: 'synthetic', durationMs: 1, promptTokens: 1, completionTokens: 1, maxTokens: 128, thinking: false, promptVersion: 'synthetic' };
    const diagnosis = (summary: string) => ({ value: { summary, possibleCause: null, confidence: 0, findings: [], clarificationQuestion: '合成问题？' }, run });
    getDb().prepare('UPDATE evidence_record SET diagnosis_json=? WHERE item_id=?').run(JSON.stringify(diagnosis('A')), item.id);
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    class SlowProvider extends StagedProvider {
      override async coach() { await gate; return { value: { hints: ['合成提示A'], solution: 'A', answer: 'A', source: 'ai_generated' as const }, run: { ...run, stage: 'coach' as const } }; }
    }
    setAiProviderForTest(new SlowProvider());
    const pending = analyzeEvidence(item.id, 'coach');
    getDb().prepare('UPDATE evidence_record SET diagnosis_json=? WHERE item_id=?').run(JSON.stringify(diagnosis('B')), item.id);
    release();
    await expect(pending).rejects.toThrow('诊断');
    expect(getEvidence(item.id)!.diagnosis!.value.summary).toBe('B');
    expect(getEvidence(item.id)!.coaching).toBeNull();
  });
});
