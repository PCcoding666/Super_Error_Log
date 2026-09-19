import type { Box } from '../media/images.js';
import type { Evidence } from '../ai/evidence.js';
import type { InventoryCandidate } from './vision.js';

/**
 * Plan 2026-09-20 Task 1: model-conversation-layer box decoding.
 *
 * The production prompts now ask the model for its native coordinate vocabulary —
 * 0–1000 integer diagonal corners {x1,y1,x2,y2} (Qwen-VL grounding convention, see
 * docs/quality/bbox-experiment-20260920/REPORT.md). Legacy responses may still use the
 * old 0–1 fractional {x,y,width,height}. This decoder accepts both and always emits
 * the 0–1 xywh contract box used by storage, the API, iOS rendering and PDF cropping.
 *
 * Schema detection is field-level: a single field > 1 marks that field as a
 * 0–1000 integer and it is divided by 1000; fields ≤ 1 keep their value.
 * Mixed conventions (one field 192, another 0.148) therefore resolve correctly
 * under both hypotheses — 0.148 is 148/1000 in the 0–1000 vocabulary, and
 * unchanged in the 0–1 vocabulary. Values are clamped into [0,1] after
 * conversion instead of hard-failing — an overflowing corner is a repairable
 * coordinate, not a rejected attempt.
 */

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Field-level schema detection: a field > 1 can only be a 0–1000 integer
 * (fractional xywh cannot exceed 1), so it is divided by 1000; a field ≤ 1 is
 * kept as-is. Mixed conventions (model wrote 192 but 0.148 in the same box)
 * resolve correctly under both hypotheses — 0.148 means 148/1000 either way.
 * Never multiplies a small value by 1000 (that would be silent double scaling).
 */
function fromModelField(value: number): number {
  return value > 1 ? value / 1000 : value;
}

/** Stabilizes diagonal→xywh subtraction against binary floating-point tails. */
const round6 = (value: number): number => Math.round(value * 1e6) / 1e6;

export function decodeModelBox(raw: unknown): Box {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('box must be an object');
  const data = raw as Record<string, unknown>;
  const x1 = finiteNumber(data.x1); const y1 = finiteNumber(data.y1); const x2 = finiteNumber(data.x2); const y2 = finiteNumber(data.y2);
  if (x1 !== null && y1 !== null && x2 !== null && y2 !== null) {
    const clamp01 = (value: number) => Math.min(1, Math.max(0, value));
    // Round the EDGES first, then derive width/height from the rounded edges:
    // x + width then equals the rounded right edge in real arithmetic, so the
    // float sum can never overshoot 1 the way independently-rounded values can
    // (double round-up used to accumulate up to 1e-6 and hard-fail validateBox).
    const left = round6(clamp01(fromModelField(x1)));
    const top = round6(clamp01(fromModelField(y1)));
    const right = round6(clamp01(fromModelField(x2)));
    const bottom = round6(clamp01(fromModelField(y2)));
    if (right <= left || bottom <= top) throw new Error('box corners are degenerate');
    return { x: left, y: top, width: round6(right - left), height: round6(bottom - top) };
  }
  // Legacy 0–1 xywh passthrough: strict validation rejects out-of-range shapes.
  return validateLegacyXYWH(raw);
}

function validateLegacyXYWH(value: unknown): Box {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('box must be an object');
  const data = value as Record<string, unknown>;
  const x = finiteNumber(data.x); const y = finiteNumber(data.y);
  const width = finiteNumber(data.width); const height = finiteNumber(data.height);
  if (x === null || y === null || width === null || height === null) throw new Error('box must be an object');
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1) throw new Error('box out of range');
  return { x, y, width, height };
}

/**
 * Legacy 0–1 xywh boxes that spill past the image edge (x+width > 1) are clamped
 * instead of rejected — an overflowing evidence box is the observed 2026-09-18 27b
 * Q12 failure mode and is repairable. Boxes entirely outside (x >= 1) stay untouched
 * so validateEvidence still rejects genuine garbage.
 */
function clampLegacyOverflow(box: Record<string, unknown>): Record<string, unknown> {
  const x = finiteNumber(box.x); const y = finiteNumber(box.y);
  const width = finiteNumber(box.width); const height = finiteNumber(box.height);
  if (x === null || y === null || width === null || height === null) return box;
  const next: Record<string, unknown> = { ...box };
  let changed = false;
  if (x < 1 && x + width > 1 + 1e-9) { next.width = 1 - x; changed = true; }
  if (y < 1 && y + height > 1 + 1e-9) { next.height = 1 - y; changed = true; }
  return changed ? next : box;
}

/**
 * Rewrites 0–1000 diagonal-corner boxes in a raw evidence document (questionRegion +
 * regions[].box) into the legacy 0–1 xywh shape before validateEvidence sees them,
 * so the shared evidence contract and every downstream consumer stay untouched.
 * Overflowing legacy boxes are clamped here. Unknown shapes pass through unchanged
 * for validateEvidence to reject with its own field-level messages.
 */
