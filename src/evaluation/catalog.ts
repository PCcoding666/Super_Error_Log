export const EVALUATION_REGIONS = ['beijing', 'singapore'] as const;
export type EvaluationRegion = typeof EVALUATION_REGIONS[number];

export interface TokenRates {
  inputCnyPerMillion: number;
  outputCnyPerMillion: number;
}

export interface EvaluationModel {
  id: string;
  multimodal: true;
  rates: Record<EvaluationRegion, TokenRates>;
  settings: typeof EVALUATION_SETTINGS;
  sourceUrl: string;
  verifiedDate: '2026-09-07';
}

export const EVALUATION_SETTINGS = {
  temperature: 0,
  inputTokenCeiling: 100_000,
  maxOutputTokens: 8_192,
  thinking: false,
} as const;

export const MODEL_CATALOG = {
  'qwen3.8-27b': {
    id: 'qwen3.8-27b', multimodal: true,
    rates: {
      beijing: { inputCnyPerMillion: 3, outputCnyPerMillion: 12 },
      singapore: { inputCnyPerMillion: 3.646, outputCnyPerMillion: 21.875 },
    },
    settings: EVALUATION_SETTINGS,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-8-27b',
    verifiedDate: '2026-09-07',
  },
  'qwen3.8-max-0902': {
    id: 'qwen3.8-max-0902', multimodal: true,
    rates: {
      beijing: { inputCnyPerMillion: 12, outputCnyPerMillion: 36 },
      singapore: { inputCnyPerMillion: 14.988, outputCnyPerMillion: 44.965 },
    },
    settings: EVALUATION_SETTINGS,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-8-max',
    verifiedDate: '2026-09-07',
  },
  'qwen3.8-flash': {
    id: 'qwen3.8-flash', multimodal: true,
    rates: {
      beijing: { inputCnyPerMillion: 0.8, outputCnyPerMillion: 2.7 },
      singapore: { inputCnyPerMillion: 1.094, outputCnyPerMillion: 3.427 },
    },
    settings: EVALUATION_SETTINGS,
    sourceUrl: 'https://help.aliyun.com/zh/model-studio/qwen3-8-flash',
    verifiedDate: '2026-09-07',
  },
} as const satisfies Record<string, EvaluationModel>;

export type CatalogModelId = keyof typeof MODEL_CATALOG;

export function isCatalogModel(model: string): model is CatalogModelId {
  return Object.hasOwn(MODEL_CATALOG, model);
}

export function estimateReservationCny(model: CatalogModelId, region: EvaluationRegion): number {
  const rates: TokenRates = MODEL_CATALOG[model].rates[region];
  return (EVALUATION_SETTINGS.inputTokenCeiling * rates.inputCnyPerMillion
    + EVALUATION_SETTINGS.maxOutputTokens * rates.outputCnyPerMillion) / 1_000_000;
}

export function estimateActualCostCny(
  model: CatalogModelId,
  region: EvaluationRegion,
  promptTokens: number | null,
  completionTokens: number | null,
): number | null {
  if (promptTokens === null || completionTokens === null) return null;
  const rates: TokenRates = MODEL_CATALOG[model].rates[region];
  return (promptTokens * rates.inputCnyPerMillion + completionTokens * rates.outputCnyPerMillion) / 1_000_000;
}
