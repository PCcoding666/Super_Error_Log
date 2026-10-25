import katex from 'katex';
import type { ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';

/**
 * AI 解答的 Markdown：GFM（列表、加粗、表格）+ $…$ / $$…$$ 公式。按需加载（katex 较大），只在详情页用。
 * 模型输出不可信：不渲染 HTML，链接只留文字、图片只留替代文字（不发请求、不跳转）。
 * 公式只输出 MathML（不需要字体和样式表，和服务端 answerText 一样）；拒绝可能带外链或展开过深的命令，渲染不了就原样显示。
 */
function Formula(props: { tex: string; display: boolean }): ReactNode {
  const source = props.display ? `$$${props.tex}$$` : `$${props.tex}$`;
  if (props.tex.length > 2000 || /\\(?:href|url|includegraphics|html\w*|def|gdef|newcommand|renewcommand)\b/.test(props.tex)) return <code>{source}</code>;
  try {
    const html = katex.renderToString(props.tex, { output: 'mathml', displayMode: props.display, throwOnError: true, trust: false, strict: 'ignore', maxExpand: 100, maxSize: 10 });
    return <span className={props.display ? 'md-math md-math-display' : 'md-math'} dangerouslySetInnerHTML={{ __html: html }} />;
  } catch { return <code>{source}</code>; }
}

const classes = (value: unknown): string => (Array.isArray(value) ? value.join(' ') : String(value ?? ''));

const COMPONENTS: Components = {
  // remark-math 把公式变成 code.math-inline / pre > code.math-display。
  code({ className, children }) {
    const kind = classes(className);
    if (kind.includes('math-inline') || kind.includes('math-display')) return <Formula tex={String(children).trim()} display={kind.includes('math-display')} />;
    return <code>{children}</code>;
  },
  pre({ node, children }) {
    const first = node?.children[0];
    if (first?.type === 'element' && classes(first.properties.className).includes('math-display')) return <div className="md-math-block">{children}</div>;
    return <pre>{children}</pre>;
  },
  table({ children }) { return <div className="stem-table-wrap"><table className="stem-table md-table">{children}</table></div>; },
  a({ children }) { return <span>{children}</span>; },
  img({ alt }) { return alt ? <span>{alt}</span> : null; },
};

export default function Markdown(props: { text: string; inline?: boolean }): ReactNode {
  return <div className={props.inline ? 'md md-inline' : 'md'}>
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} components={COMPONENTS} skipHtml>{props.text}</ReactMarkdown>
  </div>;
}
