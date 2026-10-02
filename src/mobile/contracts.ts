import type { Evidence } from '../ai/evidence.js';
import type { Box } from '../media/images.js';

export const MOBILE_CONTRACT_VERSION = 1 as const;

export type RecognitionJobStatus = 'queued' | 'processing' | 'completed' | 'partial' | 'failed' | 'interrupted';
export type RecognitionPhase = 'inventory' | 'questions' | 'complete';
export type RecognitionQuestionStatus = 'queued' | 'processing' | 'needs_check' | 'ready' | 'failed' | 'confirmed' | 'skipped' | 'unselected';
export type SelectionEvidence = 'marked_wrong' | 'corrected' | 'unmarked' | 'unclear';

export interface RecognitionFailure {
  code: string;
  message: string;
  stage: string;
  retryable: boolean;
  recoverable?: boolean;
}

// Explicit endpoint eligibility, never the adapter's automatic retry policy.
export function canRecover(failure: RecognitionFailure | null | undefined): boolean {
  if (!failure) return false;
  if (['internal', 'storage_unavailable', 'invalid_image'].includes(failure.code)) return false;
  const modelStage = ['inventory', 'transcribe', 'verify', 'ground'].includes(failure.stage);
  // Older schema failures recorded the invalid field instead of the enclosing model stage.
  const legacySchemaField = ['verification', 'textComplete', 'questionCropComplete', 'questionCropPure', 'transcriptionMatches', 'diagramSafe', 'issues', 'candidates', 'capacityReached', 'partial', 'warning', 'warnings', 'selectionEvidence', 'number', 'confidence'].includes(failure.stage)
    || /^candidate\[\d+\]$/.test(failure.stage);
  return failure.retryable || ['attempt_budget_unknown', 'attempt_budget_exhausted'].includes(failure.code) || (modelStage && ['invalid_output', 'output_truncated', 'authentication', 'permission', 'unsupported'].includes(failure.code))
    || (failure.code === 'invalid_output' && legacySchemaField);
}

export interface RecognitionVerification {
  textComplete: boolean;
  questionCropComplete: boolean;
  questionCropPure: boolean;
  transcriptionMatches: boolean;
  diagramSafe: boolean;
  issues: string[];
}

export interface RecognitionStageCheckpoint {
  evidence: Evidence;
  verification: RecognitionVerification | null;
  nextStage: 'verify' | 'ground' | 'complete';
  groundingPasses: number;
}

export interface RecognitionQuestion {
  id: string;
  number: string;
  revision: number;
  status: RecognitionQuestionStatus;
  selectionEvidence: SelectionEvidence;
  candidateBox?: Box;
  evidence: Evidence | null;
  verification: RecognitionVerification | null;
  questionMediaId: string | null;
  diagramMediaIds: string[];
  error: RecognitionFailure | null;
  confirmedAt: string | null;
  /** 人工放行标记：needs_check 时学生对照原图后主动确认（AI 未通过完整性核对）。 */
  manualRelease?: boolean;
  /** v2.1a：学生勾入标记——该题由 unselected 经 /select 进入精读（与批改痕迹自动题之后一视同仁）。 */
  selectedByStudent?: true;
}

export interface RecognitionJob {
  version: 1;
  id: string;
  revision: number;
  photoName: string;
  sourceHash: string;
  sourceMediaId: string;
  status: RecognitionJobStatus;
  phase: RecognitionPhase;
  inventoryWarnings: string[];
  questions: RecognitionQuestion[];
  error: RecognitionFailure | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredRecognitionJob extends RecognitionJob {
  /** Missing on legacy data: automatic work must not invent a fresh budget. */
  attemptBudgets?: Record<string, { currentRoundId: string; rounds: RecognitionAttemptRound[] }>;
  idempotencyKey: string;
  transformedHash: string;
  media: Record<string, { filename: string; kind: 'source' | 'question' | 'diagram' }>;
  inventoryCandidates: Record<string, { number: string; box: Box; confidence?: number; selectionEvidence: SelectionEvidence; partial: boolean; warning?: string }>;
  questionCheckpoints: Record<string, RecognitionStageCheckpoint>;
}

export interface RecognitionAttemptRound {
  id: string;
  reservations: Array<{ id: string; stage: 'inventory' | 'transcribe' | 'verify' | 'ground'; reservedAt: string }>;
  retryCount: number;
  retryNotBefore: number | null;
}

export function publicJob(job: StoredRecognitionJob | RecognitionJob): RecognitionJob {
  const value = structuredClone(job) as RecognitionJob & Partial<StoredRecognitionJob>;
  if (value.error) value.error.recoverable = canRecover(value.error);
  for (const question of value.questions) {
    if (question.error) question.error.recoverable = canRecover(question.error);
    const candidate = value.inventoryCandidates?.[question.id];
    if (candidate) question.candidateBox = structuredClone(candidate.box);
  }
  delete value.idempotencyKey;
  delete value.transformedHash;
  delete value.media;
  delete value.inventoryCandidates;
  delete value.questionCheckpoints;
  delete value.attemptBudgets;
  return value;
}
