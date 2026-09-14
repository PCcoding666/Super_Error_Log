import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import sharp from 'sharp';
import { afterEach, describe, expect, it } from 'vitest';
import { PROMPT_VERSION, type StageResult } from '../../src/ai/chatClient.js';
import type { MatchInput, MatchResult } from '../../src/ai/provider.js';
import { MODEL_CATALOG, estimateReservationCny } from '../../src/evaluation/catalog.js';
import {
  runEvaluation,
  validateManifest,
  type EvaluationManifest,
  type EvaluationResult,
  type EvaluationStageProvider,
} from '../../src/evaluation/runner.js';
import { scoreEvaluation, type HumanScoreCard } from '../../src/evaluation/scoring.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-evaluation-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function jpegFile(directory: string): Promise<string> {
  const sourcePath = path.join(directory, 'page.png');
  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#ffffff' } }).png().toBuffer();
  fs.writeFileSync(sourcePath, png);
  return sourcePath;
}

function rawManifest(sourcePath?: string): Record<string, unknown> {
  return {
    version: 1,
    region: 'beijing',
    budgetCny: 10,
    maxCalls: 2,
    candidateModels: ['qwen3.8-flash'],
    cases: [{
      id: 'layout-1',
      stage: 'layout',
      sourcePath,
      groundTruth: { reviewed: true, notes: 'Human checked that this page contains one complete question.' },
    }],
  };
}

function fakeRun(stage: EvaluationResult['stage'], model: string): StageResult<unknown> {
  return {
    value: { questions: [] },
    run: {
      stage,
      model,
      durationMs: 25,
      promptTokens: 100,
      completionTokens: 20,
      maxTokens: 8192,
      thinking: false,
      promptVersion: PROMPT_VERSION,
    },
  };
}

describe('evaluation manifest safety gates', () => {
  it('rejects cases whose ground truth has not been human reviewed', () => {
    const raw = rawManifest('/tmp/page.jpg');
    (raw.cases as Array<Record<string, unknown>>)[0]!.groundTruth = { reviewed: false, notes: 'not checked' };
    expect(() => validateManifest(raw)).toThrow(/reviewed/i);
  });

  it.each([
    ['budgetCny', 0],
    ['budgetCny', Number.NaN],
    ['maxCalls', 0],
    ['maxCalls', 1.5],
  ])('rejects invalid live cap %s=%s', (field, value) => {
    const raw = rawManifest('/tmp/page.jpg');
    raw[field] = value;
    expect(() => validateManifest(raw)).toThrow(new RegExp(field, 'i'));
  });

  it('uses the verified regional rate and fixed token ceilings for reservations', () => {
    expect(MODEL_CATALOG['qwen3.8-flash'].rates.singapore).toEqual({ inputCnyPerMillion: 1.094, outputCnyPerMillion: 3.427 });
    expect(estimateReservationCny('qwen3.8-flash', 'singapore')).toBeCloseTo(0.137473984, 10);
  });

  it('CLI defaults to an offline dry-run and does not require a secret', async () => {
    const directory = temporaryDirectory();
    const manifestPath = path.join(directory, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(rawManifest('/local/reviewed-page.jpg')));
    const env = { ...process.env };
    delete env.SEL_AI_API_KEY;
    delete env.DASHSCOPE_API_KEY;
    delete env.SEL_AI_BASE_URL;
    const output = execFileSync(process.execPath, ['--import', 'tsx', 'src/cli/evaluate.ts', manifestPath, path.join(directory, 'out')], {
      cwd: path.resolve('.'), env, encoding: 'utf8',
    });
    expect(JSON.parse(output)).toMatchObject({ mode: 'DRY_RUN', plannedCalls: 1 });
    expect(fs.existsSync(path.join(directory, 'out'))).toBe(false);
  });
});

