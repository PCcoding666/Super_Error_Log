/** Client-safe display URL edits. The server puts `v` and `s` on the URL; the sheet only changes `s`. */

export type MaterialDisplaySize = 'thumb' | 'list' | 'big';

export function withDisplaySize(url: string | null, size: MaterialDisplaySize): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, 'http://local');
    parsed.searchParams.set('s', size);
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}

/** The preserved original. Drops the display size and the cache key, and does not fetch anything. */
export function originalImageUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url, 'http://local');
    parsed.searchParams.delete('s');
    parsed.searchParams.delete('v');
    const query = parsed.searchParams.toString();
    return `${parsed.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return url;
  }
}
