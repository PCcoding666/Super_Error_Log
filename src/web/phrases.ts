/**
 * 中文短句按词组分块（quality round 2 iteration 2）：标题、按钮、清单行这类一两行的短句，换行只落在块与块之间，
 * 页面缩放到 200% 时也不会剩下一个字单独一行（「第 1 / 道印出来是这 / 样」），标点不会落到行首（「，一页一张」）。
 *
 * 做法：用 ICU 分词（Intl.Segmenter，词粒度）得到词，再按下面的规则拼成块：
 * - 收尾的标点（，。、；：！？）」等）跟着前一个词；开头的标点（（「等）跟着后一个词；「」里 ≤ 12 个字的短引语整个是一块；
 * - 单字的词粘在前一块上（块不超过 max 个字时），块太短（< 2 个字）时继续往后粘；收尾标点后面另起一块；
 * - 最后一块如果只有一个字：从前一块挪一个单字过来，挪不了就并进前一块。
 * 空格保留成块与块之间的断点（但「第 1 道」这种空格后面是单字的不断开）。只改断行，文字一个不变。
 */
const SEGMENTER = new Intl.Segmenter('zh', { granularity: 'word' });
const CLOSING = /^[，。、；：！？）」』》】”’…·,.;:!?)\]%～~—]+$/u;
const OPENING = /^[（「『《【“‘(\[]+$/u;
const QUOTE = /(「[^「」]{1,12}」)/u;

interface Atom { text: string; space?: boolean; closer?: boolean }

/** 算字数只算字和数字（标点、空格、符号不算），「拍，」是一个字。 */
const visible = (text: string): number => (text.match(/[\p{L}\p{N}]/gu) ?? []).length;

function atomsOf(text: string): Atom[] {
  const atoms: Atom[] = [];
  let pendingOpen = '';
  for (const part of text.split(QUOTE)) {
    if (!part) continue;
    if (QUOTE.test(part) && /^「[^「」]{1,12}」$/u.test(part)) { atoms.push({ text: pendingOpen + part }); pendingOpen = ''; continue; }
    for (const { segment, isWordLike } of SEGMENTER.segment(part)) {
      if (/^\s+$/u.test(segment)) { if (pendingOpen) pendingOpen += segment; else atoms.push({ text: segment, space: true }); continue; }
      if (!isWordLike && CLOSING.test(segment)) {
        if (pendingOpen) { atoms.push({ text: pendingOpen + segment, closer: true }); pendingOpen = ''; continue; }
        const last = atoms[atoms.length - 1];
        // 前面是空格（「勾 · 漏了题」的「·」）：当成普通的一块，和后面的空格、词粘在一起（「· 漏了」），不改动原文的顺序。
        if (last && !last.space) { last.text += segment; last.closer = true; } else { atoms.push({ text: pendingOpen + segment }); pendingOpen = ''; }
        continue;
      }
      if (!isWordLike && OPENING.test(segment)) { pendingOpen += segment; continue; }
      atoms.push({ text: pendingOpen + segment }); pendingOpen = '';
    }
  }
  if (pendingOpen) atoms.push({ text: pendingOpen });
  return atoms;
}

/** 把短句拆成不可拆的小块（空格单独成块，渲染时放在块与块之间）。拼起来与原文逐字相同。 */
export function phrasePieces(text: string, max = 4): string[] {
  const atoms = atomsOf(text);
  const chunks: Atom[][] = [];
  let cur: Atom[] = [];
  const len = (list: Atom[]): number => visible(list.map(atom => atom.text).join(''));
  for (let index = 0; index < atoms.length; index += 1) {
    const atom = atoms[index]!;
    if (atom.space) {
      const next = atoms[index + 1];
      // 当前块还太短，或者空格后面是单字（「第 1 道」「约 2 分钟」）：空格留在块里，不在这里断。
      if (cur.length && !cur[cur.length - 1]!.closer && (len(cur) < 2 || (next && !next.space && visible(next.text) === 1))) { cur.push(atom); continue; }
      if (cur.length) { chunks.push(cur); cur = []; }
      chunks.push([atom]);
      continue;
    }
    const last = cur[cur.length - 1];
    const size = visible(atom.text);
    const glue = cur.length === 0 || (!last!.closer && (len(cur) < 2 || (size === 1 && len(cur) + 1 <= max)));
    if (glue) cur.push(atom); else { chunks.push(cur); cur = [atom]; }
  }
  if (cur.length) chunks.push(cur);
  // 最后一块只有一个字：从前一块挪一个单字过来，挪不了就并进去。
  const words = chunks.filter(chunk => !chunk[0]!.space);
  const tail = words[words.length - 1];
  const before = words[words.length - 2];
  if (tail && before && len(tail) === 1) {
    const moved = before[before.length - 1]!;
    if (len(before) >= 3 && visible(moved.text) === 1 && !moved.closer) {
      before.pop();
      tail.unshift(moved);
    } else {
      const from = chunks.indexOf(before);
      const to = chunks.indexOf(tail);
      const merged = chunks.slice(from, to + 1).flat();
      chunks.splice(from, to - from + 1, merged);
    }
  }
  return chunks.map(chunk => chunk.map(atom => atom.text).join('')).filter(piece => piece !== '');
}
