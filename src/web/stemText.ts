/**
 * 识别出的题干里，表格是 GFM 管道表格（每行以 | 开头、以 | 结尾，第二行是 |---|---|）。
 * 列表摘要只要一句话，表格行读不成句子，先去掉；整行必须以 | 开头并结尾，免得误伤「|x-1|+|y|=3」这样的绝对值题干。
 */
const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function withoutTableRows(text: string): string {
  return text.split('\n').filter(line => !TABLE_ROW.test(line)).join('\n');
}
