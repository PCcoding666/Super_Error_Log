/**
 * v2.0 T5：打印快照（D17：服务器生成并冻结"结构化内容 + 图片"，PDF 由手机原生排版生成）。
 *
 * 产品规则（简报为准）：
 * 1. 快照只生成一次：ready 之后对题目的任何修改都不影响快照，再请求返回同一份。
 * 2. 把握徽标 low 的题印遮白裁图；ok 的题印文字，另附必要图示。
 * 3. 题面不得出现答案、学生原作、订正、批注。
 * 4. 提示两级，来自 coach；生成失败不阻塞：提示为空，纸上写"对照原卷"。
 * 5. 答案优先原卷参考答案（reference_answer 观察记录），否则 coach 答案，否则空。
 * 6. 答案页统一提示"对照原卷查看解析"，封面不预设练习时间。
 * 7. 每份包每题至多 1 次 coach，不重试（由逐题单次调用结构保证）。
 *
 * 后台准备在单进程内：同一练习包同时只有一个准备任务（preparing Map）；
 * preparing 行在服务重启后由 resumePendingSnapshots 续做，snapshot_json 里的部分进度决定哪些题已完成。
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { packetsDir } from '../config.js';
import { getDb, now } from '../db/connection.js';
import { validateEvidence, type Coaching, type Diagnosis, type Evidence } from '../ai/evidence.js';
import { getCoachProvider } from '../ai/index.js';
import type { CoachProvider } from '../ai/provider.js';
import { cropPhoto, normalizePhoto, type Box } from '../media/images.js';
import { audit } from '../services/eventLog.js';
import { getEvidence, evidenceSource } from '../services/evidenceService.js';
import { getPractice } from './practiceService.js';

// ---------- 快照形状（手机据此排版） ----------

export interface PrintSnapshotItem {
  itemId: string; shortId: string | null; position: number; subject: string | null; knowledgeTags: string[];
  mode: 'text' | 'crop'; stemText: string | null; cropMedia: string | null; diagramMedia: string[];
  keyStepPrompt: string; checkboxes: string[];
  /** crop 模式下需要学生打印前看一眼截图：存在无法定位的手写（遮不全），或徽标 low（AI 没把握）。text 模式恒为 false。 */
  needsGlance: boolean; glanceReason: string | null;
}

export interface PrintAnswerEntry {
  shortId: string | null; hint1: string | null; hint2: string | null;
  answer: { text: string | null; source: 'paper' | 'ai' | 'none'; label: string | null };
  fallbackNote: string;
}

export interface PrintSnapshot {
  packetId: string; week: string; preparedAt: string;
  cover: { title: string; practiceSlot: string; rules: string[]; itemList: Array<{ shortId: string | null; sourceLabel: string }> };
  items: PrintSnapshotItem[];
  answerSheet: PrintAnswerEntry[];
}

export type PrintStatus = 'none' | 'preparing' | 'ready' | 'failed';

const COVER_RULES = ['不看答案，独立做', '卡住先看一级提示，再看二级', '做完打勾，写上做题日期'];
const CHECKBOXES = ['独立做出', '看了一级提示', '看了二级提示', '没做出来'];
const KEY_STEP_PROMPT = '这题的关键一步是：';

/** crop 模式遮白的区域种类（diagram 不遮）。 */
const MASK_KINDS = new Set(['student_work', 'correction', 'teacher_note', 'reference_answer', 'unknown']);
/** F2：需要"定位才能遮"的手写观察记录种类；缺定位（regionId 为空或区域不存在）即可能遮不全。 */
const GLANCE_KINDS = new Set(['student_work', 'correction', 'teacher_note', 'reference_answer']);
const GLANCE_REASON_UNLOCATED = '这题的手写内容可能没有遮全，打印前请看一眼';
/** T5R2-F1：low 徽标 crop 题恒提示（余量加宽可能带进相邻题目/框漂），让学生打印前核对截图。 */
const GLANCE_REASON_LOW = '这题 AI 没把握，打印前看一眼截图是否完整';
/** 遮白区域外扩：横向 1% 页宽，纵向 1.2% 页高（T5R2-F1，原 1% 遮不住相邻行上沿）。 */
const MASK_EXPAND_X = 0.01;
const MASK_EXPAND_Y = 0.012;

interface SnapshotRow {
  packet_id: string; status: 'preparing' | 'ready' | 'failed';
  progress_done: number; progress_total: number;
  snapshot_json: string | null; error: string | null; created_at: string; ready_at: string | null;
}