describe('bounded real-model runner', () => {
  it('rejects missing live configuration before constructing or invoking a provider', async () => {
    const directory = temporaryDirectory();
    const sourcePath = await jpegFile(directory);
    const manifest = validateManifest(rawManifest(sourcePath));
    let constructed = 0;
    await expect(runEvaluation(manifest, path.join(directory, 'out'), {
      baseUrl: '',
      apiKey: '',
      providerFactory: () => { constructed += 1; throw new Error('must not construct'); },
    })).rejects.toThrow(/apiKey|baseUrl/i);
    expect(constructed).toBe(0);
  });

  it('stops before a call whose conservative reservation would exceed the budget', async () => {
    const directory = temporaryDirectory();
    const sourcePath = await jpegFile(directory);
    const reservation = estimateReservationCny('qwen3.8-flash', 'beijing');
    const manifest = validateManifest({
      ...rawManifest(sourcePath),
      budgetCny: reservation + 0.000001,
      maxCalls: 5,
      cases: [
        (rawManifest(sourcePath).cases as unknown[])[0],
        { id: 'layout-2', stage: 'layout', sourcePath, groundTruth: { reviewed: true, notes: 'Checked independently.' } },
      ],
    });
    let calls = 0;
    const providerFactory = (model: string): EvaluationStageProvider => ({
      layout: async () => { calls += 1; return fakeRun('layout', model) as StageResult<{ questions: [] }>; },
    });
    const summary = await runEvaluation(manifest, path.join(directory, 'out'), {
      apiKey: 'local-test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      providerFactory,
    });
    expect(calls).toBe(1);
    expect(summary).toMatchObject({ attemptedCalls: 1, completedResults: 1, stoppedReason: 'budget_exhausted' });
  });

  it('does not retry failures and resumes only an identical experiment identity', async () => {
    const directory = temporaryDirectory();
    const sourcePath = await jpegFile(directory);
    const outputDirectory = path.join(directory, 'out');
    const manifest = validateManifest(rawManifest(sourcePath));
    let calls = 0;
    const providerFactory = (): EvaluationStageProvider => ({
      layout: async () => { calls += 1; throw new Error('secret=do-not-persist'); },
    });
    const options = {
      apiKey: 'do-not-persist',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      providerFactory,
    };
    const first = await runEvaluation(manifest, outputDirectory, options);
    expect(first).toMatchObject({ attemptedCalls: 1, failedResults: 1 });
    expect(calls).toBe(1);
    const persisted = fs.readFileSync(first.resultPaths[0]!, 'utf8');
    expect(JSON.parse(persisted)).toMatchObject({
      candidateModels: ['qwen3.8-flash'],
      stageCaseIds: ['layout-1'],
      modelSource: {
        sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',
        verifiedDate: '2026-09-07',
      },
    });
    expect(persisted).not.toContain('secret=do-not-persist');
    expect(persisted).not.toContain('do-not-persist');

    const resumed = await runEvaluation(manifest, outputDirectory, options);
    expect(resumed).toMatchObject({ attemptedCalls: 1, resumedResults: 1, failedResults: 1 });
    expect(calls).toBe(1);

    const changed = validateManifest({ ...rawManifest(sourcePath), budgetCny: 11 });
    await expect(runEvaluation(changed, outputDirectory, options)).rejects.toThrow(/identity|experiment/i);
    expect(calls).toBe(1);
  });

  it('passes the normalized local image through the match stage boundary', async () => {
    const directory = temporaryDirectory();
    const sourcePath = await jpegFile(directory);
    const manifest = validateManifest({
      ...rawManifest(sourcePath),
      cases: [{ id: 'match-1', stage: 'match', sourcePath, candidateShortIds: ['AB12'], groundTruth: { reviewed: true, notes: 'The visible identifier is AB12.' } }],
    });
    let seen: MatchInput | undefined;
    const summary = await runEvaluation(manifest, path.join(directory, 'out'), {
      apiKey: 'local-test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      providerFactory: (model): EvaluationStageProvider => ({
        match: async input => {
          seen = input;
          return { ...fakeRun('match', model), value: { shortId: 'AB12', confidence: 0.9 } } as StageResult<MatchResult>;
        },
      }),
    });
    expect(summary.completedResults).toBe(1);
    expect(seen?.candidateShortIds).toEqual(['AB12']);
    expect(seen?.imagePath.endsWith('.jpg')).toBe(true);
    expect(seen?.contentHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reuses one normalized temporary image when different source paths have identical bytes', async () => {
    const directory = temporaryDirectory();
    const firstPath = await jpegFile(directory);
    const secondPath = path.join(directory, 'same-image-copy.png');
    fs.copyFileSync(firstPath, secondPath);
    const manifest = validateManifest({
      ...rawManifest(firstPath),
      maxCalls: 2,
      cases: [
        { id: 'layout-a', stage: 'layout', sourcePath: firstPath, groundTruth: { reviewed: true, notes: 'Reviewed A.' } },
        { id: 'layout-b', stage: 'layout', sourcePath: secondPath, groundTruth: { reviewed: true, notes: 'Reviewed B.' } },
      ],
    });
    let calls = 0;
    const summary = await runEvaluation(manifest, path.join(directory, 'out'), {
      apiKey: 'local-test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      providerFactory: model => ({ layout: async () => { calls += 1; return fakeRun('layout', model) as StageResult<{ questions: [] }>; } }),
    });
    expect(summary.completedResults).toBe(2);
    expect(calls).toBe(2);
  });

  it('report CLI refuses a manifest that is not the output experiment manifest', async () => {
    const directory = temporaryDirectory();
    const sourcePath = await jpegFile(directory);
    const outputDirectory = path.join(directory, 'out');
    const original = rawManifest(sourcePath);
    await runEvaluation(validateManifest(original), outputDirectory, {
      apiKey: 'local-test-key',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      providerFactory: model => ({ layout: async () => fakeRun('layout', model) as StageResult<{ questions: [] }> }),
    });
    const changedManifestPath = path.join(directory, 'changed-manifest.json');
    fs.writeFileSync(changedManifestPath, JSON.stringify({ ...original, budgetCny: 11 }));
    const command = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/evaluate.ts', changedManifestPath, outputDirectory, '--report'], {
      cwd: path.resolve('.'), encoding: 'utf8',
    });
    expect(command.status).not.toBe(0);
    expect(command.stderr).toMatch(/manifest|experiment|identity/i);
  });
});

