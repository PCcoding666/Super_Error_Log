import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPTURE_MODE_NOTE, captureEntryAction, pickedFileDestination, showCaptureModeBar } from '../../client/src/lib/captureEntry.js';

describe('capture entry', () => {
  it('keeps the pill note with the selected tab', () => {
    expect(CAPTURE_MODE_NOTE.single).toBe('一张纸拍完就用单页');
    expect(CAPTURE_MODE_NOTE.multi).toBe('试卷和答题卡不在同一张纸，或一道题的材料有好几页时，用多页');
  });

  it('opens the mode sheet before the first materials shot, and keeps the pill on an open tray', () => {
    expect(showCaptureModeBar(null, 0)).toBe(false);
    expect(showCaptureModeBar('legacy', 0)).toBe(false);
    expect(showCaptureModeBar('legacy', 2)).toBe(false);
    expect(showCaptureModeBar('materials', 0)).toBe(false);
    expect(showCaptureModeBar('materials', 1)).toBe(true);

    expect(captureEntryAction(null, 0, 'multi')).toBe('direct');
    expect(captureEntryAction('legacy', 0, 'single')).toBe('direct');
    expect(captureEntryAction('materials', 0, 'single')).toBe('sheet');
    expect(captureEntryAction('materials', 0, 'multi')).toBe('sheet');
    expect(captureEntryAction('materials', 2, 'multi')).toBe('direct');
    expect(captureEntryAction('materials', 2, 'single')).toBe('held');
  });

  it('does not let a stored multi mode stage a tray before the materials route is known', () => {
    expect(pickedFileDestination(null, undefined, 0)).toBe('upload');
    expect(pickedFileDestination(null, 'single', 0)).toBe('upload');
    expect(pickedFileDestination(null, 'multi', 0)).toBe('upload');
    expect(pickedFileDestination('legacy', 'multi', 0)).toBe('upload');
    expect(pickedFileDestination('legacy', undefined, 2)).toBe('upload');
    expect(pickedFileDestination('materials', undefined, 0)).toBe('upload');
    expect(pickedFileDestination('materials', 'single', 0)).toBe('upload');
    expect(pickedFileDestination('materials', 'multi', 0)).toBe('tray');
    expect(pickedFileDestination('materials', undefined, 2)).toBe('tray');
    expect(pickedFileDestination('materials', 'single', 2)).toBe('tray');
  });

  it('does not open the capture picker by calling click() on an input', () => {
    const source = ['components/CaptureDock.tsx', 'components/CaptureInput.tsx', 'pages/HomePage.tsx', 'pages/IntakePage.tsx']
      .map(name => readFileSync(path.resolve('client/src', name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/\.click\s*\(/);
  });
});