function rowOf(packetId: string): SnapshotRow | undefined {
  return getDb().prepare('SELECT * FROM v2_print_snapshot WHERE packet_id = ?').get(packetId) as SnapshotRow | undefined;
}

/**
 * T5R2-F2：fallbackNote 里的题号先规整——去首尾空白和结尾的 .．、。:：)）与"题"、开头的 (（与"第"；
 * 规整后为空就用原值。只影响提示文字，证据里的题号不动。
 */
export function normalizeQuestionNumber(raw: string): string {
  const normalized = raw.trim().replace(/^[（(第]+/, '').replace(/[.．、。:：)）题]+$/, '');
  return normalized || raw;
}

/** coach 的诊断对象：有复盘取学生确认的归纳与错因；没有则 possibleCause=null。 */
function diagnosisFor(itemId: string): Diagnosis {
  const row = getDb().prepare(
    'SELECT cause, confirmed_summary FROM error_diagnosis WHERE item_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
  ).get(itemId) as { cause: Diagnosis['possibleCause']; confirmed_summary: string | null } | undefined;
  if (!row) return { summary: '', possibleCause: null, confidence: 0.5, findings: [], clarificationQuestion: null };
  return { summary: row.confirmed_summary ?? '', possibleCause: row.cause, confidence: 0.5, findings: [], clarificationQuestion: null };
}

/**
 * T5R2-F1：打印专用裁图余量。识别流程的 expandCropMargin 纵向最多 1.2%，
 * 真实模型走查里框整体下漂约 1% 就把题干上沿切掉了；打印没有二次校验机会，用更宽的纵向余量：
 * 纵向每侧 clamp(区域高度 × 0.5, 0.02, 0.04)，横向沿用识别规则，裁到页面边界内。
 */
export function expandPrintCropMargin(box: Box): Box {
  const dx = Math.min(0.03, Math.max(0.01, box.width * 0.06));
  const dy = Math.min(0.04, Math.max(0.02, box.height * 0.5));
  const x = Math.max(0, box.x - dx);
  const y = Math.max(0, box.y - dy);
  const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;
  return {
    x: round6(x), y: round6(y),
    width: round6(Math.min(1, box.x + box.width + dx) - x),
    height: round6(Math.min(1, box.y + box.height + dy) - y),
  };
}

export interface PixelRect { x: number; y: number; width: number; height: number }

function cropPixelBounds(crop: Box, width: number, height: number): { left: number; top: number; right: number; bottom: number } {
  const left = Math.min(width - 1, Math.floor(crop.x * width));
  const top = Math.min(height - 1, Math.floor(crop.y * height));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((crop.x + crop.width) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((crop.y + crop.height) * height)));
  return { left, top, right, bottom };
}

/**
 * T5R2-F1：遮白矩形（裁图内像素坐标）。先在整页像素坐标里算好（外扩后 floor 起点、ceil 终点），
 * 再减去裁图左上角并裁到裁图范围内——与裁图底边/右边相交时 ceil 终点对齐裁图像素边界，一直遮到那条边，不留像素缝。
 */
export function printMaskRects(evidence: Evidence, crop: Box, width: number, height: number): PixelRect[] {
  const { left, top, right, bottom } = cropPixelBounds(crop, width, height);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const rects: PixelRect[] = [];
  for (const region of evidence.regions) {
    if (!MASK_KINDS.has(region.kind)) continue;
    const box = region.box;
    const ex1 = Math.max(0, box.x - MASK_EXPAND_X);
    const ey1 = Math.max(0, box.y - MASK_EXPAND_Y);
    const ex2 = Math.min(1, box.x + box.width + MASK_EXPAND_X);
    const ey2 = Math.min(1, box.y + box.height + MASK_EXPAND_Y);
    // 与裁图区域求交（页坐标）。
    const ix1 = Math.max(ex1, crop.x);
    const iy1 = Math.max(ey1, crop.y);
    const ix2 = Math.min(ex2, crop.x + crop.width);
    const iy2 = Math.min(ey2, crop.y + crop.height);
    if (ix2 <= ix1 || iy2 <= iy1) continue;
    // 整页像素坐标：floor 起点、ceil 终点，再平移到裁图坐标并裁到 [0, cropWidth]×[0, cropHeight]。
    const x = Math.max(0, Math.floor(ix1 * width) - left);
    const y = Math.max(0, Math.floor(iy1 * height) - top);
    const x2 = Math.min(cropWidth, Math.ceil(ix2 * width) - left);
    const y2 = Math.min(cropHeight, Math.ceil(iy2 * height) - top);
    if (x2 > x && y2 > y) rects.push({ x, y, width: x2 - x, height: y2 - y });
  }
  return rects;
}

