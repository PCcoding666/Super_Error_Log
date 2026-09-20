import type { AttemptState, Cause, ReviewValue, Subject } from '../domain/types.js';
import type { Evidence, QuestionRegion } from './evidence.js';
import type { StageRun } from './chatClient.js';
import type { CropAuditReport } from './cropAuditor.js';

export interface ExtractInput {
  assetId: string;
  filename: string;
  mime: string;
  storagePath: string;
  contentHash: string;
}

export interface ExtractedItem {
  cropAudit?: CropAuditReport;
  evidence?: Evidence;
  evidenceRuns?: StageRun[];
  selectionEvidence?: QuestionRegion['selectionEvidence'];
  itemIndex: number;
  textExcerpt: string;
  subject?: Subject;
  chapter?: string;
  knowledgeTags: string[];
  questionType?: string;
  hasTeacherNote: boolean;
  hasAnswer: boolean;
  confidence: number;
  fieldConfidence: Record<string, number>;
}

export interface ExtractResult {
  items: ExtractedItem[];
}

export interface SuggestInput {
  itemId: string;
  textExcerpt: string;
  subject?: string;
}

export interface FieldSuggestion {
  subject?: { value: Subject; confidence: number };
  knowledgeTags?: { value: string[]; confidence: number };
  questionType?: { value: string; confidence: number };
  /** 做题状态建议（供反思一键采纳）；掌握感永远不建议——那是学生的校准信号 */
  attemptState?: { value: AttemptState; confidence: number };
  possibleCause?: { value: Cause; confidence: number };
  reviewValue?: { value: ReviewValue; confidence: number };
}

export interface MatchInput {
  /** 服务器上的真实文件路径（视觉模型读取用） */
  imagePath: string;
  /** 客户端原始文件名（启发式/mock 匹配用） */
  originalName: string;
  contentHash: string;
  candidateShortIds: string[];
}

export interface MatchResult {
  shortId: string | null;
  confidence: number;
}

export interface AiProvider {
  readonly name: string;
  extractItems(input: ExtractInput): Promise<ExtractResult>;
  suggestFields(input: SuggestInput): Promise<FieldSuggestion>;
  matchReturnSheet(input: MatchInput): Promise<MatchResult>;
}

export const LOW_CONFIDENCE_THRESHOLD = 0.8;
export const FIELD_CONFIDENCE_THRESHOLD = 0.6;
