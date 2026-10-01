import { config } from '../config.js';
import { MockAiProvider } from './mockProvider.js';
import { StagedProvider } from './stagedProvider.js';
import type { AiProvider, FollowupProvider, CorrectionProvider, CoachProvider } from './provider.js';

let provider: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (provider) return provider;
  provider = config.aiMode !== 'mock' ? new StagedProvider() : new MockAiProvider();
  return provider;
}

export function setAiProviderForTest(p: AiProvider | null): void {
  provider = p;
}

/** T4c：追问/归纳能力。两种内置 provider 都实现；外部 provider 未实现时 fail-fast。 */
export function getFollowupProvider(): FollowupProvider {
  const p = getAiProvider();
  if (typeof (p as Partial<FollowupProvider>).followupAsk !== 'function'
    || typeof (p as Partial<FollowupProvider>).followupSummarize !== 'function') {
    throw new Error('当前 AI 提供者不支持追问复盘');
  }
  return p as AiProvider & FollowupProvider;
}

/** T4e：修订建议能力。两种内置 provider 都实现；外部 provider 未实现时 fail-fast。 */
export function getCorrectionProvider(): CorrectionProvider {
  const p = getAiProvider();
  if (typeof (p as Partial<CorrectionProvider>).proposeCorrection !== 'function') {
    throw new Error('当前 AI 提供者不支持识别结果修订');
  }
  return p as AiProvider & CorrectionProvider;
}

/** T5：打印快照辅导能力。两种内置 provider 都实现；外部 provider 未实现时 fail-fast。 */
export function getCoachProvider(): CoachProvider {
  const p = getAiProvider();
  if (typeof (p as Partial<CoachProvider>).coachForPrint !== 'function') {
    throw new Error('当前 AI 提供者不支持打印快照辅导');
  }
  return p as AiProvider & CoachProvider;
}
