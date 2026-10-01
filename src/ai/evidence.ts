import { AiError } from './errors.js';
import { ATTEMPT_STATES, CAUSES, SUBJECTS, type AttemptState, type Cause, type Subject } from '../domain/types.js';
import { validateBox, type Box } from '../media/images.js';

export const STAGES = ['layout', 'transcribe', 'diagnose', 'coach', 'match', 'followup', 'correct'] as const;
export type Stage = typeof STAGES[number];
export const OBSERVATION_KINDS = ['student_work', 'teacher_note', 'correction', 'reference_answer', 'unknown'] as const;
export type ObservationKind = typeof OBSERVATION_KINDS[number];
export interface Region { id: string; kind: ObservationKind | 'diagram'; box: Box; confidence: number; cleanForPrint: boolean }
export interface Observation { id: string; kind: ObservationKind; text: string; regionId: string | null; confidence: number }
export interface Evidence {
  version: 1; questionNumber: string; questionText: string; subject: Subject; chapter: string;
  knowledgeTags: string[]; questionType: string; questionRegion: Box; requiresDiagram: boolean;
  regions: Region[]; observations: Observation[]; uncertainties: string[];
}
export interface QuestionRegion { questionNumber: string; box: Box; confidence: number; selectionEvidence: 'marked_wrong' | 'corrected' | 'unmarked' | 'unclear' }
export interface Diagnosis { summary: string; possibleCause: Cause | null; confidence: number; findings: Array<{ observationIds: string[]; explanation: string }>; clarificationQuestion: string | null }
export interface Coaching { hints: string[]; solution: string; answer: string; source: 'ai_generated' }

function bad(field: string): never { throw new AiError('invalid_json', `证据字段不合法：${field}`); }
function obj(x: unknown, field: string): Record<string, unknown> {
  if (!x || typeof x !== 'object' || Array.isArray(x)) bad(field);
  return x as Record<string, unknown>;
}
function str(x: unknown, field: string, empty = false): string {
  if (typeof x !== 'string' || x.length > 40000 || (!empty && !x.trim())) bad(field);
  return x;
}
function list(x: unknown, field: string, max = 100): unknown[] { if (!Array.isArray(x) || x.length > max) bad(field); return x; }
function strings(x: unknown, field: string): string[] { return list(x, field).map(v => str(v, field)); }
function confidence(x: unknown): number { if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) bad('confidence'); return x; }
function flag(x: unknown, field: string): boolean { if (typeof x !== 'boolean') bad(field); return x; }
function box(x: unknown): Box { try { return validateBox(x); } catch { return bad('box'); } }
function unique(ids: string[]): void { if (new Set(ids).size !== ids.length) bad('重复 ID'); }

export function validateLayout(data: unknown): { questions: QuestionRegion[] } {
  const questions = list(obj(data, 'layout').questions, 'questions', 30).map(raw => {
    const q = obj(raw, 'question');
    if (!['marked_wrong', 'corrected', 'unmarked', 'unclear'].includes(String(q.selectionEvidence))) bad('selectionEvidence');
    return { questionNumber: str(q.questionNumber, 'questionNumber'), box: box(q.box), confidence: confidence(q.confidence), selectionEvidence: q.selectionEvidence as QuestionRegion['selectionEvidence'] };
  });
  unique(questions.map(q => q.questionNumber));
  return { questions };
}

export function validateEvidence(data: unknown): Evidence {
  const e = obj(data, 'evidence');
  if (e.version !== 1 || !SUBJECTS.includes(e.subject as Subject)) bad('version/subject');
  const regions = list(e.regions, 'regions').map(raw => {
    const r = obj(raw, 'region');
    if (![...OBSERVATION_KINDS, 'diagram'].includes(r.kind as Region['kind'])) bad('region.kind');
    return { id: str(r.id, 'region.id'), kind: r.kind as Region['kind'], box: box(r.box), confidence: confidence(r.confidence), cleanForPrint: flag(r.cleanForPrint, 'cleanForPrint') };
  });
  unique(regions.map(r => r.id));
  const observations = list(e.observations, 'observations').map(raw => {
    const o = obj(raw, 'observation');
    if (!OBSERVATION_KINDS.includes(o.kind as ObservationKind)) bad('observation.kind');
    const regionId = o.regionId === null ? null : str(o.regionId, 'regionId');
    if (regionId !== null && !regions.some(r => r.id === regionId && r.kind === o.kind)) bad('observation.regionId');
    return { id: str(o.id, 'observation.id'), kind: o.kind as ObservationKind, text: str(o.text, 'observation.text'), regionId, confidence: confidence(o.confidence) };
  });
  unique(observations.map(o => o.id));
  return {
    version: 1, questionNumber: str(e.questionNumber, 'questionNumber'), questionText: str(e.questionText, 'questionText'),
    subject: e.subject as Subject, chapter: str(e.chapter, 'chapter', true), knowledgeTags: strings(e.knowledgeTags, 'knowledgeTags'), questionType: str(e.questionType, 'questionType', true),
    questionRegion: box(e.questionRegion), requiresDiagram: flag(e.requiresDiagram, 'requiresDiagram'), regions, observations, uncertainties: strings(e.uncertainties, 'uncertainties'),
  };
}