/**
 * 遮白裁图：questionRegion 经 expandPrintCropMargin（打印专用宽纵向余量）后裁出；
 * 落在裁图内的作答/订正/批注/参考答案/未知区域填白（见 printMaskRects），diagram 不遮。
 */
export async function maskedQuestionCrop(source: Buffer, evidence: Evidence): Promise<Buffer> {
  const crop = expandPrintCropMargin(evidence.questionRegion);
  const normalized = await normalizePhoto(source);
  const metadata = await sharp(normalized).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error('原图尺寸不可读');

  const { left, top, right, bottom } = cropPixelBounds(crop, width, height);
  const cropWidth = right - left;
  const cropHeight = bottom - top;
  const rects = printMaskRects(evidence, crop, width, height)
    .map(r => `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" fill="#ffffff"/>`);

  let pipeline = sharp(normalized).extract({ left, top, width: cropWidth, height: cropHeight });
  if (rects.length > 0) {
    const overlay = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${cropWidth}" height="${cropHeight}">${rects.join('')}</svg>`);
    pipeline = pipeline.composite([{ input: overlay, top: 0, left: 0 }]);
  }
  return pipeline.jpeg({ quality: 88 }).toBuffer();
}

function buildSnapshot(
  packetId: string, week: string, preparedAt: string,
  items: PrintSnapshotItem[], answerSheet: PrintAnswerEntry[],
): PrintSnapshot {
  const ordered = [...items].sort((a, b) => a.position - b.position);
  return {
    packetId, week, preparedAt,
    cover: {
      // 保留字符串字段以兼容既有快照协议；网页封面只留实际做题日期的填写处。
      title: '本周练习', practiceSlot: '', rules: [...COVER_RULES],
      itemList: ordered.map(item => ({ shortId: item.shortId, sourceLabel: '原题' })),
    },
    items: ordered,
    answerSheet,
  };
}

/** 在进程内跑的准备任务（packetId → Promise），保证同一包同时只有一个准备。 */
const preparing = new Map<string, Promise<void>>();

