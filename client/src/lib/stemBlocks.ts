/**
 * 题干里只认一种 Markdown：GFM 管道表格（识别提示词要求模型这样写表格）。
 * 其余文字原样当纯文本——题号「10.」、负号「-x²」、「x_1」「2*3」这类在完整 Markdown 里会被吃掉或改样，
 * 所以这里不做完整解析，也不渲染任何 HTML。
 */
export type Align = 'left' | 'center' | 'right' | null;

export type StemBlock =
  | { kind: 'text'; text: string }
  | { kind: 'table'; head: string[]; align: Align[]; rows: string[][] };

const DELIMITER_CELL = /^:?-+:?$/;

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

function fit<T>(cells: T[], width: number, blank: T): T[] {
  return cells.length >= width ? cells.slice(0, width) : [...cells, ...Array<T>(width - cells.length).fill(blank)];
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
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length && lines[index]!.trim() && lines[index]!.includes('|')) {
      rows.push(fit(splitRow(lines[index]!), head.length, ''));
      index += 1;
    }
    index -= 1;
    blocks.push({ kind: 'table', head, align, rows });
  }
  flush();
  return blocks.length ? blocks : [{ kind: 'text', text }];
}
