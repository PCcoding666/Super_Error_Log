import { getDb } from '../db/connection.js';

/** 只有创建时明确记录为 mock 的资产才属于演示数据；缺失来源一律视为非 demo。 */
export function isDemoAsset(assetId: string): boolean {
  const row = getDb()
    .prepare('SELECT mode FROM asset_origin WHERE asset_id = ?')
    .get(assetId) as { mode: string } | undefined;
  return row?.mode === 'mock';
}
