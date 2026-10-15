import type { ReactNode } from 'react';
import { Layout } from './layout.js';
import type { ItemRow } from '../services/itemService.js';
import type { EvidenceRecord } from '../services/evidenceService.js';
import { OBSERVATION_KINDS } from '../ai/evidence.js';
import { cropCheckHash } from '../ai/cropAuditor.js';

export const EVIDENCE_LABELS: Record<string, string> = { diagram: '题目图示', student_work: '学生原始作答', correction: '后续订正', teacher_note: '教师批注', reference_answer: '可见参考答案', unknown: '归属不确定' };
const AUDIT_LABELS: Record<string, string> = { completed: '调用及结构校验完成（不代表内容通过）', failed: '检查执行失败', not_checked: '未经检查',
  pass: '完整性通过（模型建议，待人工复核）', missing: '缺失内容', uncertain: '不确定', clean: '纯净', contaminated: '包含额外内容',
  match: '与原文一致', mismatch: '与原文不一致', not_applicable: '不适用', present: '完整可见' };

export function EvidencePage({ item, record, locked, error }: { item: ItemRow; record: EvidenceRecord; locked: boolean; error?: string }): ReactNode {
  const e = record.content;
  const questionAudit = record.cropAudit?.targets.find(t => t.kind === 'question');
  const requiredDiagrams = (questionAudit?.assessment?.inventory ?? questionAudit?.inventory)?.items.filter(i => i.category === 'diagram') ?? [];
  const selection = item.ai_suggestion ? (JSON.parse(item.ai_suggestion) as { selectionEvidence?: string }).selectionEvidence : null;
  return <Layout title="真实材料证据校对" role="student" flash={error ? { err: error } : undefined}>
    <h1>{item.short_id} · 真实材料证据校对</h1>
    <p>原题号 {e.questionNumber} · 版本 {record.revision} · {record.verified ? '已校对' : '待人工校对'}。AI 提取的是候选题，不代表该页每道题都是错题。</p>
    <p>选题依据：{({ marked_wrong: '可见判错标记', corrected: '可见订正', unmarked: '未见批改标记', unclear: '无法判断' } as Record<string, string>)[selection ?? 'unclear'] ?? '无法判断'}，需本人核对。</p>
    {!locked ? <form method="post" action={`/items/${item.id}/evidence/discard`}><button className="btn">这不是要收录的错题，排除此候选</button><span className="muted">不删除原始证据，不记为掌握。</span></form> : null}
    <p><a href={`/items/${item.id}`}>题目详情</a> · <a href={`/batches/${item.batch_id}/review`}>下一道待校对题</a> · <a href="/reflect">学生反思</a></p>
    {locked ? <p className="flash warn">已进入复习包，内容已锁定，避免与纸面版本不一致。</p> : null}
    <details open><summary>原始页面（判断依据，绝不作为整页打印题面）</summary>
      <img className="item-img" src={`/media/asset/${item.asset_id}`} alt="完整原始页面" />
    </details>
    <section className="card"><h2>裁图完整性与纯净度</h2>
      <p>调用成功 ≠ 题干完整。检查先从原图独立建立清单，再对照原图、上下文和实际裁图逐项核对。模型判断仍可能出错，不能替代人工确认。</p>
      <p className="muted">修改后先保存草稿再检查。每轮最多12个区域、24次模型调用，有未检查区域时再次点击会续查；无自动重试。扩大框只生成草稿，不自动放行或去除答案。</p>
      {!record.cropAudit ? <p className="flash warn">未经检查：不能确认或打印。旧的 succeeded 仅代表调用/结构成功，不能证明题干完整。</p> : record.cropAudit.targets.map(t => <details key={t.id} open={t.completeness !== 'pass'}>
        <summary>{t.id === 'question' ? '完整题目裁图' : t.id} · {AUDIT_LABELS[t.completeness]}</summary>
        <img className="item-img" style={{ maxHeight: 240, objectFit: 'contain' }} src={t.kind === 'question' ? `/items/${item.id}/evidence/question-crop?v=${record.revision}` : `/items/${item.id}/evidence/crop/${encodeURIComponent(t.id.slice(7))}?v=${record.revision}`} alt={`${t.id} 实际待检查裁图`} />
        <p>执行：{AUDIT_LABELS[t.technicalStatus]} · 纯净度：{AUDIT_LABELS[t.purity]} · 转写：{AUDIT_LABELS[t.textFidelity]}</p>
        {t.error ? <p className="flash warn">{t.error}</p> : null}
        {t.assessment ? <>
          <table><thead><tr><th>原图必需内容</th><th>裁图保留情况</th><th>具体依据</th></tr></thead><tbody>{t.assessment.inventory.items.map(i => {
            const c = t.assessment!.comparison.checks.find(c => c.id === i.id);
            return <tr key={i.id}><td>{i.description}</td><td>{AUDIT_LABELS[c?.visibility ?? 'uncertain']}</td><td>{c?.note}</td></tr>;
          })}</tbody></table>
          <p>{t.assessment.comparison.textNote}</p>
          {[...t.assessment.inventory.uncertainties, ...t.assessment.comparison.unexpectedMissing, ...t.assessment.comparison.uncertainties,
            ...t.assessment.comparison.purity.issues, ...t.assessment.warnings].map((s, i) => <p key={i} className="flash warn">{s}</p>)}
        </> : null}
        <p className="muted">{t.runs.map(r => `${r.stage}：${r.model}，${r.promptTokens ?? '?'} / ${r.completionTokens ?? '?'} tokens`).join('；')}</p>
        {record.cropAudit?.humanResolutions?.filter(h => h.targetId === t.id).map(h => <p key={h.targetId} className="flash ok">人工已逐项复核（保留模型原判定）：{h.notes} · {h.reviewedAt}</p>)}
        <form method="post" action={`/items/${item.id}/evidence/expand-crop`}>
          <input type="hidden" name="revision" value={record.revision} /><input type="hidden" name="target" value={t.id} />
          <button className="btn" disabled={locked}>扩大此框，保存为待复核草稿</button>
        </form>
        {t.kind === 'question' && !(t.assessment?.inventory ?? t.inventory) ? <p className="flash warn">整题原图清单尚未建立，不能用人工文字说明跳过必要图示检查，请重新运行检查。</p> : null}
        {t.technicalStatus !== 'not_checked' && (t.kind !== 'question' || (t.assessment?.inventory ?? t.inventory)) ? <details><summary>模型误报？人工逐项复核并记录依据</summary>
          <p>只在你已对照完整原图和上方实际裁图，确认模型误报时使用。不完整请先改框；不要靠推测补字。此操作保留模型结果，不代替最后的题目确认。</p>
          <form method="post" action={`/items/${item.id}/evidence/resolve-crop`} className="form">
            <fieldset disabled={locked}><legend>人工复核 {t.id}</legend>
              <input type="hidden" name="revision" value={record.revision} /><input type="hidden" name="target" value={t.id} />
              <input type="hidden" name="model_check_hash" value={cropCheckHash(t)} />
              <label>原图必须保留的具体内容（手填，每行一项）<textarea name="required_elements" rows={3} required /></label>
              <label>逐项核对依据，说明为什么模型误报（至少8字）<textarea name="notes" rows={3} minLength={8} maxLength={4000} required /></label>
              <label className="check"><input type="checkbox" name="source_compared" value="1" required />已同时核对完整原图与实际裁图</label>
              <label className="check"><input type="checkbox" name="complete" value="1" required />上列必需内容在实际裁图中全部完整可见</label>
              {t.expectedText ? <label className="check"><input type="checkbox" name="text_matches" value="1" required />转写忠于原图，没有缺字、错字或漏小问</label> : null}
              {t.kind !== 'question' ? <label className="check"><input type="checkbox" name="pure" value="1" required />图示无答案/提示，或本作答区域未混入订正及其他角色内容</label> : null}
              {t.kind === 'diagram' ? requiredDiagrams.map(d => <label className="check" key={d.id}><input type="checkbox" name="covered_diagram_ids" value={d.id} />此裁图完整覆盖：{d.description}</label>) : null}
              <button className="btn" type="submit">保存此区域的人工复核依据</button>
            </fieldset>
          </form>
        </details> : null}
      </details>)}
      <form method="post" action={`/items/${item.id}/evidence/check-crops`}>
        <input type="hidden" name="revision" value={record.revision} />
        <button className="btn" disabled={locked}>对已保存版本运行自动裁图检查（调用模型）</button>
      </form>
    </section>
    <form method="post" action={`/items/${item.id}/evidence`} className="form card">
      <input type="hidden" name="revision" value={record.revision} />
      <fieldset disabled={locked}>
        <legend>1. 完整题目</legend>
        <img className="item-img" src={`/items/${item.id}/evidence/question-crop?v=${record.revision}`} alt="实际整题裁图，必须保留完整题干、全部小问及必要图示" />
        <p className="muted">这张是审阅裁图，不是干净打印题面。请特别核对开头、每行末尾、换行公式和最后一问。</p>
        {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>整题框 {key}<input type="number" step="any" min="0" max="1" name={`question_${key}`} defaultValue={e.questionRegion[key]} required /></label>)}
        <label htmlFor="question_text">题干、选项及全部小问（去掉填空中的原作答）</label>
        <textarea id="question_text" name="question_text" rows={8} defaultValue={e.questionText} required />
        <label htmlFor="e_subject">学科</label><select id="e_subject" name="subject" defaultValue={e.subject}><option>数学</option><option>物理</option><option>化学</option></select>
        <label htmlFor="e_chapter">章节</label><input id="e_chapter" name="chapter" defaultValue={e.chapter} />
        <label htmlFor="e_tags">知识点（逗号分隔）</label><input id="e_tags" name="knowledge_tags" defaultValue={e.knowledgeTags.join('，')} />
        <label htmlFor="e_type">题型</label><input id="e_type" name="question_type" defaultValue={e.questionType} />
        <label className="check"><input type="checkbox" name="requires_diagram" value="1" defaultChecked={e.requiresDiagram} />必须有图才能完整作答</label>
      </fieldset>
      <fieldset disabled={locked}><legend>2. 图示和证据区域</legend>
        <p className="muted">坐标是相对于整张转正图片的比例，范围 0–1。修改后保存草稿可刷新预览。只有“题目图示”会进入打印页。</p>
        {e.regions.map((r, index) => <section className="card" key={r.id}>
          <strong>{r.id} · {EVIDENCE_LABELS[r.kind]}</strong>
          <img className="item-img" style={{ maxHeight: 300, objectFit: 'contain' }} src={`/items/${item.id}/evidence/crop/${encodeURIComponent(r.id)}?v=${record.revision}`} alt={`${EVIDENCE_LABELS[r.kind]} ${r.id}`} />
          <label>区域类型<select name={`region_kind_${index}`} defaultValue={r.kind}>{['diagram', ...OBSERVATION_KINDS].map(k => <option key={k} value={k}>{EVIDENCE_LABELS[k]}</option>)}</select></label>
          {(['x', 'y', 'width', 'height'] as const).map(key => <label key={key}>{key}<input type="number" step="any" min="0" max="1" name={`region_${key}_${index}`} defaultValue={r.box[key]} required /></label>)}
          {r.kind === 'diagram' ? <label className="check"><input type="checkbox" name={`region_clean_${index}`} value="1" defaultChecked={r.cleanForPrint} />已检查：图示完整，且不含学生答案/提示/批注</label> : null}
        </section>)}
        {!e.regions.length ? <p>尚无区域。需要补图时可使用下方高级编辑；缺少必要图示不能确认打印。</p> : null}
      </fieldset>
      <fieldset disabled={locked}><legend>3. 作答、订正与批注（事实，不是 AI 推断）</legend>
        {e.observations.map((o, index) => <section key={o.id} className="card">
          <strong id={`observation-${o.id}`}>{o.id} · {EVIDENCE_LABELS[o.kind]}</strong>
          <p className="muted">来源区域：{o.regionId ?? '待定位'} · 模型自报置信度 {Math.round(o.confidence * 100)}%</p>
          <label>归属<select name={`observation_kind_${index}`} defaultValue={o.kind}>{OBSERVATION_KINDS.map(k => <option key={k} value={k}>{EVIDENCE_LABELS[k]}</option>)}</select></label>
          <label>原图实际内容<textarea name={`observation_text_${index}`} rows={4} defaultValue={o.text} required /></label>
        </section>)}
        {!e.observations.length ? <p>没有提取到作答证据，诊断只能提出澄清问题，不能猜测学生错因。</p> : null}
        <label>尚未解决的不确定项（一行一条；确认后才能清空）<textarea name="uncertainties" rows={3} defaultValue={e.uncertainties.join('\n')} /></label>
      </fieldset>
      <details><summary>高级编辑：补充/删除区域、证据及题目范围</summary>
        <p className="muted">勾选后将使用下方完整 JSON，不使用上面的字段。用于补框和复杂关联，不要求学生日常填写。</p>
        <label className="check"><input type="checkbox" name="use_json" value="1" disabled={locked} />使用高级 JSON</label>
        <textarea name="evidence_json" rows={14} defaultValue={JSON.stringify(e, null, 2)} disabled={locked} />
      </details>
      <button className="btn" name="action" value="draft" disabled={locked}>保存草稿，刷新预览</button>{' '}
      <button className="btn primary" name="action" value="confirm" disabled={locked}>已核对完整题目、图示与作答归属，确认</button>
      <p className="muted">保存会使旧的 AI 诊断和提示失效；不会替你提交错因反思。</p>
    </form>
    <section className="card"><h2>4. 有证据的 AI 诊断</h2>
      {record.diagnosis ? <><p>{record.diagnosis.value.summary}</p>
        <p>候选错因：{record.diagnosis.value.possibleCause ?? '证据不足'}（不是学生已确认的错因）</p>
        <ul>{record.diagnosis.value.findings.map((f, i) => <li key={i}>{f.explanation} · 依据 {f.observationIds.join('、')}</li>)}</ul>
        <p>{record.diagnosis.value.clarificationQuestion}</p><p className="muted">模型：{record.diagnosis.run.model}</p></> : <p>尚未生成诊断。证据校对后主动点击生成，页面浏览不产生模型费用。</p>}
      <form method="post" action={`/items/${item.id}/evidence/diagnose`}><button className="btn" disabled={!record.verified || locked}>根据证据生成诊断</button></form>
    </section>
    <section className="card"><h2>5. 提示与参考解法</h2>
      {record.coaching ? <details><summary>AI 参考，未经教师核验（点击展开）</summary><ol>{record.coaching.value.hints.map((h, i) => <li key={i}>{h}</li>)}</ol><p style={{ whiteSpace: 'pre-wrap' }}>{record.coaching.value.solution}</p><p>{record.coaching.value.answer}</p></details> : <p>尚未生成。生成的解法与照片中出现的参考答案分开保存。</p>}
      <form method="post" action={`/items/${item.id}/evidence/coach`}><button className="btn" disabled={!record.diagnosis || locked}>生成分级提示与参考解法</button></form>
    </section>
  </Layout>;
}
