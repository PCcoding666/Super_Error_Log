import { MobileRequestError } from '../mobile/service.js';
import type { CaptureHints, CapturePageKind } from './contracts.js';

function bad(): never { throw new MobileRequestError(400, 'invalid_request', '填写的内容不完整，请刷新后再试。'); }
function conflict(message: string): never { throw new MobileRequestError(409, 'set_conflict', message); }

/** One multi-page submission. Also the cap on images loaded for a combined locate. */
export const MAX_SET_PAGES = 8;
/** An unfinished multi-page set is extracted from the pages already stored after this long. */
export const SET_HOLD_MS = 10 * 60 * 1000;

export type CaptureSetMode = 'multi' | 'single' | 'unset';
export function captureSetMode(hints: CaptureHints): CaptureSetMode {
  if (hints.captureMode === 'multi') return 'multi';
  if (hints.captureMode === 'single') return 'single';
  return 'unset';
}

const PAGE_KINDS: CapturePageKind[] = ['paper', 'answer_sheet'];

function pageBound(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 8) bad();
  return value;
}

/** Capture mode rides in the existing hints JSON. It is not a new column. */
export function readCaptureSet(value: Record<string, unknown>): Pick<CaptureHints, 'captureMode' | 'pageIndex' | 'pageCount' | 'pageKind'> {
  const result: Pick<CaptureHints, 'captureMode' | 'pageIndex' | 'pageCount' | 'pageKind'> = {};
  if (value.captureMode !== undefined) {
    if (value.captureMode !== 'single' && value.captureMode !== 'multi') bad();
    result.captureMode = value.captureMode;
  }
  const pageIndex = pageBound(value.pageIndex);
  const pageCount = pageBound(value.pageCount);
  if (pageIndex !== undefined) result.pageIndex = pageIndex;
  if (pageCount !== undefined) result.pageCount = pageCount;
  if (value.pageKind !== undefined) {
    if (!PAGE_KINDS.includes(value.pageKind as CapturePageKind)) bad();
    result.pageKind = value.pageKind as CapturePageKind;
  }
  if (result.captureMode === 'multi') {
    if (!result.pageIndex || !result.pageCount || result.pageIndex > result.pageCount) bad();
  } else if (result.pageIndex || result.pageCount || result.pageKind) bad();
  return result;
}

/** A multi-page set waits until every page is stored, then one extract sees them together. */
export function holdsExtract(hints: CaptureHints): boolean {
  return hints.captureMode === 'multi' && (hints.pageCount ?? 0) > 1;
}

/**
 * A capture is entirely one kind of upload: old pages with no mode, all single, or all multi.
 * Multi pages share one pageCount, use each pageIndex once, and stop at 8.
 */
export function assertCaptureSet(existing: CaptureHints[], next: CaptureHints): void {
  const nextMode = captureSetMode(next);
  const modes = new Set(existing.map(captureSetMode));
  if (modes.size > 1) conflict('这一组照片的拍摄方式不一致。');
  const current = [...modes][0];
  if (current && current !== nextMode) conflict('这一组照片的拍摄方式不一致。');
  if (nextMode !== 'multi') return;
  const pageCount = next.pageCount ?? 0;
  if (existing.some(page => page.pageCount !== pageCount)) conflict('页数和已经上传的不一致。');
  if (existing.some(page => page.pageIndex === next.pageIndex)) conflict('这一页已经传过了。');
  if (existing.length >= pageCount || existing.length >= MAX_SET_PAGES) conflict('这一组的页已经齐了。');
}