export function assertPrintable(e: Evidence, verified: boolean): void {
  if (!verified) throw new Error('真实题必须先校对确认');
  if (!e.questionText.trim() || e.uncertainties.length > 0) throw new Error('请先解决题目识别的不确定项');
  const diagrams = e.regions.filter(r => r.kind === 'diagram');
  if ((e.requiresDiagram && !diagrams.length) || diagrams.some(r => !r.cleanForPrint)) throw new Error('请确认必要图示完整且不含答案');
}

export function validateDiagnosis(data: unknown, evidence: Evidence): Diagnosis {
  const d = obj(data, 'diagnosis');
  if (d.possibleCause !== null && !CAUSES.includes(d.possibleCause as Cause)) bad('possibleCause');
  const findings = list(d.findings, 'findings', 20).map(raw => {
    const f = obj(raw, 'finding'); const ids = strings(f.observationIds, 'observationIds');
    if (!ids.length || ids.some(id => !evidence.observations.some(o => o.id === id))) bad('诊断引用');
    return { observationIds: ids, explanation: str(f.explanation, 'explanation') };
  });
  if (d.possibleCause !== null && !findings.some(f => f.observationIds.some(id => evidence.observations.some(o => o.id === id && o.kind === 'student_work')))) bad('错因缺少学生作答证据');
  const clarificationQuestion = d.clarificationQuestion === null ? null : str(d.clarificationQuestion, 'clarificationQuestion');
  if (d.possibleCause === null && !clarificationQuestion) bad('证据不足时应提出澄清问题');
  return { summary: str(d.summary, 'summary'), possibleCause: d.possibleCause as Cause | null, confidence: confidence(d.confidence), findings, clarificationQuestion };
}

export function validateCoaching(data: unknown): Coaching {
  const c = obj(data, 'coaching'); const hints = strings(c.hints, 'hints');
  if (!hints.length || hints.length > 3) bad('hints');
  return { hints, solution: str(c.solution, 'solution'), answer: str(c.answer, 'answer'), source: 'ai_generated' };
}

// ---------- v2.0 T4c：AI 追问与复盘（followup 阶段） ----------

/** 证据里没有学生作答/订正时的固定开放句（不调模型）。 */
export const FOLLOWUP_FALLBACK_QUESTION = '这题你当时卡在哪一步？';
export const FOLLOWUP_MAX_CHARS = 60;

export interface FollowupAsk { question: string; referencedObservationIds: string[] }
export interface FollowupSummarize { summary: string; suggestedCause: Cause; suggestedAttemptState: AttemptState; secondQuestion: string | null }

/** 恰好一个问句（中英文问号合计 1 个）。 */
function singleQuestion(text: string, field: string): void {
  if ((text.match(/[？?]/g) ?? []).length !== 1) bad(field);
}

export function validateFollowupAsk(data: unknown, evidence: Evidence): FollowupAsk {
  const d = obj(data, 'followupAsk');
  const question = str(d.question, 'question');
  if (question.length > FOLLOWUP_MAX_CHARS) bad('question 超长');
  singleQuestion(question, 'question 须恰好一个问句');
  const ids = strings(d.referencedObservationIds, 'referencedObservationIds');
  if (!ids.length) bad('追问必须引用学生作答或订正');
  if (ids.some(id => !evidence.observations.some(o => o.id === id))) bad('追问引用了不存在的观察记录');
  // 产品规则 3：追问必须基于学生自己写过的东西，只引批注/参考答案不算。
  if (!ids.some(id => evidence.observations.some(o => o.id === id && (o.kind === 'student_work' || o.kind === 'correction')))) {
    bad('追问必须引用学生作答或订正');
  }
  return { question, referencedObservationIds: ids };
}

