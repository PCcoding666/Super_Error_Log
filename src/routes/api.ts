import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { requireStudent } from './middleware.js';
import { getItem } from '../services/itemService.js';
import { parentAggregateJson } from './parent.js';

export function apiRouter(): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ ok: true, aiMode: config.aiMode, degraded: config.aiModeDegraded });
  });

  r.get('/items', requireStudent, (_req, res) => {
    const rows = getDb()
      .prepare('SELECT id, short_id, subject, knowledge_tags, status, confidence FROM error_item ORDER BY created_at')
      .all();
    res.json({ items: rows });
  });

  r.get('/items/:id', requireStudent, (req, res) => {
    const item = getItem(String(req.params.id ?? ''));
    if (!item) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.json({ item });
  });

  /** 家长聚合（任何角色可访问，内容本身只含聚合数据） */
  r.get('/parent/aggregate', (_req, res) => {
    res.json({ aggregate: parentAggregateJson() });
  });

  return r;
}

/** 学生专属的媒体流（图片/PDF 原件），家长 403 */
export function mediaHandler(req: import('express').Request, res: import('express').Response): void {
  const assetId = String(req.params.assetId ?? '');
  const asset = getDb()
    .prepare('SELECT storage_path, mime FROM source_asset WHERE id = ?')
    .get(assetId) as { storage_path: string; mime: string } | undefined;
  if (!asset || !asset.storage_path) {
    res.status(404).send('未找到文件');
    return;
  }
  const resolved = path.resolve(asset.storage_path);
  if (!resolved.startsWith(path.resolve(config.dataDir) + path.sep)) {
    res.status(403).send('非法路径');
    return;
  }
  if (!fs.existsSync(resolved)) {
    res.status(404).send('文件不存在');
    return;
  }
  res.setHeader('content-type', asset.mime);
  fs.createReadStream(resolved).pipe(res);
}
