/** P0-4 / P0-5: relaxed automatic inclusion, the batch "not yet included" list, and other subjects. Synthetic data only. */
import { describe, expect, it, vi } from 'vitest';
import { getDb, newId, now } from '../../src/db/connection.js';
import { ensureStudentProfile } from '../../src/services/studentService.js';
import { MaterialStore } from '../../src/materials/store.js';
import { fullMarksOf, includeQuestions, markedRight, materialIntakeSummary, notYetIncluded, setQuestionIncluded, sortQuestions, teacherMarkMeansRight, teacherMarkMeansWrong, unplacedMaterial, unsupportedSubject } from '../../src/materials/learning.js';
import type { Fragment } from '../../src/materials/contracts.js';

function fixture(subject: string | null = '数学') {
  const owner = ensureStudentProfile().id, db = getDb(), store = new MaterialStore(db, owner), batch = newId('bat');
  db.prepare('INSERT INTO source_batch(id,student_id,created_at) VALUES (?,?,?)').run(batch, owner, now());
  /** A synthetic photo; `at` fixes its capture order. */
  const photo = (at?: string) => {
    const id = newId('ast');
    db.prepare('INSERT INTO source_asset(id,batch_id,filename,mime,size,content_hash,storage_path,created_at) VALUES (?,?,?,?,?,?,?,?)').run(id, batch, 'synthetic.jpg', 'image/jpeg', 1, 'hash', '/synthetic.jpg', now());
    db.prepare('INSERT INTO material_asset(id,owner_id,capture_id,source_asset_id) VALUES (?,?,?,?)').run(id, owner, store.createCapture(crypto.randomUUID()).id, id);
    if (at) db.prepare('UPDATE material_asset SET created_at=? WHERE id=?').run(at, id);
    return id;
  };
  const asset = photo();
  const question = (stem: string, marks: string[] = [], extra: Partial<Fragment> = {}, at: { number?: string | null; asset?: string; documentId?: string | null } = {}) => {
    const number = at.number === undefined ? '1' : at.number;
    const id = store.createQuestion({ number, subject, documentId: at.documentId ?? null }).id;
    for (const [role, text] of [...(stem ? [['question', stem]] : []), ...marks.map(m => ['teacher_mark', m])] as [Fragment['role'], string][]) {
      const f: Fragment = { assetId: at.asset ?? asset, fragmentId: newId('mfr'), revision: 1, box: { x: 0, y: 0, width: 1, height: 1 }, sourceHash: 'hash', role, text, number, subpart: null, page: null, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [], ...(role === 'teacher_mark' ? extra : {}) };
      store.putFragment(f); store.linkFragment(f.fragmentId, 1, { questionId: id, attemptId: null });
    }
    return id;
  };
  return { db, store, asset, owner, photo, question };
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
  it('counts a cross followed by the teacher\'s comment, and a transcribed X, but never an expression', () => {
    for (const mark of ['× 漏了 x≤5', '×漏了x≤5', '✗ 符号错', '✘ 单位', '× 第二步移项没有变号，结果应为 x=-3，请订正', 'X', 'x', 'X 漏解', 'x 漏了 x≤5', 'X 不正确']) expect(teacherMarkMeansWrong(mark), mark).toBe(true);
    for (const mark of ['x=5', 'x = 5', 'x>2', 'x ≤ 5', 'X 很好', 'x 的值正确', 'xy', '√ 很好']) expect(teacherMarkMeansWrong(mark), mark).toBe(false);
  });
  it('reads a lone tick (or the word for right, or a ticked full score) as right, and nothing that means wrong', () => {
    for (const mark of ['√', '✓', '✔', '√√', '对', '正确', '满分']) expect(teacherMarkMeansRight(mark), mark).toBe(true);
    expect(teacherMarkMeansRight('√ 6', 6)).toBe(true);
    expect(teacherMarkMeansRight('√ 4', 6)).toBe(false);
    for (const mark of ['√/', '半对', '×', '× 漏了 x≤5', '-2', '不对', '5/5', '']) expect(teacherMarkMeansRight(mark), mark).toBe(false);
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
  it('includes「× 漏了 x≤5」by itself and stops offering questions the teacher ticked', () => {
    const f = fixture();
    const before = materialIntakeSummary(f.store).pending;
    const commented = f.question('4. 解不等式组。', ['× 漏了 x≤5']);
    const ticked = f.question('5. 计算 sin30°+cos60°。', ['√']);
    const unsureTick = f.question('6. 求 y。', ['√'], { uncertainties: ['blurry'] });
    const plain = f.question('7. 求 z。');
    expect(f.store.getQuestion(commented)!.itemId).toBeTruthy();
    expect(f.store.getQuestion(ticked)!.itemId).toBeNull();
    expect(markedRight(f.store.getQuestion(ticked)!)).toBe(true);
    expect(markedRight(f.store.getQuestion(unsureTick)!)).toBe(false);
    expect(markedRight(f.store.getQuestion(plain)!)).toBe(false);
    const groups = notYetIncluded(f.store).filter(g => g.assetId === f.asset);
    expect(groups.flatMap(g => g.questions.map(q => q.id)).sort()).toEqual([unsureTick, plain].sort());
    expect(materialIntakeSummary(f.store).pending - before).toBe(2);
    // A ticked question can still be included by hand.
    expect(includeQuestions(f.store, [{ questionId: ticked, revision: f.store.getQuestion(ticked)!.revision }])).toEqual({ included: 1, skipped: 0 });
  });
  it('lists questions by paper and printed number (2 before 10), then photo; unnumbered last', () => {
    const f = fixture();
    const first = f.photo('2026-01-01 00:00:01'), second = f.photo('2026-01-01 00:00:02');
    const paper = newId('mdoc');
    f.db.prepare('INSERT INTO material_document(id,owner_id,label) VALUES (?,?,?)').run(paper, f.owner, null);
    // Created out of order; question 6 of the paper was photographed first, questions 1-2 and 10 later.
    const loose = f.question('另一张卷子的题。', [], {}, { number: '3', asset: second });
    const q10 = f.question('10. 求 a。', [], {}, { number: '10', asset: second, documentId: paper });
    const q6 = f.question('6. 求 b。', [], {}, { number: '6', asset: first, documentId: paper });
    const unnumbered = f.question('求 c。', [], {}, { number: null, asset: second, documentId: paper });
    const q2 = f.question('2. 求 d。', [], {}, { number: '2', asset: second, documentId: paper });
    const q1 = f.question('1. 求 e。', [], {}, { number: '1', asset: second, documentId: paper });
    const mine = [loose, q10, q6, unnumbered, q2, q1];
    const sorted = sortQuestions(f.store, f.store.listQuestions().filter(q => mine.includes(q.id))).map(q => q.id);
    expect(sorted).toEqual([q1, q2, q6, q10, unnumbered, loose]);
    // The batch list keeps one group per photo, each in the same order; the paper's first question leads.
    const groups = notYetIncluded(f.store).filter(g => g.assetId === first || g.assetId === second);
    expect(groups.map(g => g.assetId)).toEqual([second, first]);
    expect(groups.map(g => g.questions.map(q => q.id))).toEqual([[q1, q2, q10, unnumbered, loose], [q6]]);
  });
  it('treats material without a number and without a stem as unplaced, never as a question', () => {
    const f = fixture();
    const mark = f.store.getQuestion(f.question('', ['×'], {}, { number: null }))!;
    const unnumberedStem = f.store.getQuestion(f.question('求 x。', [], {}, { number: null }))!;
    const numberedWork = f.store.getQuestion(f.question('', ['√'], {}, { number: '3' }))!;
    expect(unplacedMaterial(mark)).toBe(true);
    expect(mark.itemId).toBeNull();
    expect(unplacedMaterial(unnumberedStem)).toBe(false);
    expect(unplacedMaterial(numberedWork)).toBe(false);
    // An empty question the student created or kept is not material to place.
    expect(unplacedMaterial(f.store.getQuestion(f.store.createQuestion({ subject: '数学' }).id)!)).toBe(false);
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
