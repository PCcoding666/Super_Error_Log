import type { ReactNode } from 'react';
import katex from 'katex';

interface Block { marker: string; kind: 'text' | 'part' | 'case' | 'result'; text: string }
const EXPLICIT_MATH = /\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$[^$\n]+\$/g;

/** Only consecutive question/case labels create sections; coordinates and (12) in prose do not. */
function answerBlocks(text: string): Block[] {
  const labels: Array<{ start: number; end: number; marker: string; kind: 'part' | 'case' | 'result' }> = [];
  const mathRanges = [...text.matchAll(EXPLICIT_MATH)].map(match => [match.index!, match.index! + match[0].length]);
  let nextPart = 1, nextCase = 1;
  for (const match of text.matchAll(/(^|\n|[ \t]+)(\([1-9]\d?\)|（[1-9]\d?）|[①-⑳])(?=\s*\S)/gu)) {
    const marker = match[2]!;
    const start = match.index! + match[1]!.length;
    if (mathRanges.some(([from, to]) => start >= from! && start < to!)) continue;
    const isCase = /^[①-⑳]$/u.test(marker);
    const after = text.slice(start + marker.length);
    if (/^[+−\-=*/×÷^_⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉<>≤≥≠≈]/u.test(after.trimStart())) continue;
    if (!isCase && !/^\s|^\p{Script=Han}/u.test(after)) continue;
    const number = isCase ? marker.charCodeAt(0) - 0x2460 + 1 : Number(marker.slice(1, -1));
    if (number !== (isCase ? nextCase : nextPart)) continue;
    if (!isCase && nextPart === 1 && text.slice(0, start).trim() && !match[1]!.includes('\n')) continue;
    if (isCase) nextCase += 1;
    else { nextPart += 1; nextCase = 1; }
    labels.push({ start, end: start + marker.length, marker, kind: isCase ? 'case' : 'part' });
  }
  for (const line of text.matchAll(/(^|\n)([^\n]+)/g)) {
    const start = line.index! + line[1]!.length;
    const value = line[2]!.trim();
    if (mathRanges.some(([from, to]) => start >= from! && start < to!)) continue;
    const conclusion = /^(?:答[：:]|因此|所以|综上)/u.test(value);
    // A final line consisting only of named point coordinates is a separate written result.
    // Its value is never checked or corrected by this renderer.
    const coordinates = labels.length > 0 && !text.slice(start + line[2]!.length).trim()
      && value.includes(',') && /^(?:[A-Z][₀₁₂₃₄₅₆₇₈₉0-9]*\([A-Za-zΑ-ω0-9+−\-*/√⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉()., \t]+\)[，,;； \t]*)+$/u.test(value);
    if (conclusion || coordinates) labels.push({ start, end: start, marker: '', kind: 'result' });
  }
  labels.sort((a, b) => a.start - b.start);
  if (!labels.length) return [{ marker: '', kind: 'text', text }];
  const blocks: Block[] = [];
  if (text.slice(0, labels[0]!.start).trim()) blocks.push({ marker: '', kind: 'text', text: text.slice(0, labels[0]!.start) });
  labels.forEach((label, index) => blocks.push({ marker: label.marker, kind: label.kind,
    text: text.slice(label.end, labels[index + 1]?.start ?? text.length).trim() }));
  return blocks;
}

/** Presentation-only conversion of explicit Unicode atoms. No solving or algebraic simplification. */
function unicodeMath(source: string): string {
  const system = /^\s*\{([^{}]+)\}\s*$/.exec(source);
  const equations = system?.[1]?.split(';');
  if (equations && equations.length > 1 && equations.every(line => line.includes('='))) {
    return `\\begin{cases}${equations.map(line => unicodeMath(line.trim())).join('\\\\')}\\end{cases}`;
  }
  const atom = (start: number): { tex: string; end: number } | null => {
    let end = start;
    let tex: string;
    const char = source[start];
    if (char === '(' || char === '[') {
      const close = char === '(' ? ')' : ']';
      let depth = 1;
      for (end = start + 1; end < source.length && depth; end += 1) {
        if (source[end] === char) depth += 1;
        else if (source[end] === close) depth -= 1;
      }
      if (depth) return null;
      tex = char + unicodeMath(source.slice(start + 1, end - 1)) + close;
    } else if (char === '√') {
      const child = atom(start + 1);
      if (!child) return null;
      tex = `\\sqrt{${child.tex}}`;
      end = child.end;
    } else {
      const match = /^(?:\d+(?:\.\d+)?|[A-Za-zΑ-ω])/.exec(source.slice(start));
      if (!match) return null;
      tex = match[0]; end = start + tex.length;
    }
    const suffix = /^[⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉]+/u.exec(source.slice(end))?.[0] ?? '';
    return { tex: tex + suffix, end: end + suffix.length };
  };
  const tokens: Array<{ tex: string; atom: boolean }> = [];
  for (let i = 0; i < source.length;) {
    const part = atom(i);
    if (part) { tokens.push({ tex: part.tex, atom: true }); i = part.end; continue; }
    // A slash binds only its adjacent atoms. For example 1/3 x² remains (1/3) x².
    if (source[i] === '/') {
      let previous = tokens.length - 1;
      while (previous >= 0 && /^\s+$/.test(tokens[previous]!.tex)) previous -= 1;
      let right = i + 1;
      while (/\s/.test(source[right] ?? '') && right < source.length) right += 1;
      const denominator = atom(right);
      if (previous >= 0 && tokens[previous]!.atom && denominator) {
        const numerator = tokens[previous]!.tex;
        tokens.splice(previous, tokens.length - previous, { tex: `\\frac{${numerator}}{${denominator.tex}}`, atom: true });
        i = denominator.end; continue;
      }
    }
    const char = source[i]!;
    tokens.push({ tex: char === '{' || char === '}' ? `\\${char}` : char, atom: false });
    i += 1;
  }
  return tokens.map(token => token.tex).join('');
}

