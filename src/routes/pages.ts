import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import multer from 'multer';
import path from 'node:path';
import { getAiProvider } from '../ai/index.js';
import { config, packetsDir, uploadsDir } from '../config.js';
import { getDb } from '../db/connection.js';
import { ATTEMPT_STATES, CAUSES, COMPLETION_LABEL, REVIEW_VALUES, type Cause, type AttemptState, type MasteryFeeling, type ReviewValue, type Subject, SUBJECTS, type Completion } from '../domain/types.js';
import { recordAttempt, attemptsForPacket } from '../services/attemptService.js';
import { createBatch, processBatch, retryFailedAssets } from '../services/batchService.js';
import { audit } from '../services/eventLog.js';
import { archiveItem, correctItem, getDiagnosis, getItem, getReflectionSuggestion, listItems, submitReflection, type ItemRow } from '../services/itemService.js';
import { adoptionMatches } from '../domain/reflectionSuggestion.js';
import { generatePacketPdf, buildPacketPrintData } from '../services/pdfService.js';
import { computeRecommendations, createPacket, getPacket, packetItems } from '../services/planService.js';
import { createProfile, getProfile } from '../services/studentService.js';
import { masteryTrend, recurrenceAlerts, weakTags } from '../services/trendService.js';
import { mediaHandler } from './api.js';
import { requireStudent } from './middleware.js';
import { resetAllData } from './parent.js';
import { BatchDetailPage, BatchesPage, BatchReviewPage, type AssetRow, type BatchRow } from '../views/batches.js';
import { HomePage } from '../views/home.js';
import { ItemDetailPage, ItemsPage } from '../views/items.js';
import { OnboardingPage } from '../views/onboarding.js';
import { PacketPage, PacketReturnPage } from '../views/packets.js';
import { PlanPage } from '../views/plan.js';
import { ReflectPage } from '../views/reflect.js';
import { sendHtml } from '../views/render.js';
import { SettingsPage } from '../views/settings.js';
import { TrendsPage } from '../views/trends.js';
import { getEvidence } from '../services/evidenceService.js';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes, files: 30 },
});

function flash(req: import('express').Request): { ok?: string; err?: string } | undefined {
  const ok = typeof req.query.ok === 'string' ? req.query.ok : undefined;
  const err = typeof req.query.err === 'string' ? req.query.err : undefined;
  return ok || err ? { ok, err } : undefined;
}

