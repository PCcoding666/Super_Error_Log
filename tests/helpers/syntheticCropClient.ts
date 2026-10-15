import { ChatClient, type Message, type ModelStage, type StageResult } from '../../src/ai/chatClient.js';

/** Synthetic transport double: deliberately asserts no real image understanding. */
export class SyntheticCropClient extends ChatClient {
  calls: ModelStage[] = [];
  beforeResponse: (() => Promise<void>) | null = null;
  visibility: 'present' | 'missing' = 'present';
  constructor() { super({ baseUrl: 'http://127.0.0.1/unused', apiKey: 'synthetic', models: {}, timeoutMs: 1, bailianOnly: false }); }
  override async call(stage: ModelStage, messages: Message[]): Promise<StageResult<unknown>> {
    this.calls.push(stage); await this.beforeResponse?.();
    const part = (messages[1]!.content as Array<{ type: string; text: string }>)[0]!;
    const input = JSON.parse(part.text);
    const inventory = { questionNumber: input.questionNumber, sourceStatus: 'readable', referenceText: '合成核对原文，不是真实题目评测', uncertainties: [],
      items: [{ id: 's1', category: input.kind === 'question' ? 'request' : input.kind === 'diagram' ? 'diagram' : 'mark', description: '合成必需内容' }] };
    const comparison = { checks: [{ id: 's1', visibility: this.visibility, note: '合成裁图核对证据' }], unexpectedMissing: [], uncertainties: [],
      boundary: 'clear', coveredDiagramIds: [], purity: { status: 'clean', issues: [] }, textFidelity: input.candidateText ? 'match' : 'not_applicable', textNote: '合成文本核对' };
    return { value: stage === 'crop_inventory' ? inventory : comparison,
      run: { stage, model: 'SYNTHETIC_NOT_MODEL_EVALUATION', durationMs: 1, promptTokens: 1, completionTokens: 1, maxTokens: 128, thinking: false, promptVersion: 'synthetic' } };
  }
}
