import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Fragment, QuestionBundle } from '../../src/materials/contracts.js';
import { STYLES } from '../../src/web/assets.js';
import { MaterialCapturePage, MaterialsPage, PENDING_FORM_MAX, pendingInOneForm, type MaterialAssetView } from '../../src/web/views/materials.js';

const question = (number: string | null, id = 'q1'): QuestionBundle => ({
  id, documentId: null, revision: 1, basisKey: 'basis', number, subject: null, tags: [],
  stem: [], attempts: [], teacherMarks: [], answers: [], grades: [],
  missing: [], unresolved: [], answerConflict: false, itemId: null,
});

const asset = (label?: string): MaterialAssetView => ({
  id: 'asset-1', hints: label ? { label } : {}, document_id: null, status: 'ready', link_revision: 1, fragments: [],
});

describe('学习材料界面', () => {
  it('待收录合成一个表单时，连每张照片的隐藏字段一起算，仍在表单字段上限以内', () => {
    const groups = (photos: number, perPhoto: number) => Array.from({ length: photos }, (_, p) => ({
      assetId: `asset-${p}`, photo: p + 1, questions: Array.from({ length: perPhoto }, (_, i) => question(String(i + 1), `q${p}-${i}`)),
    }));
    expect(pendingInOneForm(groups(1, 3))).toBe(true);
    expect(pendingInOneForm(groups(1, PENDING_FORM_MAX - 3))).toBe(true);
    // 题数本身没超，但每张照片多一个隐藏字段：81 张照片 120 道题会超过解析上限，必须分开提交。
    expect(pendingInOneForm(groups(81, 1).concat(groups(1, 39)))).toBe(false);
    expect(pendingInOneForm(groups(60, 1))).toBe(false);
    expect(pendingInOneForm([])).toBe(false);
  });

  it('拍学习材料只有一个实心主按钮；拍过之后才出现“拍完了”和上传状态，且只有一条去材料页的行', () => {
    const empty = renderToStaticMarkup(MaterialCapturePage({ namespace: 'ns', count: 0, uploadId: '11111111-1111-4111-8111-111111111111' }));
    expect(empty).toContain('data-testid="root-tabs"');
    expect(empty.match(/class="btn primary"/g)).toHaveLength(1);
    expect(empty).toMatch(/<label class="btn primary" for="camera-input"[^>]*>拍照<\/label>/);
    expect(empty).toContain('class="inset-group hidden" data-capture-done=""');
    expect(empty).toContain('class="hidden" data-capture-progress=""');
    expect(empty).not.toContain('没传完的照片先存在这台手机上');
    const html = renderToStaticMarkup(MaterialCapturePage({ namespace: 'ns', count: 6, uploadId: '11111111-1111-4111-8111-111111111111' }));
    expect(html.match(/class="btn primary"/g)).toHaveLength(1);
    expect(html).toMatch(/<label class="btn primary" for="camera-input"[^>]*>继续拍照<\/label>/);
    expect(html).toMatch(/class="btn"[^>]*>从相册选（可多选）/);
    expect(html.match(/href="\/s\/materials"/g)).toHaveLength(1);
    expect(html).toContain('拍完了，查看材料');
    expect(html).not.toContain('查看已经保存的材料');
    expect(html).toContain('<details class="disclosure"><summary>加个提示（可跳过）</summary>');
    expect(html).not.toContain('class="more"');
    // A supplement for one question is a task page: back to the question instead of the tabs.
    const supplement = renderToStaticMarkup(MaterialCapturePage({ namespace: 'ns', count: 1, uploadId: '11111111-1111-4111-8111-111111111111', context: { questionId: 'q1' } }));
    expect(supplement).not.toContain('data-testid="root-tabs"');
    expect(supplement).toContain('href="/s/materials/questions/q1"');
    expect(STYLES).toContain('.material-surface .btn-stack{display:flex;flex-direction:column;align-items:stretch;gap:var(--s-3)');
    expect(STYLES).toContain('.capture-page:not(.has-tabbar) .capture-actions{bottom:0');
  });

  it('我的材料：每题一行状态，没对上题号的内容按照片汇总成一行，整理工具整组折叠', () => {
    const piece = (fragmentId: string, role: Fragment['role'], text: string): Fragment => ({ assetId: 'asset-1', fragmentId, revision: 1, sourceHash: 'h', box: { x: 0, y: 0, width: 1, height: 1 }, role, text, number: null, subpart: null, page: 1, order: 0, requiresDiagram: false, check: 'passed', uncertainties: [] });
    const html = renderToStaticMarkup(MaterialsPage({
      namespace: 'ns',
      questions: [question('1')],
      assets: [asset('later label')],
      page: 0,
      hasMore: false,
      documents: [],
      changes: [],
      jobs: [{ id: 'job-1', state: 'failed' }],
      revision: 1,
      unplaced: [{ assetId: 'asset-1', photo: 1, items: [
        { questionId: 'q2', fragment: piece('f1', 'student_work', '(x−2)(x−3)=0') }, { questionId: 'q3', fragment: piece('f2', 'student_work', 'x=2') },
        { questionId: 'q4', fragment: piece('f3', 'teacher_mark', '×') }, { questionId: 'q5', fragment: piece('f4', 'correction', 'x=3') },
      ] }],
    }));
    expect(html).toContain('class="group-label"');
    expect(html).toContain('原图和整页归属');
    expect(html).toContain('只有需要调整时才选；一次调整整页，不必逐题确认。');
    expect(html).toContain('按题整理，缺的材料以后再补。');
    expect(html).toContain('href="/s/materials/questions/q1"');
    expect(html).toContain('第 1 题');
    expect(html).not.toContain('待确定题号');
    expect(html).toContain('<summary>这张照片还有 4 段内容没对上题号（作答 2 · 老师批改 1 · 订正 1）</summary>');
    expect(html).toContain('href="/s/materials/questions/q2#adjust"');
    // One status line per question; supplementing happens on the question page.
    expect(html.match(/data-testid="material-question-meta"/g)).toHaveLength(1);
    expect(html).not.toContain('补充材料');
    expect(html).toMatch(/<details class="disclosure tools" data-testid="material-tools"><summary>/);
    expect(html).not.toContain('class="btn primary"');
    expect(html).toContain('<h3>照片 1 · later label</h3>');
    expect(html).toContain('<span class="meta-line">正在整理</span>');
    expect(html).toContain('还没有可用于区分的题号或内容');
    expect(html).toContain('<summary>调整这页属于哪份试卷</summary>');
    expect(html).toContain('<summary>批量帮我批改</summary>');
    expect(html).toContain('<summary>批量参考答案</summary>');
    expect(html).toContain('1 张照片没整理成功，原图已保留。');
    expect(html).toContain('一键重新整理');
    expect(html).not.toContain('class="more"');
    expect(html).not.toContain('▶');
  });
});
