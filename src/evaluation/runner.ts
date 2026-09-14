import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AiError } from '../ai/errors.js';
import { ChatClient, PROMPT_VERSION, type StageResult, type StageRun } from '../ai/chatClient.js';
import {
  STAGES,
  validateDiagnosis,
  validateEvidence,
  validateLayout,
  type Coaching,
  type Diagnosis,
  type Evidence,
  type QuestionRegion,
  type Stage,
} from '../ai/evidence.js';
import type { ExtractInput, MatchInput, MatchResult } from '../ai/provider.js';
import { StagedProvider } from '../ai/stagedProvider.js';
import { normalizePhoto } from '../media/images.js';
import {
  EVALUATION_REGIONS,
  EVALUATION_SETTINGS,
  MODEL_CATALOG,
  estimateActualCostCny,
  estimateReservationCny,
  isCatalogModel,
  type CatalogModelId,
  type EvaluationRegion,
  type TokenRates,
} from './catalog.js';

export interface EvaluationGroundTruth {
  reviewed: true;
  notes: string;
}

export interface EvaluationCase {
  id: string;
  stage: Stage;
  sourcePath?: string;
  region?: QuestionRegion;
  evidence?: Evidence;
  diagnosis?: Diagnosis;
  candidateShortIds?: string[];
  groundTruth: EvaluationGroundTruth;
}

export interface EvaluationManifest {
  version: 1;
  region: EvaluationRegion;
  budgetCny?: number;
  maxCalls?: number;
  candidateModels: CatalogModelId[];
  cases: EvaluationCase[];
}

export interface EvaluationStageProvider {
  layout?(input: ExtractInput): Promise<StageResult<{ questions: QuestionRegion[] }>>;
  transcribe?(input: ExtractInput, region: QuestionRegion): Promise<StageResult<Evidence>>;
  diagnose?(evidence: Evidence, input?: ExtractInput): Promise<StageResult<Diagnosis>>;
  coach?(evidence: Evidence, diagnosis: Diagnosis, input?: ExtractInput): Promise<StageResult<Coaching>>;
  match?(input: MatchInput): Promise<StageResult<MatchResult>>;
}

export interface EvaluationResult {
  version: 1;
  mode: 'REAL_MODEL_EVALUATION';
  resultId: string;
  resultHash: string | null;
  experimentIdentity: string;
  caseId: string;
  stage: Stage;
  model: CatalogModelId;
  candidateModels: CatalogModelId[];
  stageCaseIds: string[];
  region: EvaluationRegion;
  rates: TokenRates;
  settings: typeof EVALUATION_SETTINGS;
  modelSource: { sourceUrl: string; verifiedDate: string };
  promptVersion: string;
  stageInputHash: string;
  fileHash: string | null;
  reservationCny: number;
  status: 'reserved' | 'succeeded' | 'failed';
  value: unknown | null;
  run: StageRun | null;
  error: { kind: string; message: 'Stage evaluation failed' } | null;
  estimatedActualCostCny: number | null;
  chargedCostCny: number;
  createdAt: string;
  completedAt: string | null;
}

export interface EvaluationRunSummary {
  experimentIdentity: string;
  attemptedCalls: number;
  resumedResults: number;
  completedResults: number;
  failedResults: number;
  reservedResults: number;
  chargedCostCny: number;
  stoppedReason: 'budget_exhausted' | 'max_calls_reached' | null;
  resultPaths: string[];
}

export interface EvaluationRunnerOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  providerFactory?: (model: CatalogModelId, client: ChatClient) => EvaluationStageProvider;
}

interface PreparedSource {
  input: ExtractInput;
  temporaryPath: string;
  fileHash: string;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function nonemptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a nonempty string`);
  return value.trim();
}

function optionalPositiveFinite(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`${field} must be positive and finite`);
  return value;
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
  return value;
}

function uniqueNonemptyStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a nonempty array`);
  const values = value.map((item, index) => nonemptyString(item, `${field}[${index}]`));
  if (new Set(values).size !== values.length) throw new Error(`${field} must not contain duplicates`);
  return values;
}

