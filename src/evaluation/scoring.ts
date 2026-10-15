import { STAGES, type Stage } from '../ai/evidence.js';
import type { CatalogModelId } from './catalog.js';
import type { EvaluationResult } from './runner.js';

export interface HumanScoreCard {
  version: 1;
  resultId: string;
  resultHash: string;
  quality: number;
  criticalErrors: number;
  reviewedBy: string;
  notes: string;
}

export interface CandidateScore {
  caseCount: number;
  averageQuality: number | null;
  failureCount: number;
  criticalErrorCount: number;
  totalDurationMs: number;
  promptTokens: number | null;
  completionTokens: number | null;
  estimatedActualCostCny: number | null;
  chargedCostCny: number;
}

export interface StageScore {
  status: 'not_run' | 'awaiting_review' | 'ranked';
  winners: CatalogModelId[];
  reasons: string[];
  candidates: Partial<Record<CatalogModelId, CandidateScore>>;
}

export interface EvaluationScoreSummary {
  mode: 'REAL_MODEL_EVALUATION';
  scope: string;
  stages: Record<Stage, StageScore>;
}

function nonempty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be nonempty`);
  return value.trim();
}

export function validateScoreCards(value: unknown): HumanScoreCard[] {
  if (!Array.isArray(value)) throw new Error('score cards must be an array');
  const cards = value.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`scoreCards[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    if (raw.version !== 1) throw new Error(`scoreCards[${index}].version must be 1`);
    if (typeof raw.quality !== 'number' || !Number.isFinite(raw.quality) || raw.quality < 0 || raw.quality > 100) throw new Error(`scoreCards[${index}].quality must be between 0 and 100`);
    if (typeof raw.criticalErrors !== 'number' || !Number.isSafeInteger(raw.criticalErrors) || raw.criticalErrors < 0) throw new Error(`scoreCards[${index}].criticalErrors must be a nonnegative integer`);
    return {
      version: 1 as const,
      resultId: nonempty(raw.resultId, `scoreCards[${index}].resultId`),
      resultHash: nonempty(raw.resultHash, `scoreCards[${index}].resultHash`),
      quality: raw.quality,
      criticalErrors: raw.criticalErrors,
      reviewedBy: nonempty(raw.reviewedBy, `scoreCards[${index}].reviewedBy`),
      notes: nonempty(raw.notes, `scoreCards[${index}].notes`),
    };
  });
  if (new Set(cards.map(card => card.resultId)).size !== cards.length) throw new Error('score cards must have unique resultId values');
  return cards;
}

function sumKnown(values: Array<number | null>): number | null {
  return values.every(value => value !== null) ? values.reduce<number>((total, value) => total + value!, 0) : null;
}

function emptyStage(): StageScore {
  return { status: 'not_run', winners: [], reasons: [], candidates: {} };
}

