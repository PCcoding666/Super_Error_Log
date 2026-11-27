/**
 * The gateway forces `private, no-store` on student responses. Hash-addressed
 * display JPEGs are the exception: the worker already marked them private and
 * immutable, and the URL carries both the size and the content hash.
 * Raw originals stay no-store.
 */
const DISPLAY_PATH = /^\/(?:materials\/assets\/[^/]+\/image|materials\/fragments\/[^/]+\/crop|api\/intake\/candidates\/[^/]+\/crop)$/;

export function displayImageCacheAllowed(pathname: string, query: { s?: unknown; v?: unknown }, upstreamCacheControl: string): boolean {
  if (query.s !== 'thumb' && query.s !== 'list' && query.s !== 'big') return false;
  if (typeof query.v !== 'string' || !/^[a-f0-9]{16,64}$/i.test(query.v)) return false;
  if (!DISPLAY_PATH.test(pathname)) return false;
  return /^private,\s*max-age=\d+,\s*immutable$/i.test(upstreamCacheControl.trim());
}
