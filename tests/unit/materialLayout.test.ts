import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { QuestionBundle } from '../../src/materials/contracts.js';
import { STYLES } from '../../src/web/assets.js';
import { MaterialCapturePage, MaterialsPage, type MaterialAssetView } from '../../src/web/views/materials.js';

const question = (number: string | null, id = 'q1'): QuestionBundle => ({
  id, documentId: null, revision: 1, basisKey: 'basis', number, subject: null, tags: [],
  stem: [], attempts: [], teacherMarks: [], answers: [], grades: [],
  missing: [], unresolved: [], answerConflict: false, itemId: null,
});

const asset = (label?: string): MaterialAssetView => ({
  id: 'asset-1', hints: label ? { label } : {}, document_id: null, status: 'ready', link_revision: 1, fragments: [],
});

describe('学习材料界面', () => {
  it('拍学习材料把主次按钮叠放留白，下一屏和提示不再是裸文字', () => {
    const html = renderToStaticMarkup(MaterialCapturePage({ namespace: 'ns', count: 6, uploadId: '11111111-1111-4111-8111-111111111111' }));
    expect(html).toContain('class="btn-stack"');
    expect(html).toContain('class="btn primary"');
    expect(html).toMatch(/class="btn"[^>]*>从相册选（可多选）/);
    expect(html).toContain('class="nav-row" href="/s/materials"');
    expect(html).toContain('查看已经保存的材料');
    expect(html).toContain('<details class="disclosure"><summary>加个提示（可跳过）</summary>');
    expect(html).not.toContain('class="more"');
    expect(STYLES).toContain('.material-surface .btn-stack{display:flex;flex-direction:column;align-items:stretch;gap:var(--s-3)');
    expect(STYLES).toContain('.material-surface .btn-stack>.btn{width:100%;flex:none}');
  });

  it('我的材料用分组列表、节标题和披露行保留原文', () => {
    const html = renderToStaticMarkup(MaterialsPage({
      namespace: 'ns',
      questions: [question('1'), question(null, 'q2')],
      assets: [asset('later label')],
      page: 0,
      hasMore: false,
      documents: [],
      changes: [],
      jobs: [{ id: 'job-1', state: 'failed' }],
      revision: 1,
    }));
    expect(html).toContain('class="group-label"');
    expect(html).toContain('原图和整页归属');
    expect(html).toContain('只有需要调整时才选；一次调整整页，不必逐题确认。');
    expect(html).toContain('按题整理，缺的材料以后再补。没有把握的关联会留在“待确定”。');
    expect(html).toContain('href="/s/materials/questions/q1"');
    expect(html).toContain('第 1 题');
    expect(html).toContain('待确定题号');
    expect(html).toContain('补充材料');
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
