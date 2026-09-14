import { AiError } from './errors.js';
import { CAUSES, SUBJECTS, type Cause, type Subject } from '../domain/types.js';
import { validateBox, type Box } from '../media/images.js';

export const STAGES = ['layout', 'transcribe', 'diagnose', 'coach', 'match'] as const;
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
