import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { captureEntryAction, keepsPickedFilesInTray, showCaptureModeBar } from '../../client/src/lib/captureEntry.js';

describe('capture entry', () => {
  it('hides the mode bar until a materials tray exists, and asks before the first shot', () => {
    expect(showCaptureModeBar(null, 0)).toBe(false);
    expect(showCaptureModeBar('legacy', 0)).toBe(false);
    expect(showCaptureModeBar('legacy', 2)).toBe(false);
    expect(showCaptureModeBar('materials', 0)).toBe(false);
    expect(showCaptureModeBar('materials', 1)).toBe(true);

    expect(captureEntryAction(null, 0, 'multi')).toBe('direct');
    expect(captureEntryAction('legacy', 0, 'single')).toBe('direct');
    expect(captureEntryAction('materials', 0, 'single')).toBe('choice');
    expect(captureEntryAction('materials', 0, 'multi')).toBe('choice');
    expect(captureEntryAction('materials', 2, 'multi')).toBe('direct');
    expect(captureEntryAction('materials', 2, 'single')).toBe('held');
  });

  it('keeps an open set together and uploads a single page only when the tray is empty', () => {
    expect(keepsPickedFilesInTray(0, 'single')).toBe(false);
    expect(keepsPickedFilesInTray(0, 'multi')).toBe(true);
    expect(keepsPickedFilesInTray(2, 'multi')).toBe(true);
    expect(keepsPickedFilesInTray(2, 'single')).toBe(true);
  });

  it('does not open the capture picker by calling click() on an input', () => {
    const source = ['components/CaptureDock.tsx', 'components/CaptureInput.tsx', 'pages/HomePage.tsx', 'pages/IntakePage.tsx']
      .map(name => readFileSync(path.resolve('client/src', name), 'utf8'))
      .join('\n');
    expect(source).not.toMatch(/\.click\s*\(/);
  });
});
