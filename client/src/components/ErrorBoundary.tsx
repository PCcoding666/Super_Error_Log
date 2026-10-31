import { IonButton } from '@ionic/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { report } from '../lib/report';

interface State { failed: boolean; cid: string | null }

/**
 * 渲染出错的兜底：以前某个组件抛了错整页就白屏、什么都不留。现在报一条 render_error（带组件栈的第一行），
 * 页面上说明没丢东西、给出错误编号和「重新打开」。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, cid: null };

  static getDerivedStateFromError(): Partial<State> { return { failed: true }; }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const component = (info.componentStack ?? '').split('\n').map(line => line.trim()).find(line => line.length > 0);
    this.setState({ cid: report('render_error', { code: error.name || 'Error', message: error.message, component }) });
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="problem problem-page" role="alert">
        <h2>这一页没显示出来</h2>
        <p>照片和错题都在服务器上，没有丢。重新打开试一次；还不行就把下面的编号告诉老师。</p>
        {this.state.cid ? <p className="muted small">错误编号 {this.state.cid}</p> : null}
        <IonButton onClick={() => location.assign('/s/')}>重新打开</IonButton>
      </div>
    );
  }
}
