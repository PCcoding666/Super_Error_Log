import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { config, eventsLogPath, packetsDir, uploadsDir } from '../config.js';
import { getDb } from '../db/connection.js';
import { parentAggregate } from '../services/trendService.js';
import { getProfile } from '../services/studentService.js';
import { ParentPage } from '../views/parent.js';
import { sendHtml } from '../views/render.js';

export function parentRouter(): Router {
  const r = Router();

  r.get('/', (_req, res) => {
    const profile = getProfile();
    if (!profile) {
      res.redirect('/onboarding');
      return;
    }
    sendHtml(res, ParentPage({ data: parentAggregate(profile.id) }));
  });

  return r;
}

/** 家长可见的聚合 API（无反思/原文/图片字段） */
export function parentAggregateJson(): unknown {
  const profile = getProfile();
  if (!profile) return null;
  return parentAggregate(profile.id);
}

export function wipeAllData(): void {
  const db = getDb();
  const tables = [
    'review_attempt', 'review_packet_item', 'review_packet', 'review_recommendation',
    'mastery_event', 'error_diagnosis', 'error_item', 'source_asset', 'source_batch',
    'knowledge_tag', 'guardian_view_policy', 'student_profile', 'ai_run', 'audit_event',
  ];
  for (const t of tables) {
    db.prepare(`DELETE FROM ${t}`).run();
  }
}

/** 彻底清空：数据库 + 上传图片 + 已生成 PDF + 事件日志 */
export function resetAllData(): void {
  wipeAllData();
  fs.rmSync(uploadsDir(), { recursive: true, force: true });
  fs.rmSync(packetsDir(), { recursive: true, force: true });
  fs.rmSync(eventsLogPath(), { force: true });
  fs.rmSync(path.join(config.dataDir, 'evidence'), { recursive: true, force: true });
}