export function validateFollowupSummarize(data: unknown): FollowupSummarize {
  const d = obj(data, 'followupSummarize');
  if (!CAUSES.includes(d.suggestedCause as Cause)) bad('suggestedCause');
  if (!ATTEMPT_STATES.includes(d.suggestedAttemptState as AttemptState)) bad('suggestedAttemptState');
  const summary = str(d.summary, 'summary');
  if (summary.length > FOLLOWUP_MAX_CHARS) bad('summary 超长');
  const secondQuestion = d.secondQuestion === null ? null : str(d.secondQuestion, 'secondQuestion');
  if (secondQuestion !== null) {
    if (secondQuestion.length > FOLLOWUP_MAX_CHARS) bad('secondQuestion 超长');
    singleQuestion(secondQuestion, 'secondQuestion 须恰好一个问句');
  }
  return { summary, suggestedCause: d.suggestedCause as Cause, suggestedAttemptState: d.suggestedAttemptState as AttemptState, secondQuestion };
}

// ---------- v2.0 T4e：识别结果修订（correct 阶段） ----------

export const CORRECTION_FIELDS = ['questionText', 'observation', 'subject', 'knowledgeTags'] as const;
export type CorrectionField = typeof CORRECTION_FIELDS[number];
/** 一条"改前/改后"修改建议；field=observation 时必须带 observationId。find/replace 为模型给出的片段（供界面高亮）。 */
export interface CorrectionChange { field: CorrectionField; observationId?: string; before: string; after: string; find?: string; replace?: string }
/** 被剔除/拒绝的单条修改及原因（给学生看的说明，不写日志）。 */
export interface RejectedChange { change: CorrectionChange; reason: string }
export interface CorrectionProposalResult { changes: CorrectionChange[]; rejected: RejectedChange[]; clarify: string | null }

/** 规则 3：student_work 单条修改的改动字符数上限（且不超过原文 50%）。 */
export const STUDENT_WORK_MAX_EDIT_CHARS = 20;
export const STUDENT_WORK_MAX_EDIT_RATIO = 0.5;

/** 编辑距离（Levenshtein），只关心是否超过 cap：超过返回 cap+1。公共前后缀剥离 + 带状 DP。 */
export function editDistanceCapped(a: string, b: string, cap: number): number {
  if (cap < 0) return 1;
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const s = a.slice(start, endA);
  const t = b.slice(start, endB);
  if (s.length === 0) return t.length;
  if (t.length === 0) return s.length;
  const INF = cap + 1;
  let prev: number[] = new Array(t.length + 1).fill(INF);
  for (let j = 0; j <= Math.min(cap, t.length); j++) prev[j] = j;
  for (let i = 1; i <= s.length; i++) {
    const cur: number[] = new Array(t.length + 1).fill(INF);
    if (i <= cap) cur[0] = i;
    let rowMin = cur[0]!;
    const from = Math.max(1, i - cap);
    const to = Math.min(t.length, i + cap);
    for (let j = from; j <= to; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j]! + cost, prev[j - 1]! + 1, cur[j - 1]! + 1);
      if (cur[j]! < rowMin) rowMin = cur[j]!;
    }
    if (rowMin > cap) return INF;
    prev = cur;
  }
  return prev[t.length]!;
}

const CORRECTION_FIELD_LABEL: Record<CorrectionField, string> = {
  questionText: '题干', observation: '作答/批注转写', subject: '学科', knowledgeTags: '知识点',
};

/**
 * 校验一组修改建议：硬性问题（字段枚举、observationId 缺失或不存在、after 与 before 相同、
 * subject 枚举外、knowledgeTags 形状非法、同字段重复）抛 AiError；软性问题（before 与当前值不符、
 * 规则 3 改动量超限）剔除该条并给出原因。只对转写保真与分类，不碰坐标/区域/题号。
 */