export function pagesRouter(): Router {
  const r = Router();

  // ---------- 角色切换 ----------
  r.get('/role/parent', (_req, res) => {
    res.setHeader('set-cookie', 'sel_role=parent; Path=/; SameSite=Lax');
    audit('parent_view_accessed');
    res.redirect('/parent');
  });
  r.get('/role/student', (_req, res) => {
    res.setHeader('set-cookie', 'sel_role=student; Path=/; SameSite=Lax');
    res.redirect('/');
  });

  // ---------- 首次设置 ----------
  r.get('/onboarding', (_req, res) => {
    if (getProfile()) {
      res.redirect('/');
      return;
    }
    sendHtml(res, OnboardingPage({}));
  });
  r.post('/onboarding', (req, res) => {
    const nickname = String(req.body.nickname ?? '').trim();
    const subjects = (Array.isArray(req.body.subjects) ? req.body.subjects : [req.body.subjects]).filter(
      (s: unknown): s is Subject => SUBJECTS.includes(s as Subject),
    );
    if (!nickname || subjects.length === 0 || req.body.privacy_ack !== 'yes') {
      sendHtml(res, OnboardingPage({ error: '请填写昵称、至少选择一门学科，并确认已了解隐私边界。' }));
      return;
    }
    createProfile({ nickname, subjects, weekendPref: String(req.body.weekend_pref ?? '周六上午'), stage: String(req.body.grade ?? '') });
    res.redirect('/');
  });

  // ---------- 首页 ----------
  r.get('/', requireStudent, (_req, res) => {
    const profile = getProfile();
    if (!profile) {
      res.redirect('/onboarding');
      return;
    }
    const db = getDb();
    const count = (sql: string): number =>
      (db.prepare(sql).get(profile.id) as { n: number }).n;
    const recentBatch = db
      .prepare('SELECT id, status, total_files AS total, done_files AS done, failed_files AS failed FROM source_batch WHERE student_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(profile.id) as { id: string; status: string; total: number; done: number; failed: number } | undefined;
    const activePacket = db
      .prepare(
        `SELECT rp.id, rp.status, rp.planned_date AS plannedDate,
                (SELECT COUNT(*) FROM review_packet_item rpi WHERE rpi.packet_id = rp.id) AS total,
                (SELECT COUNT(*) FROM review_attempt ra WHERE ra.packet_id = rp.id) AS attempted
         FROM review_packet rp WHERE rp.student_id = ? AND rp.status != 'returned'
         ORDER BY rp.created_at DESC LIMIT 1`,
      )
      .get(profile.id) as { id: string; status: string; plannedDate: string | null; total: number; attempted: number } | undefined;

    sendHtml(
      res,
      HomePage({
        role: 'student',
        data: {
          nickname: profile.nickname,
          aiMode: config.aiMode,
          aiDegraded: config.aiModeDegraded,
          pendingCorrection: count("SELECT COUNT(*) AS n FROM error_item WHERE student_id = ? AND status = 'needs_review'"),
          pendingReflection: count("SELECT COUNT(*) AS n FROM error_item WHERE student_id = ? AND status = 'ready_for_reflection'"),
          eligibleCount: count("SELECT COUNT(*) AS n FROM error_item WHERE student_id = ? AND status IN ('eligible_for_review','needs_recheck')"),
          activePacket: activePacket ?? null,
          recentBatch: recentBatch ?? null,
        },
      }),
    );
  });

  // ---------- 上传与批次 ----------
  r.post('/batches', requireStudent, upload.array('files', 30), async (req, res) => {
    const profile = getProfile();
    if (!profile) {
      res.redirect('/onboarding');
      return;
    }
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    if (files.length === 0) {
      res.redirect('/?err=' + encodeURIComponent('请至少选择一个文件'));
      return;
    }
    const { batchId } = await createBatch(
      profile.id,
      files.map((f) => ({ filename: Buffer.from(f.originalname, 'latin1').toString('utf8'), mime: f.mimetype, buffer: f.buffer })),
    );
    // 后台处理；批次页展示进度
    void processBatch(batchId).catch(() => undefined);
    res.redirect(`/batches/${batchId}`);
  });

  r.get('/batches', requireStudent, (_req, res) => {
    const profile = getProfile()!;
    const batches = getDb()
      .prepare('SELECT * FROM source_batch WHERE student_id = ? ORDER BY created_at DESC')
      .all(profile.id) as unknown as BatchRow[];
    sendHtml(res, BatchesPage({ role: 'student', batches }));
  });

  r.get('/batches/:id', requireStudent, (req, res) => {
    const db = getDb();
    const batch = db.prepare('SELECT * FROM source_batch WHERE id = ?').get(String(req.params.id)) as BatchRow | undefined;
    if (!batch) {
      res.status(404).send('批次不存在');
      return;
    }
    const assets = db.prepare('SELECT id, filename, status, error, size FROM source_asset WHERE batch_id = ? ORDER BY created_at').all(batch.id) as unknown as AssetRow[];
    const items = db.prepare('SELECT * FROM error_item WHERE batch_id = ? ORDER BY item_index').all(batch.id) as unknown as ItemRow[];
    sendHtml(res, BatchDetailPage({ role: 'student', batch, assets, items, flash: flash(req) }));
  });

  r.post('/batches/:id/retry', requireStudent, async (req, res) => {
    const n = retryFailedAssets(String(req.params.id));
    if (n > 0) {
      void processBatch(String(req.params.id)).catch(() => undefined);
    }
    res.redirect(`/batches/${req.params.id}?ok=${encodeURIComponent(`已重试 ${n} 个文件`)}`);
  });

  r.get('/batches/:id/review', requireStudent, (req, res) => {
    const db = getDb();
    const items = db
      .prepare("SELECT * FROM error_item WHERE batch_id = ? AND status = 'needs_review' ORDER BY item_index")
      .all(String(req.params.id)) as unknown as ItemRow[];
    if (items[0] && getEvidence(items[0].id)) { res.redirect(`/items/${items[0].id}/evidence`); return; }
    sendHtml(res, BatchReviewPage({ role: 'student', batchId: String(req.params.id), items }));
  });

  // ---------- 错题 ----------
  r.get('/items', requireStudent, (req, res) => {
    const profile = getProfile()!;
    const status = typeof req.query.status === 'string' && req.query.status ? (req.query.status as never) : undefined;
    sendHtml(res, ItemsPage({ role: 'student', items: listItems(profile.id, { status }), statusFilter: status }));
  });

  r.get('/items/:id', requireStudent, (req, res) => {
    const item = getItem(String(req.params.id));
    if (!item) {
      res.status(404).send('题目不存在');
      return;
    }
    sendHtml(res, ItemDetailPage({ role: 'student', item, diagnosis: getDiagnosis(item.id), flash: flash(req) }));
  });

  r.post('/items/:id/correct', requireStudent, (req, res) => {
    const item = getItem(String(req.params.id));
    if (!item) {
      res.status(404).send('题目不存在');
      return;
    }
    const subject = String(req.body.subject ?? '') as Subject;
    if (!SUBJECTS.includes(subject)) {
      res.redirect(`/batches/${item.batch_id}/review?err=` + encodeURIComponent('学科无效'));
      return;
    }
    correctItem(item.id, {
      subject,
      chapter: String(req.body.chapter ?? ''),
      knowledgeTags: String(req.body.knowledge_tags ?? '')
        .split(/[,，、]/)
        .map((s) => s.trim())
        .filter(Boolean),
      questionType: String(req.body.question_type ?? ''),
      isKeyGap: req.body.is_key_gap === '1',
    });
    res.redirect(`/batches/${item.batch_id}/review`);
  });

  r.post('/items/:id/archive', requireStudent, (req, res) => {
    const result = archiveItem(String(req.params.id));
    res.redirect(
      `/items/${req.params.id}?${result.ok ? `ok=${encodeURIComponent('已归档')}` : `err=${encodeURIComponent(result.reason)}`}`,
    );
  });

  // ---------- 媒体（学生专属） ----------
  r.get('/media/asset/:assetId', requireStudent, mediaHandler);

  // ---------- 反思 ----------
  r.get('/reflect', requireStudent, async (req, res) => {
    const profile = getProfile()!;
    const db = getDb();
    const items = db
      .prepare("SELECT * FROM error_item WHERE student_id = ? AND status = 'ready_for_reflection' ORDER BY created_at")
      .all(profile.id) as unknown as ItemRow[];
    const first = items[0] ?? null;
    const suggestion = first ? await getReflectionSuggestion(first) : null;
    const total = db
      .prepare("SELECT COUNT(*) AS n FROM error_item WHERE student_id = ? AND status IN ('ready_for_reflection','eligible_for_review')")
      .get(profile.id) as { n: number };
    sendHtml(res, ReflectPage({ role: 'student', item: first, remaining: items.length, total: total.n, suggestion, flash: flash(req) }));
  });

  r.post('/reflect/:itemId', requireStudent, async (req, res) => {
    const attemptState = String(req.body.attempt_state ?? '');
    const cause = String(req.body.cause ?? '');
    const masteryFeeling = Number(req.body.mastery_feeling ?? -1);
    const reviewValue = String(req.body.review_value ?? '');
    const valid =
      (ATTEMPT_STATES as readonly string[]).includes(attemptState) &&
      (CAUSES as readonly string[]).includes(cause) &&
      [0, 1, 2, 3].includes(masteryFeeling) &&
      (REVIEW_VALUES as readonly string[]).includes(reviewValue);
    if (!valid) {
      res.redirect('/reflect?err=' + encodeURIComponent('四项都需要选择'));
      return;
    }
    // 一键采纳：提交的三项必须与服务器当前建议完全一致（防篡改/防过期）
    const adoptedAi = String(req.body.adopted_ai ?? '') === '1';
    if (adoptedAi) {
      const item = getItem(String(req.params.itemId));
      const suggestion = item ? await getReflectionSuggestion(item) : null;
      if (!adoptionMatches(suggestion, { attemptState, cause, reviewValue })) {
        res.redirect('/reflect?err=' + encodeURIComponent('AI 建议已变化，请重新确认后再提交'));
        return;
      }
    }
    const result = submitReflection(String(req.params.itemId), {
      attemptState: attemptState as AttemptState,
      cause: cause as Cause,
      masteryFeeling: masteryFeeling as MasteryFeeling,
      reviewValue: reviewValue as ReviewValue,
    }, 'student', { adoptedAi });
    if (!result.ok) {
      res.redirect('/reflect?err=' + encodeURIComponent(result.error ?? '提交失败'));
      return;
    }
    res.redirect('/reflect');
  });

  // ---------- 计划与复习包 ----------
  r.get('/plan', requireStudent, (req, res) => {
    const profile = getProfile()!;
    const recommendations = computeRecommendations(profile.id, new Date());
    sendHtml(res, PlanPage({ role: 'student', recommendations, notes: [], flash: flash(req) }));
  });

  r.post('/plan', requireStudent, (req, res) => {
    const profile = getProfile()!;
    const raw = req.body.item_ids;
    const itemIds = (Array.isArray(raw) ? raw : raw ? [raw] : []).map(String);
    const result = createPacket(profile.id, itemIds);
    if (!result.ok) {
      res.redirect('/plan?err=' + encodeURIComponent(result.error ?? '创建失败'));
      return;
    }
    res.redirect(`/packets/${result.packetId}`);
  });

  r.get('/packets/:id', requireStudent, (req, res) => {
    const packet = getPacket(String(req.params.id));
    if (!packet) {
      res.status(404).send('复习包不存在');
      return;
    }
    sendHtml(res, PacketPage({
      role: 'student', packet, items: packetItems(packet.id),
      attemptedCount: attemptsForPacket(packet.id).length, flash: flash(req),
    }));
  });

  r.post('/packets/:id/generate', requireStudent, async (req, res) => {
    const result = await generatePacketPdf(String(req.params.id));
    if (!result.ok) {
      res.redirect(`/packets/${req.params.id}?err=` + encodeURIComponent(result.error ?? '生成失败'));
      return;
    }
    res.redirect(`/packets/${req.params.id}?ok=` + encodeURIComponent('PDF 已生成'));
  });

  r.get('/packets/:id/pdf', requireStudent, (req, res) => {
    const packet = getPacket(String(req.params.id));
    const resolved = packet?.pdf_path ? path.resolve(packet.pdf_path) : '';
    if (!packet?.pdf_path || !resolved.startsWith(path.resolve(packetsDir()) + path.sep) || !fs.existsSync(resolved)) {
      res.status(404).send('PDF 尚未生成');
      return;
    }
    try { buildPacketPrintData(String(req.params.id)); }
    catch (e) { res.status(409).send(e instanceof Error ? e.message : '打印证据需要重新校对'); return; }
    // 以 packetsDir 为 root：send 只检查 root 以下的路径段，数据目录在 .claude/worktrees 这类点目录下时不被当成隐藏文件 404。
    const root = path.resolve(packetsDir());
    res.download(path.relative(root, resolved), `复习包_${packet.week}.pdf`, { root });
  });

  r.get('/packets/:id/print-preview', requireStudent, (req, res) => {
    let data;
    try { data = buildPacketPrintData(String(req.params.id)); }
    catch (e) { res.status(409).send(e instanceof Error ? e.message : '打印证据需要重新校对'); return; }
    if (!data) {
      res.status(404).send('复习包不存在');
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.send(data.fullHtml);
  });

  r.get('/packets/:id/return', requireStudent, (req, res) => {
    const packet = getPacket(String(req.params.id));
    if (!packet) {
      res.status(404).send('复习包不存在');
      return;
    }
    const recorded: Record<string, { completion: string; correct: number; performed_at: string | null }> = {};
    for (const a of attemptsForPacket(packet.id)) {
      recorded[a.item_id] = {
        completion: a.completion,
        correct: a.correct,
        performed_at: a.performed_at,
      };
    }
    sendHtml(res, PacketReturnPage({ role: 'student', packet, items: packetItems(packet.id), recorded, flash: flash(req) }));
  });

  r.post('/packets/:id/return', requireStudent, (req, res) => {
    const packetId = String(req.params.id);
    const items = packetItems(packetId);
    let recorded = 0;
    const errors: string[] = [];
    for (const item of items) {
      const completion = req.body[`completion_${item.id}`];
      const correctRaw = req.body[`correct_${item.id}`];
      const performedRaw = req.body[`performed_${item.id}`];
      if (!completion && correctRaw === undefined && !performedRaw) continue;
      if (!completion || correctRaw === undefined) {
        errors.push(`${item.short_id}: 完成情况与对错都要选择`);
        continue;
      }
      if (!(Object.keys(COMPLETION_LABEL) as string[]).includes(String(completion)) || !['0', '1'].includes(String(correctRaw))) {
        errors.push(`${item.short_id}: 回传值无效`);
        continue;
      }
      const result = recordAttempt(packetId, item.id, {
        completion: completion as Completion,
        correct: correctRaw === '1',
        stuckStep: String(req.body[`stuck_${item.id}`] ?? '') || undefined,
        performedAt: String(performedRaw ?? '').trim() || undefined,
      }, 'student');
      if (result.ok) recorded += 1;
      else errors.push(`${item.short_id}: ${result.error}`);
    }
    if (errors.length > 0) {
      res.redirect(`/packets/${packetId}/return?err=` + encodeURIComponent(errors.join('；')));
      return;
    }
    if (recorded === 0) {
      res.redirect(`/packets/${packetId}/return?err=` + encodeURIComponent('没有可提交的记录'));
      return;
    }
    res.redirect(`/packets/${packetId}/return?ok=` + encodeURIComponent(`已记录 ${recorded} 道题的结果`));
  });

  r.post('/packets/:id/return-upload', requireStudent, upload.array('files', 10), async (req, res) => {
    const packetId = String(req.params.id);
    const items = packetItems(packetId);
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];
    const provider = getAiProvider();
    const matched: string[] = [];
    const uncertain: string[] = [];
    for (const f of files) {
      const originalName = Buffer.from(f.originalname, 'latin1').toString('utf8');
      const tmpPath = path.join(uploadsDir(), `return_${Date.now()}_${crypto.randomUUID()}.img`);
      fs.writeFileSync(tmpPath, f.buffer);
      try {
        const m = await provider.matchReturnSheet({
          imagePath: tmpPath,
          originalName,
          contentHash: `${f.size}:${f.originalname}`,
          candidateShortIds: items.map((i) => i.short_id ?? '').filter(Boolean),
        });
        if (m.shortId && m.confidence >= 0.8) matched.push(m.shortId);
        else uncertain.push(originalName);
      } finally {
        fs.rmSync(tmpPath, { force: true });
      }
    }
    const msg = [
      matched.length > 0 ? `已识别完成页：${matched.join('、')}，请在下方录入对应结果` : '',
      uncertain.length > 0 ? `以下照片无法确定对应题目，请手动核对：${uncertain.join('、')}` : '',
      matched.length === 0 && uncertain.length === 0 ? '未识别到完成页' : '',
    ].filter(Boolean).join('；');
    res.redirect(`/packets/${packetId}/return?ok=${encodeURIComponent(msg)}`);
  });

  // ---------- 趋势 / 设置 ----------
  r.get('/trends', requireStudent, (_req, res) => {
    const profile = getProfile()!;
    sendHtml(res, TrendsPage({
      role: 'student',
      weakTags: weakTags(profile.id),
      alerts: recurrenceAlerts(profile.id),
      mastery: masteryTrend(profile.id),
    }));
  });

  r.get('/settings', requireStudent, (req, res) => {
    const profile = getProfile()!;
    sendHtml(res, SettingsPage({
      role: 'student', nickname: profile.nickname, subjects: profile.subjects,
      aiMode: config.aiMode, aiDegraded: config.aiModeDegraded, flash: flash(req),
    }));
  });

  r.post('/settings/reset', requireStudent, (_req, res) => {
    resetAllData();
    res.redirect('/onboarding');
  });

  return r;
}
