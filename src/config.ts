import fs from 'node:fs';
import path from 'node:path';

if (fs.existsSync(path.resolve('.env'))) process.loadEnvFile(path.resolve('.env'));

export type AiMode = 'mock' | 'openai' | 'bailian';

const wantedMode = (process.env.SEL_AI_MODE ?? 'mock') as AiMode;
if (!['mock', 'openai', 'bailian'].includes(wantedMode)) throw new Error('SEL_AI_MODE 必须为 mock/openai/bailian');
const aiMode = wantedMode;
export const aiModeDegraded = false;
function nonNegativeInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== '' && Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
const defaultModel = process.env.SEL_AI_MODEL ?? (aiMode === 'bailian' ? 'qwen3.8-27b' : '');
/** 学生端详情页的解答（要看图、可能带交互图）和拍照答案转写：百炼默认用 qwen3.8-max（2026-10-24 用户指定），不跟通用模型走。 */
const stageDefaults: Record<string, string> = aiMode === 'bailian' ? { explain: 'qwen3.8-max', answer_read: 'qwen3.8-max' } : {};

export const config = {
  port: Number(process.env.PORT ?? 3100),
  host: process.env.SEL_HOST ?? '127.0.0.1',
  dataDir: path.resolve(process.env.SEL_DATA_DIR ?? (aiMode === 'mock' ? 'data' : 'data/real')),
  aiMode,
  aiModeDegraded,
  aiBaseUrl: process.env.SEL_AI_BASE_URL ?? '',
  aiApiKey: process.env.SEL_AI_API_KEY || process.env.DASHSCOPE_API_KEY || '',
  aiModel: defaultModel,
  aiModels: Object.fromEntries(['layout', 'transcribe', 'diagnose', 'coach', 'match', 'crop_inventory', 'crop_verify', 'followup', 'correct', 'material_extract', 'material_verify', 'material_answer', 'material_grade', 'explain', 'answer_read'].map(stage =>
    [stage, process.env[`SEL_AI_MODEL_${stage.toUpperCase()}`] || stageDefaults[stage] || defaultModel])),
  /** 语音转写模型（学生网页版「说说为什么错」）；不回退到通用 SEL_AI_MODEL（文本模型不能转写）。 */
  aiAsrModel: process.env.SEL_AI_MODEL_ASR || 'qwen-audio-3.1-asr-flash',
  aiTimeoutMs: Number(process.env.SEL_AI_TIMEOUT_MS ?? 90000),
  /** 详情页解答的后台预生成：只自动处理最近多少天录入的题（0 = 只处理学生打开过的题）；队列多久看一次。 */
  insightBackfillDays: nonNegativeInt(process.env.SEL_INSIGHT_BACKFILL_DAYS, 30),
  insightQueueIntervalMs: nonNegativeInt(process.env.SEL_INSIGHT_QUEUE_INTERVAL_MS, 15_000),
  mockFault: process.env.SEL_MOCK_FAULT ?? '',
  maxUploadBytes: 15 * 1024 * 1024,
  allowedMime: new Map<string, string>([
    ['image/jpeg', '.jpg'],
    ['image/png', '.png'],
    ['image/webp', '.webp'],
    ['image/heic', '.heic'],
    ['image/heif', '.heif'],
    ['application/pdf', '.pdf'],
  ]),
} as const;

export function uploadsDir(): string {
  const dir = path.join(config.dataDir, 'uploads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function dbPath(): string {
  return path.join(config.dataDir, 'app.db');
}

export function packetsDir(): string {
  const dir = path.join(config.dataDir, 'packets');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function eventsLogPath(): string {
  return path.join(config.dataDir, 'events.log');
}
