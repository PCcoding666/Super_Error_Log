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

// 全平台统一用 iOS 外观：学生主要用 iPhone Safari，安卓上也保持同一套样式。
setupIonicReact({ mode: 'ios' });

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
