import { config } from '../config.js';
import { MockAiProvider } from './mockProvider.js';
import { StagedProvider } from './stagedProvider.js';
import type { AiProvider } from './provider.js';

let provider: AiProvider | null = null;

export function getAiProvider(): AiProvider {
  if (provider) return provider;
  provider = config.aiMode !== 'mock' ? new StagedProvider() : new MockAiProvider();
  return provider;
}

export function setAiProviderForTest(p: AiProvider | null): void {
  provider = p;
}