function questionRegion(value: unknown, field: string): QuestionRegion {
  try {
    return validateLayout({ questions: [value] }).questions[0]!;
  } catch {
    throw new Error(`${field} must be a valid QuestionRegion`);
  }
}

function evidence(value: unknown, field: string): Evidence {
  try { return validateEvidence(value); } catch { throw new Error(`${field} must be valid Evidence`); }
}

function diagnosis(value: unknown, sourceEvidence: Evidence, field: string): Diagnosis {
  try { return validateDiagnosis(value, sourceEvidence); } catch { throw new Error(`${field} must be valid Diagnosis`); }
}

function validatedCase(value: unknown, index: number): EvaluationCase {
  const raw = record(value, `cases[${index}]`);
  const id = nonemptyString(raw.id, `cases[${index}].id`);
  if (!STAGES.includes(raw.stage as Stage)) throw new Error(`cases[${index}].stage is invalid`);
  const stage = raw.stage as Stage;
  const truth = record(raw.groundTruth, `cases[${index}].groundTruth`);
  if (truth.reviewed !== true) throw new Error(`cases[${index}].groundTruth.reviewed must be true`);
  const groundTruth = { reviewed: true as const, notes: nonemptyString(truth.notes, `cases[${index}].groundTruth.notes`) };
  const sourcePath = raw.sourcePath === undefined ? undefined : path.resolve(nonemptyString(raw.sourcePath, `cases[${index}].sourcePath`));
  let region: QuestionRegion | undefined;
  let checkedEvidence: Evidence | undefined;
  let checkedDiagnosis: Diagnosis | undefined;
  let candidateShortIds: string[] | undefined;

  if (stage === 'layout' && !sourcePath) throw new Error(`cases[${index}].sourcePath is required for layout`);
  if (stage === 'transcribe') {
    if (!sourcePath) throw new Error(`cases[${index}].sourcePath is required for transcribe`);
    region = questionRegion(raw.region, `cases[${index}].region`);
  }
  if (stage === 'diagnose' || stage === 'coach') {
    checkedEvidence = evidence(raw.evidence, `cases[${index}].evidence`);
  }
  if (stage === 'coach') checkedDiagnosis = diagnosis(raw.diagnosis, checkedEvidence!, `cases[${index}].diagnosis`);
  if (stage === 'match') {
    if (!sourcePath) throw new Error(`cases[${index}].sourcePath is required for match`);
    candidateShortIds = uniqueNonemptyStrings(raw.candidateShortIds, `cases[${index}].candidateShortIds`);
  }
  return { id, stage, sourcePath, region, evidence: checkedEvidence, diagnosis: checkedDiagnosis, candidateShortIds, groundTruth };
}

export function validateManifest(value: unknown): EvaluationManifest {
  const raw = record(value, 'manifest');
  if (raw.version !== 1) throw new Error('manifest.version must be 1');
  if (!EVALUATION_REGIONS.includes(raw.region as EvaluationRegion)) throw new Error('manifest.region must be beijing or singapore');
  const candidateNames = uniqueNonemptyStrings(raw.candidateModels, 'candidateModels');
  if (candidateNames.some(model => !isCatalogModel(model))) throw new Error('candidateModels must be a subset of the verified multimodal catalog');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) throw new Error('cases must be a nonempty array');
  const cases = raw.cases.map(validatedCase);
  if (new Set(cases.map(item => item.id)).size !== cases.length) throw new Error('case ids must be unique');
  return {
    version: 1,
    region: raw.region as EvaluationRegion,
    budgetCny: optionalPositiveFinite(raw.budgetCny, 'budgetCny'),
    maxCalls: optionalPositiveInteger(raw.maxCalls, 'maxCalls'),
    candidateModels: candidateNames as CatalogModelId[],
    cases,
  };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function writeJsonAtomically(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function resultHash(result: EvaluationResult): string {
  return hash(stableJson({ ...result, resultHash: null }));
}

function safeResultPath(resultsDirectory: string, item: EvaluationCase, model: CatalogModelId): string {
  const slug = item.id.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80) || 'case';
  return path.join(resultsDirectory, `${slug}-${hash(item.id).slice(0, 10)}--${model}.json`);
}