function result(overrides: Partial<EvaluationResult>): EvaluationResult {
  const base: EvaluationResult = {
    version: 1,
    mode: 'REAL_MODEL_EVALUATION',
    resultId: 'result-a',
    resultHash: 'hash-a',
    experimentIdentity: 'experiment',
    caseId: 'case-1',
    stage: 'diagnose',
    model: 'qwen3.8-flash',
    candidateModels: ['qwen3.8-flash', 'qwen3.8-max-0902'],
    stageCaseIds: ['case-1'],
    region: 'beijing',
    rates: { inputCnyPerMillion: 0.8, outputCnyPerMillion: 2.7 },
    settings: { temperature: 0, maxOutputTokens: 8192, inputTokenCeiling: 100000, thinking: false },
    modelSource: { sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash', verifiedDate: '2026-09-07' },
    promptVersion: PROMPT_VERSION,
    stageInputHash: 'input-hash',
    fileHash: null,
    reservationCny: 0.1021184,
    status: 'succeeded',
    value: { summary: 'x' },
    run: { stage: 'diagnose', model: 'qwen3.8-flash', durationMs: 25, promptTokens: 100, completionTokens: 20, maxTokens: 8192, thinking: false, promptVersion: PROMPT_VERSION },
    error: null,
    estimatedActualCostCny: 0.000134,
    chargedCostCny: 0.000134,
    createdAt: '2026-09-07T00:00:00.000Z',
    completedAt: '2026-09-07T00:00:01.000Z',
  };
  return { ...base, ...overrides };
}

function card(evaluationResult: EvaluationResult, quality: number, criticalErrors = 0): HumanScoreCard {
  return { version: 1, resultId: evaluationResult.resultId, resultHash: evaluationResult.resultHash!, quality, criticalErrors, reviewedBy: 'teacher-1', notes: 'Reviewed against the source and human ground truth.' };
}

describe('human score aggregation', () => {
  it('counts failed results as zero in the denominator without requiring a score card', () => {
    const stageCaseIds = ['case-1', 'case-2'];
    const success = result({ resultId: 'flash-ok', resultHash: 'flash-ok-hash', stageCaseIds });
    const failure = result({ resultId: 'flash-fail', resultHash: 'flash-fail-hash', caseId: 'case-2', stageCaseIds, status: 'failed', value: null, run: null, error: { kind: 'provider_error', message: 'Stage evaluation failed' }, estimatedActualCostCny: null, chargedCostCny: 0.1021184 });
    const peer1 = result({ resultId: 'max-1', resultHash: 'max-1-hash', model: 'qwen3.8-max-0902', stageCaseIds });
    const peer2 = result({ resultId: 'max-2', resultHash: 'max-2-hash', model: 'qwen3.8-max-0902', caseId: 'case-2', stageCaseIds });
    const summary = scoreEvaluation([success, failure, peer1, peer2], [card(success, 80), card(peer1, 60), card(peer2, 70)]);
    expect(summary.stages.diagnose.status).toBe('ranked');
    expect(summary.stages.diagnose.candidates['qwen3.8-flash']).toMatchObject({ averageQuality: 40, failureCount: 1, caseCount: 2 });
    expect(summary.stages.diagnose.winners).toEqual(['qwen3.8-max-0902']);
  });

  it('awaits review when candidates do not have identical case sets', () => {
    const flash = result({ resultId: 'flash', resultHash: 'flash-hash' });
    const max = result({ resultId: 'max', resultHash: 'max-hash', model: 'qwen3.8-max-0902', caseId: 'case-2' });
    const summary = scoreEvaluation([flash, max], [card(flash, 90), card(max, 90)]);
    expect(summary.stages.diagnose).toMatchObject({ status: 'awaiting_review', winners: [] });
    expect(summary.stages.diagnose.reasons).toContain('mismatched_case_sets');
  });

  it('does not rank when an expected candidate has no result at all', () => {
    const flash = result({ resultId: 'flash', resultHash: 'flash-hash' });
    const summary = scoreEvaluation([flash], [card(flash, 90)]);
    expect(summary.stages.diagnose).toMatchObject({ status: 'awaiting_review', winners: [] });
    expect(summary.stages.diagnose.reasons).toContain('mismatched_case_sets');
  });

  it('keeps equal eligible top scores as a tie and excludes critical-error candidates', () => {
    const flash = result({ resultId: 'flash', resultHash: 'flash-hash' });
    const max = result({ resultId: 'max', resultHash: 'max-hash', model: 'qwen3.8-max-0902' });
    const standard = result({ resultId: 'standard', resultHash: 'standard-hash', model: 'qwen3.8-27b' });
    const tied = scoreEvaluation([flash, max], [card(flash, 88), card(max, 88)]);
    expect(tied.stages.diagnose.winners).toEqual(['qwen3.8-flash', 'qwen3.8-max-0902']);

    const critical = scoreEvaluation([flash, max, standard], [card(flash, 99, 1), card(max, 88), card(standard, 88)]);
    expect(critical.stages.diagnose.winners).toEqual(['qwen3.8-27b', 'qwen3.8-max-0902']);
    expect(critical.scope).toMatch(/dataset.*settings/i);
  });

  it('reports not_run when no result exists', () => {
    expect(scoreEvaluation([], []).stages.layout).toMatchObject({ status: 'not_run', winners: [] });
  });

  it('does not invent a winner when every attempt failed without human-reviewed success', () => {
    const flash = result({ resultId: 'flash-failed', resultHash: 'flash-failed-hash', status: 'failed', value: null, run: null, error: { kind: 'provider_error', message: 'Stage evaluation failed' }, estimatedActualCostCny: null });
    const max = result({ resultId: 'max-failed', resultHash: 'max-failed-hash', model: 'qwen3.8-max-0902', status: 'failed', value: null, run: null, error: { kind: 'provider_error', message: 'Stage evaluation failed' }, estimatedActualCostCny: null });
    const summary = scoreEvaluation([flash, max], []);
    expect(summary.stages.diagnose).toMatchObject({ status: 'awaiting_review', winners: [] });
    expect(summary.stages.diagnose.reasons).toContain('no_successful_reviewed_results');
  });

  it('does not let a zero-success candidate tie a reviewed successful candidate at quality zero', () => {
    const failed = result({ resultId: 'flash-failed', resultHash: 'flash-failed-hash', status: 'failed', value: null, run: null, error: { kind: 'provider_error', message: 'Stage evaluation failed' }, estimatedActualCostCny: null });
    const success = result({ resultId: 'max-success', resultHash: 'max-success-hash', model: 'qwen3.8-max-0902' });
    const summary = scoreEvaluation([failed, success], [card(success, 0)]);
    expect(summary.stages.diagnose.status).toBe('ranked');
    expect(summary.stages.diagnose.winners).toEqual(['qwen3.8-max-0902']);
  });

  it.each([
    ['experiment identity', { experimentIdentity: 'another-experiment' }, 'mismatched_experiment_identity'],
    ['stage input hash', { stageInputHash: 'another-stage-input' }, 'mismatched_stage_inputs'],
    ['region', { region: 'singapore' as const }, 'mismatched_run_configuration'],
    ['prompt version', { promptVersion: 'another-prompt-version' }, 'mismatched_run_configuration'],
    ['settings', { settings: { temperature: 1, maxOutputTokens: 8192, inputTokenCeiling: 100000, thinking: false } as unknown as EvaluationResult['settings'] }, 'mismatched_run_configuration'],
  ])('refuses to rank same case IDs with mismatched %s', (_label, changed, reason) => {
    const flash = result({ resultId: 'flash', resultHash: 'flash-hash' });
    const max = result({ resultId: 'max', resultHash: 'max-hash', model: 'qwen3.8-max-0902', ...changed });
    const summary = scoreEvaluation([flash, max], [card(flash, 80), card(max, 90)]);
    expect(summary.stages.diagnose).toMatchObject({ status: 'awaiting_review', winners: [] });
    expect(summary.stages.diagnose.reasons).toContain(reason);
  });
});
