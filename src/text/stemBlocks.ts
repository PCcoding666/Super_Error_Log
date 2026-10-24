/**
 * 题干里只认一种 Markdown：GFM 管道表格（识别提示词要求模型这样写表格）。
 * 其余文字原样当纯文本——题号「10.」、负号「-x²」、「x_1」「2*3」、绝对值「|x-1|」这类在完整 Markdown 里会被吃掉或改样，
 * 所以这里不做完整解析，也不渲染任何 HTML。学生端页面（client/）和服务端摘要共用这一份。
 *
 * 判定从严：必须有「表头 + 分隔行」才算表格；表体每一行的格数要和表头一致，带外侧竖线的表头还要求表体行也以 | 开头和结尾。
 * 不符合的行结束表格、原样留作文字——宁可多显示一行竖线，也不吞掉题干里的句子。
 */
export type Align = 'left' | 'center' | 'right' | null;

export type StemBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

const DELIMITER_CELL = /^:?-+:?$/;

function outerPipes(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.startsWith('|') && trimmed.endsWith('|') && !trimmed.endsWith('\\|');
}

function splitRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith('|')) body = body.slice(1);
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1);
  const cells: string[] = [];
  let cell = '';
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (char === '\\' && body[index + 1] === '|') { cell += '|'; index += 1; }
    else if (char === '|') { cells.push(cell.trim()); cell = ''; }
    else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

function delimiterAlign(line: string): Align[] | null {
  if (!line.includes('|') || !line.includes('-')) return null;
  const cells = splitRow(line);
  if (!cells.every(cell => DELIMITER_CELL.test(cell))) return null;
  return cells.map(cell => {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
  });
}

export function stemBlocks(text: string): StemBlock[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks: StemBlock[] = [];
  let pending: string[] = [];
  const flush = (): void => {
    const joined = pending.join('\n').replace(/^\n+|\n+$/g, '');
    if (joined.trim()) blocks.push({ kind: 'text', text: joined });
    pending = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const align = line.includes('|') && index + 1 < lines.length ? delimiterAlign(lines[index + 1]!) : null;
    const head = align ? splitRow(line) : null;
    if (!align || !head || head.length !== align.length) { pending.push(line); continue; }
    flush();
    const piped = outerPipes(line);
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const row = lines[index]!;
      if (!row.includes('|') || (piped && !outerPipes(row))) break;
      const cells = splitRow(row);
      if (cells.length !== head.length) break;
      rows.push(cells);
      index += 1;
    }
    index -= 1;
    blocks.push({ kind: 'table', head, align, rows });
  }
  flush();
  return blocks.length ? blocks : [{ kind: 'text', text }];
}

/** 去掉表格（表头、分隔行、表体），只留文字：列表摘要要的是一句话，表格读不成句子。没有表格时原样返回。 */
export function withoutTableRows(text: string): string {
  const blocks = stemBlocks(text);
  return blocks.some(block => block.kind === 'table')
    ? blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n')
    : text;
}

/** 存进 error_item.text_excerpt 的摘要：先去表格再截断，免得 80 字正好把表格从中间切开。 */
export function questionExcerpt(text: string, max = 80): string {
  return withoutTableRows(text).slice(0, max);
}
