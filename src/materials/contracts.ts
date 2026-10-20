import type { Box } from '../media/images.js';
import type { StageRun } from '../ai/chatClient.js';
export type MaterialRole = 'question' | 'diagram' | 'student_work' | 'correction'
  | 'teacher_mark' | 'reference_answer' | 'unknown';
export type CaptureHints = {
  roles?: MaterialRole[]; marking?: 'unmarked' | 'marked' | 'partial';
  label?: string; documentId?: string; questionId?: string; attemptId?: string;
};
export type SourceRegion = { assetId: string; fragmentId: string; revision: number; box: Box; sourceHash: string };
export type Fragment = SourceRegion & {
  role: MaterialRole; text: string; number: string | null; subpart: string | null;
  page: number | null; order: number; requiresDiagram: boolean;
  check: 'passed' | 'low' | 'failed' | 'unchecked'; uncertainties: string[];
};
export type DocumentClues = { title: string | null; subject: string | null;
  date: string | null; printedCode: string | null; page: number | null };
export type Extraction = { assetId: string; revision: number; document: DocumentClues;
  fragments: Fragment[]; warnings: string[]; runs: StageRun[] };
export type MaterialJobKind = 'extract' | 'answer' | 'grade';
export type JobTicket = { id: string; kind: MaterialJobKind;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted' | 'stale' };
export type ReferenceAnswer = {
  id: string; questionId: string; subpart: string | null; revision: number;
  source: 'imported' | 'manual' | 'ai'; text: string; claimedSource: string | null;
  fragmentIds: string[]; basisKey: string; stale: boolean; run: StageRun | null;
};
export type Grade = { id: string; attemptId: string; answerIds: string[]; basisKey: string;
  result: 'correct' | 'partial' | 'incorrect' | 'uncertain';
  findings: { fragmentIds: string[]; text: string }[];
  score: { earned: number; total: number; rubricFragmentIds: string[] } | null;
  stale: boolean; run: StageRun };
export type QuestionBundle = {
  id: string; documentId: string | null; revision: number; basisKey: string;
  number: string | null; subject: string | null; tags: string[];
  stem: Fragment[]; attempts: { id: string; revision: number; fragments: Fragment[] }[];
  teacherMarks: Fragment[]; answers: ReferenceAnswer[]; grades: Grade[];
  missing: ('stem' | 'diagram' | 'work')[]; unresolved: string[];
  answerConflict: boolean; itemId: string | null;
};
export type LinkTarget = { questionId: string; attemptId: string | null };
export type LinkChange = { id: string; questionId: string; revision: number };
export type BatchRequest = { requestId: string; questionIds: string[]; documentId?: never }
  | { requestId: string; documentId: string; questionIds?: never };
export type BatchAction = { jobs: JobTicket[]; skipped: { questionId: string; reason: string }[] };
