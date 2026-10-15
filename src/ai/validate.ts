import { AiError } from './errors.js';
import type { ExtractedItem } from './provider.js';

function isConfidence(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
}

/**
 * 严格校验 extractItems 的模型输出：任何核心字段不合法即抛 invalid_json，
 * 由服务层重试/转人工，避免脏数据入库。
 */
export function validateExtractItems(data: unknown): ExtractedItem[] {
  const items = (data as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new AiError('invalid_json', 'extract 结果缺少 items 数组');
  return items.map((raw, idx) => {
    const bad = (field: string): never => {
      throw new AiError('invalid_json', `extract 第 ${idx + 1} 题字段 ${field} 不合法`);
    };
    const it = raw as Partial<ExtractedItem> | null;
    if (!it || typeof it !== 'object') bad('item');
    if (!Number.isInteger(it!.itemIndex) || (it!.itemIndex as number) < 0) bad('itemIndex');
    if (typeof it!.textExcerpt !== 'string' || it!.textExcerpt.length === 0) bad('textExcerpt');
    if (it!.subject != null && typeof it!.subject !== 'string') bad('subject');
    if (it!.chapter != null && typeof it!.chapter !== 'string') bad('chapter');
    if (it!.questionType != null && typeof it!.questionType !== 'string') bad('questionType');
    if (!Array.isArray(it!.knowledgeTags) || it!.knowledgeTags.some((t) => typeof t !== 'string')) bad('knowledgeTags');
    if (!isConfidence(it!.confidence)) bad('confidence');
    const fc = it!.fieldConfidence ?? {};
    if (typeof fc !== 'object' || fc === null || Array.isArray(fc) || Object.values(fc).some((v) => !isConfidence(v))) {
      bad('fieldConfidence');
    }
    return {
      itemIndex: it!.itemIndex as number,
      textExcerpt: it!.textExcerpt as string,
      subject: (it!.subject ?? undefined) as ExtractedItem['subject'],
      chapter: it!.chapter ?? undefined,
      knowledgeTags: it!.knowledgeTags as string[],
      questionType: it!.questionType ?? undefined,
      hasTeacherNote: it!.hasTeacherNote === true,
      hasAnswer: it!.hasAnswer === true,
      confidence: it!.confidence as number,
      fieldConfidence: fc as Record<string, number>,
    };
  });
}