function assertLiveConfiguration(manifest: EvaluationManifest, options: EvaluationRunnerOptions): { apiKey: string; baseUrl: string } {
  const apiKey = options.apiKey ?? process.env.SEL_AI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '';
  const baseUrl = options.baseUrl ?? process.env.SEL_AI_BASE_URL ?? '';
  if (!apiKey.trim()) throw new Error('apiKey is required for live evaluation');
  if (!baseUrl.trim()) throw new Error('baseUrl is required for live evaluation');
  if (manifest.budgetCny === undefined) throw new Error('budgetCny is required for live evaluation');
  if (manifest.maxCalls === undefined) throw new Error('maxCalls is required for live evaluation');
  assertRegionalEndpoint(baseUrl, manifest.region);
  return { apiKey, baseUrl };
}

export function assertRegionalEndpoint(baseUrl: string, region: EvaluationRegion): void {
  let endpoint: URL;
  try { endpoint = new URL(baseUrl); } catch { throw new Error('baseUrl must be a valid Bailian URL'); }
  const expectedHost = region === 'beijing' ? 'dashscope.aliyuncs.com' : 'dashscope-intl.aliyuncs.com';
  const pathname = endpoint.pathname.replace(/\/$/, '');
  if (endpoint.protocol !== 'https:' || endpoint.hostname !== expectedHost || pathname !== '/compatible-mode/v1'
    || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error(`baseUrl does not match the official ${region} Bailian endpoint`);
  }
}

async function prepareSources(manifest: EvaluationManifest, directory: string): Promise<Map<string, PreparedSource>> {
  const sources = new Map<string, PreparedSource>();
  for (const item of manifest.cases) {
    if (!item.sourcePath || sources.has(item.sourcePath)) continue;
    let source: Buffer;
    try { source = fs.readFileSync(item.sourcePath); } catch { throw new Error(`sourcePath is not readable for case ${item.id}`); }
    let normalized: Buffer;
    try { normalized = await normalizePhoto(source); } catch { throw new Error(`sourcePath is not a normalizable image for case ${item.id}`); }
    const fileHash = hash(normalized);
    const temporaryPath = path.join(directory, `${fileHash}.jpg`);
    if (!fs.existsSync(temporaryPath)) fs.writeFileSync(temporaryPath, normalized, { flag: 'wx', mode: 0o600 });
    sources.set(item.sourcePath, {
      fileHash,
      temporaryPath,
      input: { assetId: `evaluation-${fileHash.slice(0, 16)}`, filename: path.basename(item.sourcePath), mime: 'image/jpeg', storagePath: temporaryPath, contentHash: fileHash },
    });
  }
  return sources;
}

function stageInput(item: EvaluationCase, source: PreparedSource | undefined): unknown {
  return {
    stage: item.stage,
    region: item.region,
    evidence: item.evidence,
    diagnosis: item.diagnosis,
    candidateShortIds: item.candidateShortIds,
    fileHash: source?.fileHash ?? null,
  };
}

async function invokeStage(provider: EvaluationStageProvider, item: EvaluationCase, source: PreparedSource | undefined): Promise<StageResult<unknown>> {
  if (item.stage === 'layout' && provider.layout && source) return provider.layout(source.input);
  if (item.stage === 'transcribe' && provider.transcribe && source && item.region) return provider.transcribe(source.input, item.region);
  if (item.stage === 'diagnose' && provider.diagnose && item.evidence) return provider.diagnose(item.evidence, source?.input);
  if (item.stage === 'coach' && provider.coach && item.evidence && item.diagnosis) return provider.coach(item.evidence, item.diagnosis, source?.input);
  if (item.stage === 'match' && provider.match && source && item.candidateShortIds) {
    return provider.match({ imagePath: source.temporaryPath, originalName: path.basename(item.sourcePath!), contentHash: source.fileHash, candidateShortIds: item.candidateShortIds });
  }
  throw new Error(`Stage boundary unavailable for ${item.stage}`);
}

function sanitizeError(error: unknown): EvaluationResult['error'] {
  const kind = error instanceof AiError ? error.kind : 'unexpected_error';
  return { kind, message: 'Stage evaluation failed' };
}

