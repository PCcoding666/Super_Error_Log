import { describe, expect, it } from 'vitest';
import { CaptureSession, hintsForPages, MAX_SET_PAGES } from '../../client/src/lib/captureSession.js';
import { assertCaptureSet, holdsExtract, readCaptureSet } from '../../src/materials/captureHints.js';
import { MobileRequestError } from '../../src/mobile/service.js';

describe('capture mode', () => {
  it('keeps a multi-page tray in order, drops the extra page, and tags paper or answer sheet', () => {
    const session = new CaptureSession();
    expect(session.mode).toBe('single');
    session.setMode('multi');
    const files = Array.from({ length: MAX_SET_PAGES + 1 }, (_, index) => new File([`page-${index}`], `page-${index}.jpg`, { type: 'image/jpeg' }));
    expect(session.add(files)).toBe(1);
    expect(session.pages).toHaveLength(MAX_SET_PAGES);
    expect(session.overflow).toBe(true);
    session.setKind(session.pages[0]!.id, 'paper');
    session.setKind(session.pages[1]!.id, 'answer_sheet');
    session.remove(session.pages[2]!.id);
    expect(session.overflow).toBe(false);
    const taken = session.take();
    expect(session.pages).toEqual([]);
    const hints = hintsForPages(taken);
    expect(hints).toHaveLength(MAX_SET_PAGES - 1);
    expect(hints[0]).toEqual({ captureMode: 'multi', pageIndex: 1, pageCount: hints.length, pageKind: 'paper' });
    expect(hints[1]).toMatchObject({ captureMode: 'multi', pageIndex: 2, pageKind: 'answer_sheet' });
    expect(hints[2]).toEqual({ captureMode: 'multi', pageIndex: 3, pageCount: hints.length });
    expect(hints.at(-1)).toMatchObject({ pageIndex: hints.length, pageCount: hints.length });
    session.add([new File(['again'], 'again.jpg', { type: 'image/jpeg' })]);
    session.discard();
    expect(session.pages).toEqual([]);
  });

  it('accepts a single page or a numbered multi-page set and rejects a set that cannot be ordered', () => {
    expect(readCaptureSet({})).toEqual({});
    expect(readCaptureSet({ captureMode: 'single' })).toEqual({ captureMode: 'single' });
    expect(readCaptureSet({ captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' })).toEqual({ captureMode: 'multi', pageIndex: 2, pageCount: 2, pageKind: 'answer_sheet' });
    expect(holdsExtract({ captureMode: 'multi', pageIndex: 1, pageCount: 2 })).toBe(true);
    expect(holdsExtract({ captureMode: 'single' })).toBe(false);
    expect(holdsExtract({ captureMode: 'multi', pageIndex: 1, pageCount: 1 })).toBe(false);
    expect(() => assertCaptureSet([{ captureMode: 'multi', pageIndex: 1, pageCount: 2 }], { captureMode: 'multi', pageIndex: 1, pageCount: 2 })).toThrow(MobileRequestError);
    expect(() => assertCaptureSet([{ captureMode: 'multi', pageIndex: 1, pageCount: 2 }], { captureMode: 'multi', pageIndex: 2, pageCount: 3 })).toThrow(MobileRequestError);
    expect(() => assertCaptureSet([{ captureMode: 'multi', pageIndex: 1, pageCount: 2 }], { captureMode: 'single' })).toThrow(MobileRequestError);
    expect(() => assertCaptureSet([{ captureMode: 'multi', pageIndex: 1, pageCount: 2 }], {})).toThrow(MobileRequestError);
    assertCaptureSet([{ captureMode: 'multi', pageIndex: 1, pageCount: 2 }], { captureMode: 'multi', pageIndex: 2, pageCount: 2 });
    for (const value of [
      { captureMode: 'multi' },
      { captureMode: 'multi', pageCount: 2 },
      { captureMode: 'multi', pageIndex: 3, pageCount: 2 },
      { captureMode: 'multi', pageIndex: 1, pageCount: 9 },
      { captureMode: 'single', pageKind: 'paper' },
      { captureMode: 'film' },
      { pageKind: 'answer_sheet' },
    ]) expect(() => readCaptureSet(value)).toThrow(MobileRequestError);
  });
});