function formula(source: string, tex: string, display = false): ReactNode | null {
  // Bound expansion, reject trust-sensitive commands, and leave unsupported input readable.
  if (tex.length > 2000 || /\\(?:href|url|includegraphics|html\w*|def|gdef|newcommand|renewcommand)\b/.test(tex)) return null;
  try {
    const html = katex.renderToString(tex, {
      output: 'mathml', displayMode: display, throwOnError: true, trust: false,
      strict: 'ignore', maxExpand: 100, maxSize: 10,
    });
    // Native MathML needs neither a browser script nor CDN fonts; it also works without JS.
    return <span className={`answer-math${display ? ' answer-math-display' : ''}`} title={source}
      tabIndex={0} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch { return null; }
}

function formattedText(text: string): { nodes: ReactNode[]; changed: boolean } {
  const nodes: ReactNode[] = [];
  let changed = false;
  const push = (node: ReactNode): void => { nodes.push(<span key={nodes.length}>{node}</span>); };
  const plain = (value: string): void => {
    // Whitelist math characters; Chinese prose and punctuation remain ordinary React text.
    const runs = value.split(/([A-Za-zΑ-ω0-9 \t=+−\-*/×÷√⁺⁻⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉()[\]{}.,;<>≤≥≠≈^_]+)/gu);
    for (const run of runs) {
      const value = run.trim();
      const isMath = (/[√⁰¹²³⁴⁵⁶⁷⁸⁹₀₁₂₃₄₅₆₇₈₉/]/u.test(value) || /^\{.*;.*\}$/.test(value))
        && !/[A-Za-z]{4,}|[_^⁺⁻]/.test(value)
        && !/\b\d{4}\/\d{1,2}\/\d{1,2}\b|\d[, \t]\d{3}\b|\d[eE][+−-]?\d/.test(value);
      const rendered = isMath && value.length <= 2000 ? formula(value, unicodeMath(value)) : null;
      if (rendered) {
        push(run.slice(0, run.length - run.trimStart().length));
        push(rendered);
        push(run.slice(run.trimEnd().length));
        changed = true;
      } else push(run);
    }
  };
  let cursor = 0;
  for (const match of text.matchAll(EXPLICIT_MATH)) {
    plain(text.slice(cursor, match.index));
    const source = match[0];
    const singleDollar = source.startsWith('$') && !source.startsWith('$$');
    const tex = source.slice(singleDollar ? 1 : 2, singleDollar ? -1 : -2);
    // Currency such as "$5, then $10" must not become a formula.
    const currency = singleDollar && (!/[A-Za-z\\=+*/^_]/.test(tex) || /^\s*\d[^\\=+*/^_]*$/.test(tex));
    const rendered = currency ? null
      : formula(source, tex, source.startsWith('$$') || source.startsWith('\\['));
    if (rendered) { push(rendered); changed = true; } else push(source);
    cursor = match.index! + source.length;
  }
  plain(text.slice(cursor));
  return { nodes: changed ? nodes : [text], changed };
}

/** Read-only view over the original observation; storage, corrections and print evidence stay intact. */
export function AnswerText(props: { text: string; teacherNote?: boolean }): ReactNode {
  if (props.text.length > 20000) return <div className="answer-text"><div className="answer-content">{props.text}</div></div>;
  const deduction = props.teacherNote ? /^\s*[-−]\s*(\d+(?:\.\d+)?)\s*分?\s*$/.exec(props.text) : null;
  const blocks = answerBlocks(props.text).map(block => ({ ...block, formatted: formattedText(block.text) }));
  const changed = !!deduction || blocks.some(block => block.kind !== 'text' || block.formatted.changed);
  return <div className="answer-text">
    {deduction ? <p className="answer-deduction">扣 {deduction[1]} 分</p> : blocks.map((block, index) => (
      <div className={block.kind === 'text' ? 'answer-block' : `answer-${block.kind}`} key={index}>
        {block.kind === 'part' ? <h3 className="answer-part-label">{block.marker}</h3>
          : block.marker ? <span className="answer-case-label">{block.marker}</span> : null}
        <div className="answer-content">{block.formatted.nodes}</div>
      </div>
    ))}
    {changed ? <details className="answer-original"><summary>查看原文</summary><pre>{props.text}</pre></details> : null}
  </div>;
}