function readResult(filePath: string): EvaluationResult {
  const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as EvaluationResult;
  if (!value || value.mode !== 'REAL_MODEL_EVALUATION' || typeof value.resultId !== 'string') throw new Error(`Invalid existing evaluation result: ${filePath}`);
  if (value.resultHash !== null && resultHash(value) !== value.resultHash) throw new Error(`Existing evaluation result hash mismatch: ${filePath}`);
  return value;
}

function summarize(experimentIdentity: string, results: Array<{ value: EvaluationResult; path: string }>, resumedResults: number, stoppedReason: EvaluationRunSummary['stoppedReason']): EvaluationRunSummary {
  return {
    experimentIdentity,
    attemptedCalls: results.length,
    resumedResults,
    completedResults: results.filter(entry => entry.value.status === 'succeeded').length,
    failedResults: results.filter(entry => entry.value.status === 'failed').length,
    reservedResults: results.filter(entry => entry.value.status === 'reserved').length,
    chargedCostCny: results.reduce((total, entry) => total + entry.value.chargedCostCny, 0),
    stoppedReason,
    resultPaths: results.map(entry => entry.path),
  };
}

export async function runEvaluation(manifestValue: EvaluationManifest | unknown, outputDirectory: string, options: EvaluationRunnerOptions = {}): Promise<EvaluationRunSummary> {
  const manifest = validateManifest(manifestValue);
  const { apiKey, baseUrl } = assertLiveConfiguration(manifest, options);
  const absoluteOutput = path.resolve(outputDirectory);
  fs.mkdirSync(absoluteOutput, { recursive: true });
  const lockPath = path.join(absoluteOutput, '.evaluation.lock');
  let lock: number;
  try { lock = fs.openSync(lockPath, 'wx', 0o600); } catch { throw new Error('An evaluation run is already active for this output directory'); }
  const normalizedDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-evaluation-'));
  try {
    const prepared = await prepareSources(manifest, normalizedDirectory);
    const sourceFileHashes = Object.fromEntries(manifest.cases.filter(item => item.sourcePath).map(item => [item.id, prepared.get(item.sourcePath!)!.fileHash]));
    const catalogSnapshot = Object.fromEntries(manifest.candidateModels.map(model => [model, MODEL_CATALOG[model]]));
    const experimentIdentity = hash(stableJson({ manifest, sourceFileHashes, catalogSnapshot, promptVersion: PROMPT_VERSION }));
    const experimentPath = path.join(absoluteOutput, 'experiment.json');
    if (fs.existsSync(experimentPath)) {
      const existing = JSON.parse(fs.readFileSync(experimentPath, 'utf8')) as { experimentIdentity?: string };
      if (existing.experimentIdentity !== experimentIdentity) throw new Error('Experiment identity mismatch; use a new output directory');
    } else {
      writeJsonAtomically(experimentPath, { version: 1, mode: 'REAL_MODEL_EVALUATION', experimentIdentity, manifest, sourceFileHashes, catalogSnapshot, promptVersion: PROMPT_VERSION });
    }

    const resultsDirectory = path.join(absoluteOutput, 'results');
    fs.mkdirSync(resultsDirectory, { recursive: true });
    const results: Array<{ value: EvaluationResult; path: string }> = [];
    let resumedResults = 0;
    let stoppedReason: EvaluationRunSummary['stoppedReason'] = null;

    for (const item of manifest.cases) {
      for (const model of manifest.candidateModels) {
        const resultPath = safeResultPath(resultsDirectory, item, model);
        const source = item.sourcePath ? prepared.get(item.sourcePath) : undefined;
        const stageInputHash = hash(stableJson(stageInput(item, source)));
        const identityFields = {
          experimentIdentity, caseId: item.id, stage: item.stage, stageInputHash,
          fileHash: source?.fileHash ?? null, promptVersion: PROMPT_VERSION, model,
          candidateModels: manifest.candidateModels,
          stageCaseIds: manifest.cases.filter(candidate => candidate.stage === item.stage).map(candidate => candidate.id),
          settings: EVALUATION_SETTINGS,
          modelSource: { sourceUrl: MODEL_CATALOG[model].sourceUrl, verifiedDate: MODEL_CATALOG[model].verifiedDate },
          region: manifest.region, rates: MODEL_CATALOG[model].rates[manifest.region],
        };
        const resultId = hash(stableJson(identityFields));
        if (fs.existsSync(resultPath)) {
          const existing = readResult(resultPath);
          if (existing.resultId !== resultId || existing.experimentIdentity !== experimentIdentity) throw new Error('Resume identity mismatch; refusing to mix experiments');
          results.push({ value: existing, path: resultPath });
          resumedResults += 1;
          continue;
        }

        if (results.length >= manifest.maxCalls!) { stoppedReason = 'max_calls_reached'; break; }
        const reservationCny = estimateReservationCny(model, manifest.region);
        const alreadyCharged = results.reduce((total, entry) => total + entry.value.chargedCostCny, 0);
        if (alreadyCharged + reservationCny > manifest.budgetCny! + Number.EPSILON) { stoppedReason = 'budget_exhausted'; break; }

        const createdAt = new Date().toISOString();
        let result: EvaluationResult = {
          version: 1, mode: 'REAL_MODEL_EVALUATION', resultId, resultHash: null,
          ...identityFields, reservationCny, status: 'reserved', value: null, run: null, error: null,
          estimatedActualCostCny: null, chargedCostCny: reservationCny, createdAt, completedAt: null,
        };
        writeJsonAtomically(resultPath, result);
        results.push({ value: result, path: resultPath });
        try {
          const client = new ChatClient({
            apiKey, baseUrl, timeoutMs: options.timeoutMs ?? 90_000, bailianOnly: true,
            models: Object.fromEntries(STAGES.map(stage => [stage, model])), maxTokens: EVALUATION_SETTINGS.maxOutputTokens,
          });
          const provider = options.providerFactory ? options.providerFactory(model, client) : new StagedProvider(client);
          const stageResult = await invokeStage(provider, item, source);
          const actualCost = estimateActualCostCny(model, manifest.region, stageResult.run.promptTokens, stageResult.run.completionTokens);
          result = { ...result, status: 'succeeded', value: stageResult.value, run: stageResult.run, estimatedActualCostCny: actualCost, chargedCostCny: actualCost ?? reservationCny, completedAt: new Date().toISOString() };
        } catch (error) {
          result = { ...result, status: 'failed', error: sanitizeError(error), completedAt: new Date().toISOString() };
        }
        result = { ...result, resultHash: resultHash(result) };
        writeJsonAtomically(resultPath, result);
        results[results.length - 1] = { value: result, path: resultPath };
      }
      if (stoppedReason) break;
    }
    return summarize(experimentIdentity, results, resumedResults, stoppedReason);
  } finally {
    fs.rmSync(normalizedDirectory, { recursive: true, force: true });
    fs.closeSync(lock!);
    fs.unlinkSync(lockPath);
  }
}

export function previewEvaluation(manifestValue: EvaluationManifest | unknown): {
  manifest: EvaluationManifest;
  plannedCalls: number;
  reservationEstimateCny: number;
  fitsConfiguredCaps: boolean | null;
} {
  const manifest = validateManifest(manifestValue);
  const plannedCalls = manifest.cases.length * manifest.candidateModels.length;
  const reservationEstimateCny = manifest.cases.reduce((total) => total
    + manifest.candidateModels.reduce((subtotal, model) => subtotal + estimateReservationCny(model, manifest.region), 0), 0);
  const fitsConfiguredCaps = manifest.budgetCny === undefined || manifest.maxCalls === undefined
    ? null
    : plannedCalls <= manifest.maxCalls && reservationEstimateCny <= manifest.budgetCny;
  return { manifest, plannedCalls, reservationEstimateCny, fitsConfiguredCaps };
}

export function loadEvaluationResults(outputDirectory: string): EvaluationResult[] {
  const resultsDirectory = path.join(path.resolve(outputDirectory), 'results');
  if (!fs.existsSync(resultsDirectory)) return [];
  return fs.readdirSync(resultsDirectory).filter(name => name.endsWith('.json')).sort().map(name => readResult(path.join(resultsDirectory, name)));
}
