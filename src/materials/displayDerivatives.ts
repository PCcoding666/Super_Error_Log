/**
 * Display JPEGs for materials intake. Page `thumb.jpg` / `big.jpg` sit beside
 * `original` and `normalized.jpg`. Crops sit under `crops/<fragment>/<version>/`.
 * Box coordinates are relative to the normalized pixels, so derivatives are cut
 * from `normalized.jpg` after the preserved original still matches its hash.
 * The original file is never replaced. A missing derivative is written once;
 * later reads are the file and do not take the process-image permit.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { normalizePhoto, validateBox, type Box } from '../media/images.js';
import { withProcessImage } from '../mobile/admission.js';
import { MobileRequestError } from '../mobile/service.js';
import { renderDisplayJpeg, type DisplaySize } from '../web/images.js';
import type { Fragment } from './contracts.js';
import { readNormalizedSource, readSourceBytes } from './media.js';
import type { MaterialStore } from './store.js';

export const DISPLAY_CACHE_CONTROL = 'private, max-age=31536000, immutable';
export const PRIVATE_NO_STORE = 'private, no-store';
const CROP_SIZES = ['thumb', 'list', 'big'] as const;
const FRAGMENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

type Versioned = { sourceHash: string; revision: number; box: Box };

export function cropVersion(fragment: Versioned): string {
  return createHash('sha256')
    .update(`${fragment.sourceHash}\0${fragment.revision}\0${fragment.box.x}\0${fragment.box.y}\0${fragment.box.width}\0${fragment.box.height}`)
    .digest('hex')
    .slice(0, 32);
}

export function imageCacheControl(requested: unknown, actual: string, sized: boolean): string {
  if (sized && requested === actual && /^[a-f0-9]{16,64}$/i.test(actual)) return DISPLAY_CACHE_CONTROL;
  return PRIVATE_NO_STORE;
}

export function applyImageCache(response: { setHeader(name: string, value: string): void; removeHeader(name: string): void }, cacheControl: string): void {
  response.setHeader('cache-control', cacheControl);
  if (cacheControl.includes('immutable')) response.removeHeader('pragma');
}

export function fragmentCropUrl(fragment: Fragment, size: DisplaySize, route: 'materials' | 'preview' = 'materials'): string {
  const base = route === 'preview'
    ? `/s/api/intake/candidates/${encodeURIComponent(fragment.fragmentId)}/crop`
    : `/s/materials/fragments/${encodeURIComponent(fragment.fragmentId)}/crop`;
  const params = new URLSearchParams({ revision: String(fragment.revision), v: cropVersion(fragment), s: size });
  return `${base}?${params.toString()}`;
}

export function assetImageUrl(assetId: string, sourceHash: string | null, size: DisplaySize | null): string {
  const base = `/s/materials/assets/${encodeURIComponent(assetId)}/image`;
  if (!size || !sourceHash) return base;
  return `${base}?${new URLSearchParams({ v: sourceHash, s: size }).toString()}`;
}

type AssetFile = { storagePath: string; sourceHash: string };

function assetFile(store: MaterialStore, assetId: string): AssetFile {
  const row = store.db.prepare(`SELECT s.storage_path AS storagePath, s.content_hash AS sourceHash
    FROM material_asset a JOIN source_asset s ON s.id=a.source_asset_id
    WHERE a.owner_id=? AND a.id=?`).get(store.studentId, assetId) as AssetFile | undefined;
  if (!row) throw new MobileRequestError(404, 'not_found', '材料不存在。');
  return row;
}

function normalizedFile(storagePath: string): string {
  return path.basename(storagePath) === 'normalized.jpg' ? storagePath : path.join(path.dirname(storagePath), 'normalized.jpg');
}

function assetDirectory(storagePath: string): string {
  return path.dirname(normalizedFile(storagePath));
}

function pageFile(storagePath: string, size: DisplaySize): string {
  return path.join(assetDirectory(storagePath), `${size}.jpg`);
}

function cropDirectory(store: MaterialStore, fragment: Versioned & { assetId: string; fragmentId: string }): string {
  if (!FRAGMENT_ID.test(fragment.fragmentId)) throw new MobileRequestError(404, 'not_found', '材料片段版本不存在。');
  const file = assetFile(store, fragment.assetId);
  if (file.sourceHash !== fragment.sourceHash) throw new MobileRequestError(409, 'revision_conflict', '材料已更新。');
  return path.join(assetDirectory(file.storagePath), 'crops', fragment.fragmentId, cropVersion(fragment));
}

async function writeAtomic(filename: string, bytes: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
  const temp = path.join(path.dirname(filename), `.${path.basename(filename)}.${randomUUID()}.tmp`);
  const handle = await fsp.open(temp, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await handle.close().catch(() => undefined);
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await fsp.rename(temp, filename);
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function normalizedBytes(store: MaterialStore, assetId: string, sourceHash: string): Promise<Buffer> {
  const file = assetFile(store, assetId);
  if (file.sourceHash !== sourceHash) throw new MobileRequestError(409, 'revision_conflict', '材料已更新。');
  readSourceBytes(store, { assetId, sourceHash });
  const normalized = normalizedFile(file.storagePath);
  if (fs.existsSync(normalized)) return fs.readFileSync(normalized);
  return readNormalizedSource(store, { assetId, sourceHash });
}

async function cropNormalized(normalized: Buffer, boxValue: Box): Promise<Buffer> {
  const box = validateBox(boxValue);
  const metadata = await sharp(normalized, { limitInputPixels: 40_000_000 }).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error('Normalized image dimensions are unavailable');
  const left = Math.min(width - 1, Math.floor(box.x * width));
  const top = Math.min(height - 1, Math.floor(box.y * height));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((box.x + box.width) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((box.y + box.height) * height)));
  return sharp(normalized, { limitInputPixels: 40_000_000 })
    .extract({ left, top, width: right - left, height: bottom - top })
    .jpeg({ quality: 88 })
    .toBuffer();
}

function cropReady(store: MaterialStore, fragment: Fragment): boolean {
  try {
    const dir = cropDirectory(store, fragment);
    return CROP_SIZES.every(size => fs.existsSync(path.join(dir, `crop-${size}.jpg`)));
  } catch {
    return false;
  }
}

async function writeCrops(dir: string, full: Buffer): Promise<Record<DisplaySize, Buffer>> {
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await writeAtomic(path.join(dir, 'crop-full.jpg'), full);
  const rendered = {} as Record<DisplaySize, Buffer>;
  for (const size of CROP_SIZES) {
    rendered[size] = await renderDisplayJpeg(full, size);
    await writeAtomic(path.join(dir, `crop-${size}.jpg`), rendered[size]);
  }
  return rendered;
}

/** Best-effort. A failed write leaves extraction intact; the next GET fills the file. */
export async function persistFragmentCrops(store: MaterialStore, fragments: readonly Fragment[]): Promise<void> {
  const needed = fragments.filter(fragment => FRAGMENT_ID.test(fragment.fragmentId) && !cropReady(store, fragment));
  if (!needed.length) return;
  try {
    await withProcessImage(async () => {
      const byAsset = new Map<string, Fragment[]>();
      for (const fragment of needed) {
        if (cropReady(store, fragment)) continue;
        byAsset.set(fragment.assetId, [...(byAsset.get(fragment.assetId) ?? []), fragment]);
      }
      for (const [assetId, group] of byAsset) {
        let normalized: Buffer;
        try { normalized = await normalizedBytes(store, assetId, group[0]!.sourceHash); }
        catch { continue; }
        for (const fragment of group) {
          if (cropReady(store, fragment)) continue;
          try {
            await writeCrops(cropDirectory(store, fragment), await cropNormalized(normalized, fragment.box));
          } catch { /* filled on GET */ }
        }
      }
    });
  } catch { /* filled on GET */ }
}

