import { MobileRequestError } from '../mobile/service.js';
import type { CaptureHints, CapturePageKind } from './contracts.js';

function bad(): never { throw new MobileRequestError(400, 'invalid_request', '填写的内容不完整，请刷新后再试。'); }

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
