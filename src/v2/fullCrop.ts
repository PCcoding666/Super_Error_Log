/**
 * T4f：整题大图（GET /v2/items/:id/crop?scope=full）。
 * 学生在"不对，改一下"里要核对"你的作答 / 订正 / 老师批注"有没有认错，
 * 只含题干的 crop 看不到手写部分。整题大图 = 题目区域与全部证据区域的并集，
 * 用打印同款余量外扩（expandPrintCropMargin），裁到页面边界内，不遮白（给学生本人核对用）。
 */
import fs from 'node:fs';
import type { Evidence } from '../ai/evidence.js';
import { cropPhoto, type Box } from '../media/images.js';
import { getEvidence, evidenceSource } from '../services/evidenceService.js';
import { expandPrintCropMargin } from './printService.js';

/** 整题大图区域：questionRegion 与所有 regions 的 box 的并集，经 expandPrintCropMargin 外扩。 */
export function fullItemRegion(evidence: Evidence): Box {
  let x1 = evidence.questionRegion.x;
  let y1 = evidence.questionRegion.y;
  let x2 = evidence.questionRegion.x + evidence.questionRegion.width;
  let y2 = evidence.questionRegion.y + evidence.questionRegion.height;
  for (const region of evidence.regions) {
    x1 = Math.min(x1, region.box.x);
    y1 = Math.min(y1, region.box.y);
    x2 = Math.max(x2, region.box.x + region.box.width);
    y2 = Math.max(y2, region.box.y + region.box.height);
  }
  return expandPrintCropMargin({ x: x1, y: y1, width: x2 - x1, height: y2 - y1 });
}

/** 整题大图 JPEG（质量 88，与 cropPhoto 一致）；原图读不到即抛错（路由转 404）。 */
export async function getItemFullCrop(itemId: string): Promise<Buffer> {
  const record = getEvidence(itemId); if (!record) throw new Error('题目不存在');
  return cropPhoto(fs.readFileSync(evidenceSource(itemId).storagePath), fullItemRegion(record.content));
}