export function decodeModelEvidence(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const data = structuredClone(value) as Record<string, unknown>;
  const rewrite = (raw: unknown): unknown => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
    const box = raw as Record<string, unknown>;
    if (box.x1 !== undefined || box.y1 !== undefined || box.x2 !== undefined || box.y2 !== undefined) {
      try { return decodeModelBox(box); } catch { return raw; }
    }
    return clampLegacyOverflow(box);
  };
  if (data.questionRegion !== undefined) data.questionRegion = rewrite(data.questionRegion);
  if (Array.isArray(data.regions)) data.regions = (data.regions as unknown[]).map(region =>
    region && typeof region === 'object' && !Array.isArray(region)
      ? { ...(region as Record<string, unknown>), box: rewrite((region as Record<string, unknown>).box) }
      : region);
  return data;
}

/**
 * Outgoing direction: rewrites 0–1 xywh boxes (candidate boxes, evidence
 * documents) into the 0–1000 diagonal-corner vocabulary before they are
 * JSON.stringify'd into model-facing prompt text, so the conversation speaks
 * one coordinate language end-to-end. Round-trip safe: decode(encode(box))
 * recovers the box within round6 tolerance.
 */
export function encodeModelBox(box: Box): { x1: number; y1: number; x2: number; y2: number } {
  return { x1: Math.round(box.x * 1000), y1: Math.round(box.y * 1000), x2: Math.round((box.x + box.width) * 1000), y2: Math.round((box.y + box.height) * 1000) };
}

export function encodeModelCandidate(candidate: InventoryCandidate): Record<string, unknown> {
  const { box, ...rest } = candidate;
  return { ...rest, box: encodeModelBox(box) };
}

export function encodeModelEvidence(evidence: Evidence): Record<string, unknown> {
  return {
    ...evidence,
    questionRegion: encodeModelBox(evidence.questionRegion),
    regions: evidence.regions.map(region => ({ ...region, box: encodeModelBox(region.box) })),
  };
}

/**
 * Plan 2026-09-20 Task 2: post-decode reconciliation of the model's
 * questionRegion against the inventory candidate box.
 *
 * Domain rules (AI proposes, student verifies — never silently replaced):
 * - IoU < 0.1 between model box and candidate → the model box is PRESERVED but a
 *   "定位漂移" warning is recorded for the verifier and the student.
 * - An overflowing box (x+width > 1 or y+height > 1 in legacy 0–1 vocabulary) is
 *   clamped into the image instead of hard-failing invalid_output — this is the
 *   observed 2026-09-18 27b Q12 failure mode.
 * - Height inflation > 3× the candidate height is clamped to 2× with a warning —
 *   the model dragged a neighbouring question into the crop.
 */
export interface ReconciledBox { box: Box; warnings: string[] }

function intersectionArea(a: Box, b: Box): number {
  const left = Math.max(a.x, b.x); const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width); const bottom = Math.min(a.y + a.height, b.y + b.height);
  return Math.max(0, right - left) * Math.max(0, bottom - top);
}

function iou(a: Box, b: Box): number {
  const union = a.width * a.height + b.width * b.height - intersectionArea(a, b);
  return union > 0 ? intersectionArea(a, b) / union : 0;
}

const round6Box = (box: Box): Box => ({
  x: Math.round(box.x * 1e6) / 1e6, y: Math.round(box.y * 1e6) / 1e6,
  width: Math.round(box.width * 1e6) / 1e6, height: Math.round(box.height * 1e6) / 1e6,
});

export function reconcileBox(modelBox: Box, candidateBox: Box): ReconciledBox {
  const warnings: string[] = [];
  let box = modelBox;
  // 1. Clamp overflow into the image (legacy 0-1 vocabulary still slips through decode
  //    for genuinely out-of-range shapes that validateBox would reject wholesale).
  const maxX = Math.min(1, box.x + box.width); const maxY = Math.min(1, box.y + box.height);
  if (maxX < box.x + box.width || maxY < box.y + box.height) {
    box = { ...box, width: maxX - box.x, height: maxY - box.y };
    warnings.push('题目区域越界，已按图片边界裁剪。');
  }
  // 2. Height-inflation clamp (> 3x candidate height → 2x, keep the vertical center).
  if (box.height > 3 * candidateBox.height) {
    const capped = 2 * candidateBox.height;
    const centerY = box.y + box.height / 2;
    const top = Math.max(0, centerY - capped / 2);
    const bottom = Math.min(1, centerY + capped / 2);
    box = { ...box, y: top, height: bottom - top };
    warnings.push('题目区域高度异常膨胀，已收窄并保留校验。');
  }
  // 3. IoU drift detection AFTER geometric repairs (compare the final crop box).
  if (iou(box, candidateBox) < 0.1) warnings.push('题目区域与候选定位漂移，请核对裁图是否为本题。');
  return { box: round6Box(box), warnings };
}
