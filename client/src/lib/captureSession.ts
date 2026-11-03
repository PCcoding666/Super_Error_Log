import { useEffect, useState } from 'react';

/** One multi-page submission stays within the per-student extract queue. */
export const MAX_SET_PAGES = 8;
const MODE_KEY = 'sel-capture-mode';

export type CaptureMode = 'single' | 'multi';
export type PageKind = 'paper' | 'answer_sheet';
export interface CaptureUploadHints {
  captureMode: CaptureMode;
  pageIndex?: number;
  pageCount?: number;
  pageKind?: PageKind;
}
export interface StagedPage {
  id: string;
  name: string;
  file: File;
  previewUrl: string;
  kind: PageKind | null;
}

export function hintsForPages(pages: { kind: PageKind | null }[]): CaptureUploadHints[] {
  const pageCount = pages.length;
  return pages.map((page, index) => {
    const hints: CaptureUploadHints = { captureMode: 'multi', pageIndex: index + 1, pageCount };
    if (page.kind) hints.pageKind = page.kind;
    return hints;
  });
}

function storedMode(): CaptureMode {
  try {
    const value = globalThis.localStorage?.getItem(MODE_KEY);
    return value === 'multi' ? 'multi' : 'single';
  } catch { return 'single'; }
}

/** Pages the student has shot in multi mode and not yet submitted. */
export class CaptureSession {
  mode: CaptureMode = storedMode();
  pages: StagedPage[] = [];
  /** True after an add that did not fit. Cleared by the next add that fits. */
  overflow = false;
  private listeners = new Set<() => void>();

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private emit(): void { for (const listener of this.listeners) listener(); }
  setMode(mode: CaptureMode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    try { globalThis.localStorage?.setItem(MODE_KEY, mode); } catch { /* private mode */ }
    this.emit();
  }
  /** Returns how many files did not fit. */
  add(files: File[]): number {
    let rejected = 0;
    for (const file of files) {
      if (this.pages.length >= MAX_SET_PAGES) { rejected += 1; continue; }
      let previewUrl = '';
      try { previewUrl = URL.createObjectURL(file); } catch { previewUrl = ''; }
      this.pages.push({ id: crypto.randomUUID(), name: file.name || '照片', file, previewUrl, kind: null });
    }
    this.pages = [...this.pages];
    this.overflow = rejected > 0;
    this.emit();
    return rejected;
  }
  remove(id: string): void {
    const page = this.pages.find(item => item.id === id);
    if (page?.previewUrl) URL.revokeObjectURL(page.previewUrl);
    this.pages = this.pages.filter(item => item.id !== id);
    this.overflow = false;
    this.emit();
  }
  setKind(id: string, kind: PageKind | null): void {
    this.pages = this.pages.map(page => page.id === id ? { ...page, kind } : page);
    this.emit();
  }
  /** Hand the staged pages to the uploader and clear the tray. */
  take(): StagedPage[] {
    const pages = this.pages;
    this.pages = [];
    this.overflow = false;
    this.emit();
    for (const page of pages) if (page.previewUrl) URL.revokeObjectURL(page.previewUrl);
    return pages;
  }
}

export const captureSession = new CaptureSession();

export function useCaptureSession(): { mode: CaptureMode; pages: StagedPage[]; overflow: boolean } {
  const [snap, setSnap] = useState({ mode: captureSession.mode, pages: captureSession.pages, overflow: captureSession.overflow });
  useEffect(() => captureSession.subscribe(() => setSnap({ mode: captureSession.mode, pages: captureSession.pages, overflow: captureSession.overflow })), []);
  return snap;
}
