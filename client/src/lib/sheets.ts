import { actionSheetController, type ActionSheetOptions } from '@ionic/core/components';
import { defineCustomElement as defineIonActionSheet } from '@ionic/core/components/ion-action-sheet.js';

defineIonActionSheet();

/**
 * 命令式弹出一张 action sheet。每次都是新实例，所以上一张还在收起时再点一次也能立刻弹出来；
 * `useIonActionSheet` 在上一张 didDismiss 之前会直接忽略新的 present，快速连点会被吞掉。
 */
export async function presentActionSheet(options: ActionSheetOptions): Promise<void> {
  const sheet = await actionSheetController.create(options);
  await sheet.present();
}
