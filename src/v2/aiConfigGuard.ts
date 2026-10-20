/**
 * v2 启动守卫：/v2 的追问、修改建议、打印辅导都走 Web 的 AI 配置（SEL_AI_*）。
 * 追问与打印辅导在模型调用失败时有温和的退路（固定问句、空提示），
 * 所以配置缺失不会在运行时报错——必须在启动时 fail-hard，绝不带着缺配置上线。
 * 报错只说缺哪个变量名，不含任何配置值。
 */
export interface V2AiConfig {
  aiMode: string;
  aiBaseUrl: string;
  aiApiKey: string;
  aiModels: Record<string, string>;
}

const V2_STAGES = ['followup', 'correct', 'coach', 'material_extract', 'material_verify', 'material_answer', 'material_grade'] as const;

export function assertV2AiConfigured(cfg: V2AiConfig): void {
  if (cfg.aiMode !== 'bailian') {
    throw new Error(`单进程装配要求 SEL_AI_MODE=bailian（当前：${cfg.aiMode}），禁止降级为 mock`);
  }
  if (!cfg.aiBaseUrl.trim()) throw new Error('缺少 SEL_AI_BASE_URL：/v2 的追问、修改与打印辅导需要它');
  if (!cfg.aiApiKey.trim()) throw new Error('缺少 SEL_AI_API_KEY：/v2 的追问、修改与打印辅导需要它');
  for (const stage of V2_STAGES) {
    if (!(cfg.aiModels[stage] ?? '').trim()) {
      throw new Error(`缺少 SEL_AI_MODEL_${stage.toUpperCase()}（或通用的 SEL_AI_MODEL）`);
    }
  }
}