async function prepare(packetId: string, coach: CoachProvider): Promise<void> {
  const db = getDb();
  try {
    const detail = getPractice(packetId);
    if (!detail) throw new Error('练习包不存在');

    // 续做：snapshot_json 里已有的部分进度（同形状、只含已完成题）直接沿用。
    const row = rowOf(packetId)!;
    const partial = row.snapshot_json ? JSON.parse(row.snapshot_json) as PrintSnapshot : null;
    const items: PrintSnapshotItem[] = partial?.items ?? [];
    const answerSheet: PrintAnswerEntry[] = partial?.answerSheet ?? [];
    const doneItemIds = new Set(items.map(item => item.itemId));
    const preparedAt = partial?.preparedAt ?? now();

    const total = detail.items.length;
    db.prepare('UPDATE v2_print_snapshot SET progress_done = ?, progress_total = ? WHERE packet_id = ?')
      .run(items.length, total, packetId);

    const dir = path.join(packetsDir(), packetId);
    fs.mkdirSync(dir, { recursive: true });

    for (const card of detail.items) {
      if (doneItemIds.has(card.id)) continue;
      const record = getEvidence(card.id);
      if (!record) throw new Error(`题目 ${card.id} 没有证据`);
      const evidence = validateEvidence(record.content);
      // 原图读不到（缺失/损坏）→ 整个快照 failed。
      const source = fs.readFileSync(evidenceSource(card.id).storagePath);

      let mode: 'text' | 'crop';
      let stemText: string | null;
      let cropMedia: string | null = null;
      const diagramMedia: string[] = [];
      const diagrams = evidence.regions.filter(region => region.kind === 'diagram');
      // F1：text 模式的前提是"不需要图示，或至少有一个 diagram 区域"；否则改用遮白裁图。
      if (card.badge === 'low' || (evidence.requiresDiagram && diagrams.length === 0)) {
        // 规则 2：low 印遮白裁图。T5R2-F1：同时给出识别题干文字——截图有问题还有文字，文字有问题还有截图。
        mode = 'crop';
        stemText = evidence.questionText;
        cropMedia = `p${card.position}-crop.jpg`;
        fs.writeFileSync(path.join(dir, cropMedia), await maskedQuestionCrop(source, evidence));
      } else {
        mode = 'text';
        stemText = evidence.questionText;
        if (evidence.requiresDiagram) {
          for (const [index, region] of diagrams.entries()) {
            const name = `p${card.position}-diagram-${index}.jpg`;
            fs.writeFileSync(path.join(dir, name), await cropPhoto(source, region.box));
            diagramMedia.push(name);
          }
        }
      }

      // F2/T5R2-F1：crop 模式下，存在无定位区域的手写观察记录（遮不掉）→ 沿用旧文案；
      // 否则徽标 low 也提示（打印余量加宽可能带进相邻题目，且模型框可能整体漂移）。text 模式恒不需要。
      const regionIds = new Set(evidence.regions.map(region => region.id));
      const hasUnlocatedHandwriting = evidence.observations.some(
        o => GLANCE_KINDS.has(o.kind) && (o.regionId === null || !regionIds.has(o.regionId)),
      );
      const needsGlance = mode === 'crop' && (hasUnlocatedHandwriting || card.badge === 'low');
      const glanceReason = !needsGlance ? null
        : hasUnlocatedHandwriting ? GLANCE_REASON_UNLOCATED : GLANCE_REASON_LOW;

      // 规则 4/5/7：每题至多 1 次 coach，失败不阻塞（提示为空、答案可能只剩原卷/空）。
      let coaching: Coaching | null = null;
      try {
        coaching = await coach.coachForPrint(evidence, diagnosisFor(card.id));
      } catch {
        coaching = null;
      }
      const paperAnswer = evidence.observations.find(o => o.kind === 'reference_answer');
      const answer: PrintAnswerEntry['answer'] = paperAnswer
        ? { text: paperAnswer.text, source: 'paper', label: '原卷参考答案' }
        : coaching
          ? { text: coaching.answer, source: 'ai', label: 'AI 参考，未经老师核验' }
          : { text: null, source: 'none', label: null };

      items.push({
        itemId: card.id, shortId: card.shortId, position: card.position,
        subject: card.subject, knowledgeTags: card.knowledgeTags,
        mode, stemText, cropMedia, diagramMedia,
        keyStepPrompt: KEY_STEP_PROMPT, checkboxes: [...CHECKBOXES],
        needsGlance, glanceReason,
      });
      answerSheet.push({
        shortId: card.shortId,
        hint1: coaching?.hints[0] ?? null,
        hint2: coaching?.hints[1] ?? null,
        answer,
        fallbackNote: '对照原卷查看解析',
      });

      // 每题完成立即落部分进度：重启续做不重做已完成题。
      db.prepare('UPDATE v2_print_snapshot SET progress_done = ?, snapshot_json = ? WHERE packet_id = ?')
        .run(items.length, JSON.stringify(buildSnapshot(packetId, detail.week, preparedAt, items, answerSheet)), packetId);
    }

    const final = buildSnapshot(packetId, detail.week, preparedAt, items, answerSheet);
    // 收尾一个事务：快照 ready + 包 generated（generated_at 仅首次）+ scheduled 题转 packet_generated。
    db.exec('BEGIN');
    try {
      db.prepare("UPDATE v2_print_snapshot SET status = 'ready', progress_done = ?, progress_total = ?, snapshot_json = ?, error = NULL, ready_at = ? WHERE packet_id = ?")
        .run(total, total, JSON.stringify(final), now(), packetId);
      const cancelled=db.prepare("SELECT 1 FROM practice_task WHERE packet_id=? AND lifecycle='cancelled'").get(packetId);
      if(!cancelled){
        db.prepare("UPDATE review_packet SET status = 'generated', generated_at = COALESCE(generated_at, ?) WHERE id = ?")
          .run(now(), packetId);
        for (const card of detail.items) {
          db.prepare("UPDATE error_item SET status = 'packet_generated', updated_at = ? WHERE id = ? AND status = 'scheduled'")
            .run(now(), card.id);
        }
      }
      db.exec('COMMIT');
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK');
      throw error;
    }
    audit('v2_print_ready', 'packet', packetId);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    getDb().prepare("UPDATE v2_print_snapshot SET status = 'failed', error = ? WHERE packet_id = ?").run(message, packetId);
    audit('v2_print_failed', 'packet', packetId);
  }
}

