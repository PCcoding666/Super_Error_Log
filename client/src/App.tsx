import { IonApp, IonRouterOutlet } from '@ionic/react';
import { IonReactRouter } from '@ionic/react-router';
import { Route } from 'react-router-dom';
import { HomePage } from './pages/HomePage';
import { IntakePage } from './pages/IntakePage';
import { ItemPage } from './pages/ItemPage';
import { SettingsPage } from './pages/SettingsPage';

/**
 * 四屏：错题本（根）、录入态、题目详情、设置。路径都和旧的服务端页面错开（/s/items、/s/photos、
 * /s/settings 仍由服务器渲染），刷新或直接打开时服务器只对这四个路径下发单页壳。
 */
export function App() {
  return (
    <IonApp>
      <IonReactRouter basename="/s">
        <IonRouterOutlet>
          <Route path="/" element={<HomePage />} />
          <Route path="/new" element={<IntakePage />} />
          <Route path="/q/:id" element={<ItemPage />} />
          <Route path="/me" element={<SettingsPage />} />
        </IonRouterOutlet>
      </IonReactRouter>
    </IonApp>
  );
}