export async function readCropDisplay(store: MaterialStore, fragment: Fragment, size: DisplaySize | null): Promise<Buffer> {
  const dir = cropDirectory(store, fragment);
  const name = size ? `crop-${size}.jpg` : 'crop-full.jpg';
  const file = path.join(dir, name);
  if (fs.existsSync(file)) return fs.readFileSync(file);
  return withProcessImage(async () => {
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const full = await cropNormalized(await normalizedBytes(store, fragment.assetId, fragment.sourceHash), fragment.box);
    const rendered = await writeCrops(dir, full);
    return size ? rendered[size] : full;
  });
}

export async function readPageDisplay(store: MaterialStore, assetId: string, size: DisplaySize | null): Promise<{ bytes: Buffer; type: string; version: string }> {
  const file = assetFile(store, assetId);
  if (!size) {
    const original = await readBrowserOriginal(store, assetId, file.sourceHash);
    return { bytes: original.bytes, type: original.type, version: file.sourceHash };
  }
  const derivative = pageFile(file.storagePath, size);
  if (fs.existsSync(derivative)) return { bytes: fs.readFileSync(derivative), type: 'image/jpeg', version: file.sourceHash };
  const bytes = await withProcessImage(async () => {
    if (fs.existsSync(derivative)) return fs.readFileSync(derivative);
    const rendered = await renderDisplayJpeg(await normalizedBytes(store, assetId, file.sourceHash), size);
    await writeAtomic(derivative, rendered);
    return rendered;
  });
  return { bytes, type: 'image/jpeg', version: file.sourceHash };
}

async function readBrowserOriginal(store: MaterialStore, assetId: string, sourceHash: string): Promise<{ bytes: Buffer; type: string }> {
  const bytes = readSourceBytes(store, { assetId, sourceHash });
  const meta = await sharp(bytes, { limitInputPixels: 40_000_000, failOn: 'none' }).metadata();
  if (meta.format === 'heif') {
    const normalized = normalizedFile(assetFile(store, assetId).storagePath);
    if (fs.existsSync(normalized)) return { bytes: fs.readFileSync(normalized), type: 'image/jpeg' };
    return { bytes: await normalizePhoto(bytes), type: 'image/jpeg' };
  }
  const type = meta.format === 'png' ? 'image/png' : meta.format === 'webp' ? 'image/webp' : 'image/jpeg';
  return { bytes, type };
}