/** 没有在进行中就启动后台准备；已有的部分进度会被沿用。 */
function ensurePreparing(packetId: string, coach?: CoachProvider): void {
  if (preparing.has(packetId)) return;
  const task = prepare(packetId, coach ?? getCoachProvider()).finally(() => {
    preparing.delete(packetId);
  });
  preparing.set(packetId, task);
}

/** 服务启动时调用：续做所有 preparing 状态的快照（已完成的题不重做）。 */
export function resumePendingSnapshots(coach?: CoachProvider): void {
  const rows = getDb().prepare("SELECT packet_id FROM v2_print_snapshot WHERE status = 'preparing'").all() as Array<{ packet_id: string }>;
  for (const row of rows) ensurePreparing(row.packet_id, coach);
}

export type PrintRequestResult =
  | { httpStatus: 202; body: { status: 'preparing' } }
  | { httpStatus: 200; body: Record<string, unknown> }
  | { httpStatus: 404 };

/** POST /v2/practice/:id/print：没有快照则创建并后台准备（202）；已有返回当前状态（200）。幂等。 */
export function requestPrint(packetId: string, coach?: CoachProvider): PrintRequestResult {
  if (!getPractice(packetId)) return { httpStatus: 404 };
  const db = getDb();
  if(db.prepare("SELECT 1 FROM practice_task WHERE packet_id=? AND lifecycle='cancelled'").get(packetId)){
    const prior=rowOf(packetId);
    if(prior?.status==='ready')return {httpStatus:200,body:{status:'ready',snapshot:JSON.parse(prior.snapshot_json!)}};
    return {httpStatus:200,body:{status:'failed',error:'这份练习已取消'}};
  }
  const row = rowOf(packetId);
  if (!row) {
    db.prepare("INSERT INTO v2_print_snapshot (packet_id, status, progress_done, progress_total, created_at) VALUES (?, 'preparing', 0, ?, ?)")
      .run(packetId, getPractice(packetId)!.items.length, now());
    ensurePreparing(packetId, coach);
    return { httpStatus: 202, body: { status: 'preparing' } };
  }
  if (row.status === 'ready') {
    return { httpStatus: 200, body: { status: 'ready', snapshot: JSON.parse(row.snapshot_json!) } };
  }
  if (row.status === 'failed') {
    // 失败后允许重试：保留部分进度续做。
    db.prepare("UPDATE v2_print_snapshot SET status = 'preparing', error = NULL WHERE packet_id = ?").run(packetId);
    ensurePreparing(packetId, coach);
    return { httpStatus: 202, body: { status: 'preparing' } };
  }
  // preparing：重启后进程内任务可能不在，这里兜底续上。
  ensurePreparing(packetId, coach);
  return { httpStatus: 200, body: { status: 'preparing' } };
}

export type PrintStatusResult =
  | { httpStatus: 200; body: Record<string, unknown> }
  | { httpStatus: 404 };

/** GET /v2/practice/:id/print：状态 + 进度；ready 时附快照。 */
export function getPrintStatus(packetId: string): PrintStatusResult {
  const detail = getPractice(packetId);
  if (!detail) return { httpStatus: 404 };
  const row = rowOf(packetId);
  if (!row) {
    return { httpStatus: 200, body: { status: 'none', progress: { done: 0, total: detail.items.length } } };
  }
  const body: Record<string, unknown> = {
    status: row.status,
    progress: { done: row.progress_done, total: row.progress_total },
  };
  if (row.status === 'ready') body.snapshot = JSON.parse(row.snapshot_json!);
  if (row.status === 'failed') body.error = row.error;
  return { httpStatus: 200, body };
}

const MEDIA_NAME = /^[a-z0-9][a-z0-9.-]*\.jpg$/;

/** GET /v2/practice/:id/print/media/:name：只返回快照登记过的图片；未登记 404。 */
export function readPrintMedia(packetId: string, name: string): Buffer | null {
  if (!getPractice(packetId)) return null;
  if (!MEDIA_NAME.test(name)) return null;
  const row = rowOf(packetId);
  if (!row?.snapshot_json) return null;
  const snapshot = JSON.parse(row.snapshot_json) as PrintSnapshot;
  const registered = new Set<string>();
  for (const item of snapshot.items) {
    if (item.cropMedia) registered.add(item.cropMedia);
    for (const media of item.diagramMedia) registered.add(media);
  }
  if (!registered.has(name)) return null;
  try {
    return fs.readFileSync(path.join(packetsDir(), packetId, name));
  } catch {
    return null;
  }
}
