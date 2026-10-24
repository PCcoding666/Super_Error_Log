import { useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * AI 生成的交互图：服务器单独下发的一页（自带 CSP：不许网络请求、表单和外部资源），这里再加 sandbox="allow-scripts"（不透明来源，读不到 cookie）。
 * 图里的脚本用 postMessage 报高度；只认这个 iframe 自己发来的消息。
 */
export function FigureFrame(props: { src: string }): ReactNode {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(280);
  useEffect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const value = (event.data as { selFigureHeight?: unknown } | null)?.selFigureHeight;
      if (typeof value === 'number' && Number.isFinite(value)) setHeight(Math.min(640, Math.max(120, Math.ceil(value))));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);
  return <iframe ref={frame} className="figure-frame" src={props.src} sandbox="allow-scripts" referrerPolicy="no-referrer" title="交互图" style={{ height }} data-testid="solution-figure" />;
}
