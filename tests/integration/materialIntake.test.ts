/** P0-4 / P0-5: relaxed automatic inclusion, the batch "not yet included" list, and other subjects. Synthetic data only. */
import { describe, expect, it, vi } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { MaterialStore } from '../../src/materials/store.js';
import { fullMarksOf, includeQuestions, materialIntakeSummary, notYetIncluded, setQuestionIncluded, teacherMarkMeansWrong, unsupportedSubject } from '../../src/materials/learning.js';
import type { Fragment } from '../../src/materials/contracts.js';

function fixture(subject: string | null = '数学') {
  const owner = ensureStudentProfile().id, db = getDb(), store = new MaterialStore(db, owner), batch = newId('bat'), asset = newId('ast');
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch, owner, now());
  db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(asset, batch, 'synthetic.jpg', 'image/jpeg', 1, 'hash', '/synthetic.jpg', now());
  db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(asset, owner, store.createCapture(crypto.randomUUID()).id, asset);
  const question = (stem: string, marks: string[] = [], extra: Partial<Fragment> = {}) => {
    const id = store.createQuestion({ number: '1', subject }).id;
    for (const [role, text] of [['question', stem], ...marks.map(m => ['teacher_mark', m])] as [Fragment['role'], string][]) {
      const f: Fragment = { assetId: asset, fragmentId: newId('mfr'), revision: 1, box: { x: 0, y: 0, width: 1, height: 1 }, sourceHash: 'hash', role, text, number: '1', subpart: null, page: null, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [], ...(role === 'teacher_mark' ? extra : {}) };
      store.putFragment(f); store.linkFragment(f.fragmentId, 1, { questionId: id, attemptId: null });
    }
    return id;
  };
  return { db, store, asset, question };
}

describe('teacher marks that mean "not full marks"', () => {
  it('counts crosses, half ticks, circles, deductions without 分 and scores below full marks', () => {
    for (const mark of ['×', '✗', '× ', '错', '半对', '√/', '✓／', '○', '◯', '-6', '−6', '－3分', '-2.5', '扣2', '扣 3 分', '× -4', '3/5', '得2/6分', '0/4']) expect(teacherMarkMeansWrong(mark), mark).toBe(true);
    expect(teacherMarkMeansWrong('4', 6)).toBe(true);
    expect(teacherMarkMeansWrong('4分', 6)).toBe(true);
    expect(teacherMarkMeansWrong('6', 6)).toBe(false);
    expect(teacherMarkMeansWrong('4')).toBe(false);
  });
  it('never counts praise, a full score or longer text that merely contains a mark', () => {
    for (const mark of ['√', '✓', '没有错误', '不错', '已批改', '5/5', '6分', '优', '注意 -6 是负数的写法，这里要写清楚并检查一遍过程', '']) expect(teacherMarkMeansWrong(mark), mark).toBe(false);
  });
  it('reads printed full marks from the stem', () => {
    expect(fullMarksOf('1. 计算（6分）')).toBe(6);
    expect(fullMarksOf('21.(本题 12 分) 已知')).toBe(12);
    expect(fullMarksOf('（满分10分）求')).toBe(10);
    expect(fullMarksOf('求 1+1')).toBeNull();
  });
});

describe('automatic inclusion and the batch list', () => {
  it('includes half ticks, circles, "-6" and a bare score below the printed full marks; keeps uncertain marks out', () => {
    const f = fixture();
    const auto = ['√/', '○', '-6', '3/5'].map(m => f.question('求 x 的值。', [m]));
    const bare = f.question('20.（8分）解方程。', ['5']);
    const full = f.question('20.（8分）解方程。', ['8']);
    const unsure = f.question('求 y。', ['-6'], { uncertainties: ['blurry'] });
    const plain = f.question('求 z。');
    for (const id of [...auto, bare]) expect(f.store.getQuestion(id)!.itemId, id).toBeTruthy();
    for (const id of [full, unsure, plain]) expect(f.store.getQuestion(id)!.itemId, id).toBeNull();
    const groups = notYetIncluded(f.store).filter(g => g.assetId === f.asset);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.questions.map(q => q.id).sort()).toEqual([full, unsure, plain].sort());
    expect(materialIntakeSummary(f.store)).toEqual({ pending: 3, failed: 0, processing: 0 });
  });
  it('batch inclusion is idempotent, skips stale revisions and never re-offers a removed question', () => {
    const f = fixture();
    const a = f.question('求 a。'), b = f.question('求 b。'), c = f.question('求 c。');
    const rev = (id: string) => f.store.getQuestion(id)!.revision;
    setQuestionIncluded(f.store, c, false, rev(c));
    const mine = () => notYetIncluded(f.store).find(g => g.assetId === f.asset)!.questions.map(q => q.id).sort();
    expect(mine()).toEqual([a, b].sort());
    expect(includeQuestions(f.store, [{ questionId: a, revision: rev(a) }, { questionId: b, revision: rev(b) - 1 }])).toEqual({ included: 1, skipped: 1 });
    expect(includeQuestions(f.store, [{ questionId: a, revision: rev(a) }])).toEqual({ included: 1, skipped: 0 });
    expect(f.db.prepare('SELECT count(*) n FROM material_item_link WHERE question_id=?').get(a)).toEqual({ n: 1 });
    expect(mine()).toEqual([b]);
  });
});

describe('only 数学/物理/化学 in the trial', () => {
  it('recognizes clearly named other subjects and leaves the supported and unknown ones alone', () => {
    expect(unsupportedSubject('英语')).toBe('英语');
    expect(unsupportedSubject('高三英语月考')).toBe('英语');
    expect(unsupportedSubject('English')).toBe('英语');
    expect(unsupportedSubject('生物')).toBe('生物');
    expect(unsupportedSubject('道德与法治')).toBe('政治');
    for (const s of ['数学', '高中物理', '化学', 'math', 'Physics', null, '', '综合', '科学']) expect(unsupportedSubject(s), String(s)).toBeNull();
  });
  it('does not auto-include or batch-offer questions of another subject', () => {
    const f = fixture('英语');
    const q = f.question('Choose the best answer.', ['×']);
    expect(f.store.getQuestion(q)!.itemId).toBeNull();
    expect(notYetIncluded(f.store).some(g => g.assetId === f.asset)).toBe(false);
    expect(includeQuestions(f.store, [{ questionId: q, revision: f.store.getQuestion(q)!.revision }])).toEqual({ included: 0, skipped: 1 });
    expect(f.db.prepare('SELECT count(*) n FROM material_item_link WHERE question_id=?').get(q)).toEqual({ n: 0 });
  });
});

describe('batch inclusion cost', () => {
  it('runs the learning projection once per batch, not once per question', async () => {
    const learning = await import('../../src/materials/learning.js');
    const f = fixture();
    const ids = Array.from({ length: 5 }, (_, i) => f.question(`求 ${i}。`));
    const before = (f.db.prepare('SELECT count(*) n FROM material_inclusion_event').get() as { n: number }).n;
    const listSpy = vi.spyOn(f.store, 'listQuestions');
    expect(learning.includeQuestions(f.store, ids.map(id => ({ questionId: id, revision: f.store.getQuestion(id)!.revision })))).toEqual({ included: 5, skipped: 0 });
    // syncMaterialLearning walks listQuestions once; per-question sync would walk it five times.
    expect(listSpy).toHaveBeenCalledTimes(1);
    expect((f.db.prepare('SELECT count(*) n FROM material_inclusion_event').get() as { n: number }).n - before).toBe(5);
  });
});