export function validateCorrectionChanges(data: unknown, evidence: Evidence): { changes: CorrectionChange[]; rejected: RejectedChange[] } {
  const entries = list(data, 'changes', 20);
  const changes: CorrectionChange[] = [];
  const rejected: RejectedChange[] = [];
  const seen = new Set<string>();
  for (const raw of entries) {
    const c = obj(raw, 'change');
    if (!CORRECTION_FIELDS.includes(c.field as CorrectionField)) bad('correction.field');
    const field = c.field as CorrectionField;
    const before = str(c.before, 'correction.before', true);
    const after = str(c.after, 'correction.after', true);
    if (after === before) bad('correction.after 与 before 相同');
    if (!after.trim()) bad('correction.after 不能为空');
    let observationId: string | undefined;
    let observation: Observation | undefined;
    if (field === 'observation') {
      if (c.observationId === undefined || c.observationId === null) bad('observation 修改必须带 observationId');
      observationId = str(c.observationId, 'correction.observationId');
      observation = evidence.observations.find(o => o.id === observationId);
      if (!observation) bad('correction.observationId 不存在');
    }
    if (field === 'subject' && !SUBJECTS.includes(after as Subject)) bad('correction.subject 枚举外');
    if (field === 'knowledgeTags') {
      let tags: unknown;
      try { tags = JSON.parse(after); } catch { bad('correction.knowledgeTags 不是 JSON 数组'); }
      const parsed = strings(tags, 'correction.knowledgeTags');
      if (parsed.length < 1 || parsed.length > 5) bad('correction.knowledgeTags 须 1–5 个');
    }
    const key = observationId ? `${field}:${observationId}` : field;
    if (seen.has(key)) bad('同一字段只能修改一次');
    seen.add(key);
    const change: CorrectionChange = {
      field, ...(observationId ? { observationId } : {}), before, after,
      ...(typeof c.find === 'string' ? { find: c.find } : {}),
      ...(typeof c.replace === 'string' ? { replace: c.replace } : {}),
    };

    // 软校验：before 必须与当前值完全一致（knowledgeTags 用 JSON 数组字符串比较）。
    const current = field === 'questionText' ? evidence.questionText
      : field === 'subject' ? evidence.subject
        : field === 'knowledgeTags' ? JSON.stringify(evidence.knowledgeTags)
          : observation!.text;
    if (before !== current) {
      rejected.push({ change, reason: `${CORRECTION_FIELD_LABEL[field]}的改前内容与当前识别结果不一致，已略过该条修改` });
      continue;
    }
    // 规则 3：不许把学生原作的错误"改对"——只允许小幅转写纠错。
    if (field === 'observation' && observation!.kind === 'student_work') {
      const cap = Math.min(STUDENT_WORK_MAX_EDIT_CHARS, Math.floor(before.length * STUDENT_WORK_MAX_EDIT_RATIO));
      if (editDistanceCapped(before, after, cap) > cap) {
        rejected.push({ change, reason: '对学生原作的修改超过允许幅度，已拒绝：只能把识别错的字改回纸上实际写的' });
        continue;
      }
    }
    changes.push(change);
  }
  return { changes, rejected };
}

/**
 * 校验模型修订包（T4e-R1）：文字类字段（questionText/observation）模型只给 { field, observationId?, find, replace }
 * 片段——find 须非空且在当前文字中恰好出现一次（0 次或多次都剔除该条并提示"请说得更具体"），
 * 服务器据此生成完整 before/after；subject/knowledgeTags 仍用完整 before/after。
 * changes 为空（原始输出层面）时必须有 clarify 反问。
 */
export function validateCorrectionProposal(data: unknown, evidence: Evidence): CorrectionProposalResult {
  const d = obj(data, 'correctionProposal');
  const clarify = d.clarify === null || d.clarify === undefined ? null : str(d.clarify, 'clarify');
  if (clarify !== null && clarify.length > 200) bad('clarify 超长');
  const entries = list(d.changes, 'changes', 20);
  if (entries.length === 0 && !clarify) bad('没有修改建议时须给出反问');

  const resolved: unknown[] = [];
  const rejected: RejectedChange[] = [];
  for (const raw of entries) {
    const c = obj(raw, 'change');
    if (!CORRECTION_FIELDS.includes(c.field as CorrectionField)) bad('correction.field');
    const field = c.field as CorrectionField;
    // subject/knowledgeTags 值很短，模型仍给完整 before/after。
    if (field === 'subject' || field === 'knowledgeTags') { resolved.push(raw); continue; }
    let observationId: string | undefined;
    if (field === 'observation') {
      if (c.observationId === undefined || c.observationId === null) bad('observation 修改必须带 observationId');
      observationId = str(c.observationId, 'correction.observationId');
      if (!evidence.observations.some(o => o.id === observationId)) bad('correction.observationId 不存在');
    }
    // 只给需要替换的片段，不复述全文。
    const find = str(c.find, 'correction.find');
    const replace = str(c.replace, 'correction.replace', true);
    if (replace === find) bad('correction.replace 与 find 相同');
    const current = field === 'questionText' ? evidence.questionText
      : evidence.observations.find(o => o.id === observationId)!.text;
    const parts = current.split(find);
    if (parts.length !== 2) {
      const reason = parts.length === 1
        ? `${CORRECTION_FIELD_LABEL[field]}找不到要修改的原文片段，已略过该条修改：请说得更具体`
        : `${CORRECTION_FIELD_LABEL[field]}要修改的原文片段出现多次，已略过该条修改：请说得更具体`;
      rejected.push({ change: { field, ...(observationId ? { observationId } : {}), before: current, after: current, find, replace }, reason });
      continue;
    }
    resolved.push({ field, ...(observationId ? { observationId } : {}), before: current, after: parts.join(replace), find, replace });
  }
  const validated = validateCorrectionChanges(resolved, evidence);
  return { changes: validated.changes, rejected: [...rejected, ...validated.rejected], clarify };
}
