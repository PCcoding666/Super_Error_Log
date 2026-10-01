import { describe, expect, it } from 'vitest';
import { assertV2AiConfigured } from '../../src/v2/aiConfigGuard.js';

const complete = {
  aiMode: 'bailian',
  aiBaseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  aiApiKey: 'sk-test',
  aiModels: { followup: 'm', correct: 'm', coach: 'm' },
};

describe('v2 启动守卫：/v2 的追问、修改、打印辅导用到的 AI 配置缺一项就拒绝启动', () => {
  it('配置齐全时通过', () => {
    expect(() => assertV2AiConfigured(complete)).not.toThrow();
  });

  it('非 bailian 模式拒绝（禁止降级为 mock）', () => {
    expect(() => assertV2AiConfigured({ ...complete, aiMode: 'mock' })).toThrow(/SEL_AI_MODE=bailian/);
  });

  it('缺接口地址拒绝', () => {
    expect(() => assertV2AiConfigured({ ...complete, aiBaseUrl: '  ' })).toThrow(/SEL_AI_BASE_URL/);
  });

  it('缺密钥拒绝，报错不含任何密钥内容', () => {
    expect(() => assertV2AiConfigured({ ...complete, aiApiKey: '' })).toThrow(/SEL_AI_API_KEY/);
  });

  it.each(['followup', 'correct', 'coach'])('缺 %s 阶段模型拒绝', stage => {
    expect(() => assertV2AiConfigured({ ...complete, aiModels: { ...complete.aiModels, [stage]: '' } }))
      .toThrow(new RegExp(`SEL_AI_MODEL_${stage.toUpperCase()}`));
  });
});
