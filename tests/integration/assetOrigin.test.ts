import sharp from 'sharp';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Evidence, ObservationKind } from '../../src/ai/evidence.js';
import { setAiProviderForTest } from '../../src/ai/index.js';
import { MockAiProvider } from '../../src/ai/mockProvider.js';
import type { ExtractedItem } from '../../src/ai/provider.js';
import { getDb, now } from '../../src/db/connection.js';
import { isDemoAsset } from '../../src/services/assetOrigin.js';
import { createBatch, processBatch } from '../../src/services/batchService.js';
import { createProfile } from '../../src/services/studentService.js';

function evidence(kind: ObservationKind): Evidence {
  return {
    version: 1,
    questionNumber: '1',
    questionText: '合成题目，仅用于本地事务测试。',
    subject: '数学',
    chapter: '测试',
    knowledgeTags: ['事务'],
    questionType: '计算题',
    questionRegion: { x: 0, y: 0, width: 1, height: 1 },
    requiresDiagram: false,
    regions: [],
    observations: [{ id: `obs-${kind}`, kind, text: '合成观察', regionId: null, confidence: 0.9 }],
    uncertainties: [],
  };
}

function item(itemIndex: number, itemEvidence: ExtractedItem['evidence']): ExtractedItem {
  return {
    itemIndex,
    textExcerpt: `合成题 ${itemIndex}`,
    subject: '数学',
    chapter: '测试',
    knowledgeTags: ['事务'],
    questionType: '计算题',
    hasTeacherNote: false,
    hasAnswer: false,
    confidence: 0.95,
    fieldConfidence: { subject: 0.95, knowledgeTags: 0.95 },
    evidence: itemEvidence,
    evidenceRuns: [],
  };
}

class StaticProvider extends MockAiProvider {
  constructor(private readonly extractedItems: ExtractedItem[]) {
    super(undefined, '');
  }

  override async extractItems(): Promise<{ items: ExtractedItem[] }> {
    return { items: this.extractedItems };
  }
}

let color = 10;
async function createLocalBatch(studentId: string, provider: MockAiProvider): Promise<{ batchId: string; assetId: string }> {
  setAiProviderForTest(provider);
  color += 20;
  const buffer = await sharp({
    create: { width: 12, height: 12, channels: 3, background: { r: color, g: 20, b: 30 } },
  }).png().toBuffer();
  const { batchId } = await createBatch(studentId, [{ filename: `asset-${color}.png`, mime: 'image/png', buffer }]);
  const asset = getDb().prepare('SELECT id FROM source_asset WHERE batch_id = ?').get(batchId) as { id: string };
  return { batchId, assetId: asset.id };
}

describe.sequential('资产来源与 evidence 原子持久化', () => {
  let studentId = '';

  beforeAll(() => {
    studentId = createProfile({ nickname: '事务测试', subjects: ['数学'], weekendPref: '周六' }).id;
  });

  it('records explicit mock origin while missing legacy origin is never treated as demo', async () => {
    const { assetId } = await createLocalBatch(studentId, new StaticProvider([]));
    expect(getDb().prepare('SELECT mode FROM asset_origin WHERE asset_id = ?').get(assetId))
      .toEqual({ mode: 'mock' });
    expect(isDemoAsset(assetId)).toBe(true);

    getDb().prepare('DELETE FROM asset_origin WHERE asset_id = ?').run(assetId);
    expect(isDemoAsset(assetId)).toBe(false);
    expect(isDemoAsset('ast_legacy_unknown')).toBe(false);
  });

  it('rolls back a newly inserted error_item when evidence validation fails', async () => {
    const invalidEvidence = {
      version: 1,
      questionText: '缺少必需字段',
      observations: [],
    } as unknown as Evidence;
    const { batchId, assetId } = await createLocalBatch(
      studentId,
      new StaticProvider([item(0, invalidEvidence)]),
    );

    await processBatch(batchId);

    expect(getDb().prepare('SELECT status FROM source_asset WHERE id = ?').get(assetId))
      .toMatchObject({ status: 'failed' });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM error_item WHERE asset_id = ?').get(assetId))
      .toEqual({ n: 0 });
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM evidence_record').get())
      .toEqual({ n: 0 });
  });

  it('does not mark an asset done when a legacy item exists without its invalid evidence', async () => {
    const invalidEvidence = { version: 1, observations: [] } as unknown as Evidence;
    const { batchId, assetId } = await createLocalBatch(
      studentId,
      new StaticProvider([item(0, invalidEvidence)]),
    );
    getDb().prepare(
      `INSERT INTO error_item
       (id, student_id, batch_id, asset_id, item_index, knowledge_tags, status, confidence, created_at, updated_at)
       VALUES ('itm_legacy_orphan', ?, ?, ?, 0, '[]', 'needs_review', 0.5, ?, ?)`,
    ).run(studentId, batchId, assetId, now(), now());

    await processBatch(batchId);

    expect(getDb().prepare('SELECT status FROM source_asset WHERE id = ?').get(assetId))
      .toMatchObject({ status: 'failed' });
    expect(getDb().prepare('SELECT 1 AS found FROM evidence_record WHERE item_id = ?').get('itm_legacy_orphan'))
      .toBeUndefined();
  });

  it('treats an origin-less legacy orphan as non-demo and does not silently skip it', async () => {
    const { batchId, assetId } = await createLocalBatch(
      studentId,
      new StaticProvider([item(0, undefined)]),
    );
    getDb().prepare('DELETE FROM asset_origin WHERE asset_id = ?').run(assetId);
    getDb().prepare(
      `INSERT INTO error_item
       (id, student_id, batch_id, asset_id, item_index, knowledge_tags, status, confidence, created_at, updated_at)
       VALUES ('itm_originless_orphan', ?, ?, ?, 0, '[]', 'needs_review', 0.5, ?, ?)`,
    ).run(studentId, batchId, assetId, now(), now());

    await processBatch(batchId);

    expect(isDemoAsset(assetId)).toBe(false);
    expect(getDb().prepare('SELECT status FROM source_asset WHERE id = ?').get(assetId))
      .toEqual({ status: 'failed' });
  });

  it('sets has_work_img only when real evidence contains a student_work observation', async () => {
    const { batchId, assetId } = await createLocalBatch(
      studentId,
      new StaticProvider([
        item(0, evidence('student_work')),
        item(1, evidence('teacher_note')),
      ]),
    );

    await processBatch(batchId);

    expect(getDb().prepare('SELECT status FROM source_asset WHERE id = ?').get(assetId))
      .toEqual({ status: 'done' });
    expect(getDb().prepare('SELECT item_index, has_work_img FROM error_item WHERE asset_id = ? ORDER BY item_index').all(assetId))
      .toEqual([
        { item_index: 0, has_work_img: 1 },
        { item_index: 1, has_work_img: 0 },
      ]);
  });
});