export function scoreEvaluation(results: EvaluationResult[], scoreCardsValue: HumanScoreCard[] | unknown): EvaluationScoreSummary {
  const scoreCards = validateScoreCards(scoreCardsValue);
  const resultIds = new Set(results.map(result => result.resultId));
  for (const card of scoreCards) {
    const matching = results.find(result => result.resultId === card.resultId);
    if (!matching) continue;
    if (matching.resultHash !== card.resultHash) throw new Error(`score card resultHash mismatch for ${card.resultId}`);
  }
  const cardsByResult = new Map(scoreCards.filter(card => resultIds.has(card.resultId)).map(card => [card.resultId, card]));
  const stages = Object.fromEntries(STAGES.map(stage => [stage, emptyStage()])) as Record<Stage, StageScore>;

  for (const stage of STAGES) {
    const stageResults = results.filter(result => result.stage === stage);
    if (stageResults.length === 0) continue;
    const byModel = new Map<CatalogModelId, EvaluationResult[]>();
    for (const result of stageResults) {
      const entries = byModel.get(result.model) ?? [];
      entries.push(result);
      byModel.set(result.model, entries);
    }
    const candidates: Partial<Record<CatalogModelId, CandidateScore>> = {};
    const reasons = new Set<string>();
    const expectedModels = new Set(stageResults.flatMap(result => result.candidateModels));
    const expectedCases = new Set(stageResults.flatMap(result => result.stageCaseIds));
    const caseSets = [...byModel.values()].map(entries => entries.map(result => result.caseId).sort().join('\u0000'));
    const expectedCaseKey = [...expectedCases].sort().join('\u0000');
    if ([...expectedModels].some(model => !byModel.has(model))
      || caseSets.some(caseSet => caseSet !== expectedCaseKey)) reasons.add('mismatched_case_sets');
    if (new Set(stageResults.map(result => result.experimentIdentity)).size > 1) reasons.add('mismatched_experiment_identity');
    const inputHashesByCase = new Map<string, Set<string>>();
    for (const result of stageResults) {
      const hashes = inputHashesByCase.get(result.caseId) ?? new Set<string>();
      hashes.add(result.stageInputHash);
      inputHashesByCase.set(result.caseId, hashes);
    }
    if ([...inputHashesByCase.values()].some(hashes => hashes.size > 1)) reasons.add('mismatched_stage_inputs');
    const runConfigurations = new Set(stageResults.map(result => JSON.stringify({
      region: result.region,
      promptVersion: result.promptVersion,
      settings: result.settings,
    })));
    if (runConfigurations.size > 1) reasons.add('mismatched_run_configuration');
    if (stageResults.some(result => result.status === 'reserved')) reasons.add('incomplete_reserved_attempts');
    if (stageResults.some(result => result.status === 'succeeded' && !cardsByResult.has(result.resultId))) reasons.add('missing_score_cards');
    if (!stageResults.some(result => result.status === 'succeeded' && cardsByResult.has(result.resultId))) reasons.add('no_successful_reviewed_results');

    for (const [model, entries] of byModel) {
      const scoreable = entries.every(result => result.status === 'failed' || (result.status === 'succeeded' && cardsByResult.has(result.resultId)));
      const qualityTotal = scoreable
        ? entries.reduce((total, result) => total + (result.status === 'succeeded' ? cardsByResult.get(result.resultId)!.quality : 0), 0)
        : null;
      candidates[model] = {
        caseCount: entries.length,
        averageQuality: qualityTotal === null ? null : qualityTotal / entries.length,
        failureCount: entries.filter(result => result.status === 'failed').length,
        criticalErrorCount: entries.reduce((total, result) => total + (result.status === 'succeeded' ? (cardsByResult.get(result.resultId)?.criticalErrors ?? 0) : 0), 0),
        totalDurationMs: entries.reduce((total, result) => total + (result.run?.durationMs ?? 0), 0),
        promptTokens: sumKnown(entries.map(result => result.run?.promptTokens ?? null)),
        completionTokens: sumKnown(entries.map(result => result.run?.completionTokens ?? null)),
        estimatedActualCostCny: sumKnown(entries.map(result => result.estimatedActualCostCny)),
        chargedCostCny: entries.reduce((total, result) => total + result.chargedCostCny, 0),
      };
    }

    if (reasons.size > 0) {
      stages[stage] = { status: 'awaiting_review', winners: [], reasons: [...reasons].sort(), candidates };
      continue;
    }
    const eligible = Object.entries(candidates)
      .filter(([model, score]) => score.criticalErrorCount === 0 && score.averageQuality !== null
        && byModel.get(model as CatalogModelId)!.some(result => result.status === 'succeeded' && cardsByResult.has(result.resultId)))
      .map(([model, score]) => ({ model: model as CatalogModelId, quality: score.averageQuality! }));
    const top = eligible.length ? Math.max(...eligible.map(entry => entry.quality)) : null;
    const winners = top === null ? [] : eligible.filter(entry => entry.quality === top).map(entry => entry.model).sort();
    stages[stage] = { status: 'ranked', winners, reasons: [], candidates };
  }

  return {
    mode: 'REAL_MODEL_EVALUATION',
    scope: 'Comparison applies only to this reviewed dataset, manifest region, prompt version, and recorded model settings.',
    stages,
  };
}
