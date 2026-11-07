import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { setupIonicReact } from '@ionic/react';
import '@ionic/react/css/core.css';
import '@ionic/react/css/normalize.css';
import '@ionic/react/css/structure.css';
import '@ionic/react/css/typography.css';
import '@ionic/react/css/palettes/dark.system.css';
import './theme.css';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installGlobalErrorReporting } from './lib/report';

// 全平台统一用 iOS 外观：学生主要用 iPhone Safari，安卓上也保持同一套样式。
setupIonicReact({ mode: 'ios' });
// 没被接住的脚本错误 / Promise 拒绝报给服务器（/s/api/client-log），渲染出错由 ErrorBoundary 兜底并给出错误编号。
installGlobalErrorReporting();

createRoot(document.getElementById('root')!).render(<StrictMode><ErrorBoundary><App /></ErrorBoundary></StrictMode>);
