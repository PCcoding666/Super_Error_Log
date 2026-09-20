import fs from 'node:fs';
import { config } from '../config.js';
import { AiError } from './errors.js';
import type {
  AiProvider,
  ExtractInput,
  ExtractResult,
  FieldSuggestion,
  MatchInput,
  MatchResult,
  SuggestInput,
} from './provider.js';
import { validateExtractItems } from './validate.js';

interface ChatMessage {
  role: 'system' | 'user';
  content: unknown;
}

/** OpenAI-compatible 视觉模型 provider：JSON 输出、超时与错误分类、不记录 Key 与图片内容 */
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';

  private async chat(messages: ChatMessage[], operation: string): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.aiTimeoutMs);
    const started = Date.now();
    try {
      const res = await fetch(`${config.aiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${config.aiApiKey}`,
        },
        body: JSON.stringify({
          model: config.aiModel,
          messages,
          response_format: { type: 'json_object' },
          temperature: 0,
        }),
        signal: controller.signal,
      });
      if (res.status === 429) throw new AiError('rate_limited', 'provider 限流');
      if (!res.ok) throw new AiError('provider_error', `provider HTTP ${res.status}`);
      const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const text = body.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new AiError('invalid_json', 'provider 响应缺少内容');
      try {
        return JSON.parse(text);
      } catch {
        throw new AiError('invalid_json', 'provider 返回非法 JSON');
      }
    } catch (e) {
      if (e instanceof AiError) throw e;
      if (e instanceof Error && e.name === 'AbortError') {
        throw new AiError('timeout', `provider 超时（${Date.now() - started}ms）`);
      }
      throw new AiError('provider_error', e instanceof Error ? e.message : String(e));
    } finally {
      clearTimeout(timer);
    }
  }

  private imageContent(path: string, mime: string): unknown {
    const b64 = fs.readFileSync(path).toString('base64');
    return { type: 'image_url', image_url: { url: `data:${mime};base64,${b64}` } };
  }

  async extractItems(input: ExtractInput): Promise<ExtractResult> {
    if (input.mime === 'application/pdf') {
      throw new AiError('unsupported', '真实模式暂不支持 PDF 逐页识别，请拆分为图片上传');
    }
    const data = await this.chat(
      [
        {
          role: 'system',
          content:
            '你是初中错题结构化助手。从图片中识别错题并输出 JSON：{"items":[{"itemIndex":0,"textExcerpt":"...","subject":"数学|物理|化学","chapter":"...","knowledgeTags":["..."],"questionType":"...","hasTeacherNote":true,"hasAnswer":true,"confidence":0.0,"fieldConfidence":{"subject":0.0,"knowledgeTags":0.0,"questionType":0.0}}]}。只输出 JSON。',
        },
        { role: 'user', content: [this.imageContent(input.storagePath, input.mime)] },
      ],
      'extract',
    );
    return { items: validateExtractItems(data) };
  }

  async suggestFields(input: SuggestInput): Promise<FieldSuggestion> {
    const data = (await this.chat(
      [
        {
          role: 'system',
          content:
            '你是初中错题标注助手。基于题目摘要给出建议（不是事实），输出 JSON：{"subject":{"value":"...","confidence":0.0},"knowledgeTags":{"value":["..."],"confidence":0.0},"questionType":{"value":"...","confidence":0.0},"attemptState":{"value":"完全不会|知道考什么但没想到方法|方法基本正确但步骤出错|本来会但审题计算书写失误|时间不足|其他","confidence":0.0},"possibleCause":{"value":"知识概念|方法选择|推理步骤|计算|审题遗漏|表达规范|时间注意力状态","confidence":0.0},"reviewValue":{"value":"必须再做|可以再做|没必要再做","confidence":0.0}}。掌握感（masteryFeeling）是学生的自我判断，绝不要输出。只输出 JSON。',
        },
        { role: 'user', content: `题目摘要：${input.textExcerpt}\n当前学科：${input.subject ?? '未知'}` },
      ],
      'suggest',
    )) as FieldSuggestion;
    return data;
  }

  async matchReturnSheet(input: MatchInput): Promise<MatchResult> {
    const data = (await this.chat(
      [
        {
          role: 'system',
          content:
            '你在复习包完成页照片中寻找题号标记。候选短 ID 列表会给出。输出 JSON：{"shortId":"...或null","confidence":0.0}。只输出 JSON。',
        },
        {
          role: 'user',
          content: [
            { type: 'text', text: `候选短 ID：${input.candidateShortIds.join(', ')}` },
            this.imageContent(input.imagePath, 'image/jpeg'),
          ],
        },
      ],
      'match',
    )) as MatchResult;
    if (typeof data?.confidence !== 'number') throw new AiError('invalid_json', 'match 结果缺少 confidence');
    return { shortId: data.shortId ?? null, confidence: data.confidence };
  }
}
