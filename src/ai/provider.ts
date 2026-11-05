import type { LearningContext } from '../learning/contracts.js';
import type { AttemptState, Cause, ReviewValue, Subject } from '../domain/types.js';
import type { Coaching, Diagnosis, Evidence, FollowupAsk, FollowupSummarize, Insight, AnswerReading, QuestionRegion, CorrectionProposalResult } from './evidence.js';
import type { StageResult, StageRun } from './chatClient.js';
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

// ---------- v2.0 T4c：AI 追问与复盘 ----------

/** 一轮已回答的追问（学生原话只用于模型归纳，不落日志）。 */
export interface FollowupTurn { question: string; answer: string }

/**
 * 追问/归纳能力。StagedProvider 与 MockAiProvider 实现。
 * AI 只提问和归纳：不讲题、不给答案、不替学生写复盘。
 */
export interface FollowupProvider {
  followupAsk(evidence: LearningContext): Promise<FollowupAsk>;
  followupSummarize(evidence: LearningContext, turns: FollowupTurn[]): Promise<FollowupSummarize>;
}

// ---------- v2.0 T4e：识别结果修订 ----------

/**
 * 修订建议能力。StagedProvider 与 MockAiProvider 实现。
 * AI 只提出"改前/改后"建议——不直接改证据，接受与否由学生决定。
 */
export interface CorrectionProvider {
  proposeCorrection(evidence: LearningContext, instruction: string): Promise<CorrectionProposalResult>;
}

// ---------- v2.0 T5：打印快照辅导 ----------

/**
 * 打印快照的提示/答案能力（T5）。诊断对象由服务器按规则合成（复盘错因或 null），
 * 不满足 validateDiagnosis 的 findings 不变量，因此实现方不得再校验诊断。
 * 每份练习包每题至多调用 1 次，不重试；失败由调用方留空处理。
 */
export interface CoachProvider {
  coachForPrint(evidence: LearningContext, diagnosis: Diagnosis): Promise<Coaching>;
}

// ---------- 学生端详情页：答案、解题过程与推测错因 ----------

/**
 * 详情页的 AI 参考解答与推测错因（explain 阶段）、拍照答案转写（answer_read 阶段）。StagedProvider 与 MockAiProvider 实现。
 * 只读题目识别结果和照片，不改证据、不写反思；结果由 insightService 在后台生成、按题目内容缓存。
 */
export interface InsightProvider {
  explainItem(request: InsightRequest): Promise<StageResult<Insight>>;
  readAnswerPhoto(request: AnswerPhotoRequest): Promise<StageResult<AnswerReading>>;
}

/** images：题目照片（旧流程整题图或材料裁图，JPEG）；providedAnswers：学生拍照录入的答案转写；background：后台任务，排在前台请求之后。 */
export interface InsightRequest { context: LearningContext; images: Buffer[]; providedAnswers: string[]; background: boolean }
export interface AnswerPhotoRequest { context: LearningContext; photo: Buffer; background: boolean }
