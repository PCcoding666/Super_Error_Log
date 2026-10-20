import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { normalizePhoto, validateBox } from '../media/images.js';
import type { Fragment, SourceRegion } from './contracts.js';
import type { MaterialStore } from './store.js';
export const PRINT_IMAGE_LIMITS = { regions: 32, pixels: 24000000, bytes: 16 * 1024 * 1024 } as const;
/** Hashes identify original bytes in all three layouts: direct legacy files,
 * material uploads, and the mobile store's original beside job.json. A mobile
 * derivative is resolved only through the owned link and matching persisted job media. */
export function readSourceBytes(store: MaterialStore, region: Pick<SourceRegion, 'assetId' | 'sourceHash'>): Buffer {
    const row = store.db.prepare(`SELECT s.id AS source_asset_id,s.storage_path,s.content_hash,a.upload_request_id,a.status FROM material_asset a
    JOIN source_asset s ON s.id=a.source_asset_id JOIN source_batch b ON b.id=s.batch_id
    WHERE a.owner_id=? AND b.student_id=? AND a.id=?`).get(store.studentId, store.studentId, region.assetId) as {
        source_asset_id: string;
        storage_path: string;
        content_hash: string;
        upload_request_id: string | null;
        status: string;
    } | undefined;
    // A genuine legacy Evidence need not have been backfilled yet.
    const legacy = !row ? store.db.prepare(`SELECT s.id AS source_asset_id,s.storage_path,s.content_hash FROM source_asset s
    JOIN source_batch b ON b.id=s.batch_id WHERE s.id=? AND b.student_id=?`).get(region.assetId, store.studentId) as {
        source_asset_id: string;
        storage_path: string;
        content_hash: string;
    } | undefined : undefined;
    const source = row ?? legacy;
    if (!source || source.content_hash !== region.sourceHash)
        throw new Error('原图来源 hash 已变化或不存在');
    let filename = row?.upload_request_id && row.status !== 'legacy' ? path.join(path.dirname(row.storage_path), 'original') : source.storage_path;
    if (!(row?.upload_request_id && row.status !== 'legacy') && path.basename(path.dirname(source.storage_path)) === 'media') {
        const directory = path.dirname(path.dirname(source.storage_path));
        const link = store.db.prepare(`SELECT m.job_id FROM mobile_item_link m JOIN error_item i ON i.id=m.item_id
          WHERE i.student_id=? AND i.asset_id=? AND m.job_id=?`).get(store.studentId, source.source_asset_id, path.basename(directory)) as { job_id:string } | undefined;
        if (link) {
            const job = JSON.parse(fs.readFileSync(path.join(directory, 'job.json'), 'utf8')) as {
                id:string; sourceHash:string; sourceMediaId:string; media:Record<string,{filename:string;kind:string}>;
            };
            const media = job.media?.[job.sourceMediaId];
            if (job.id !== link.job_id || job.sourceHash !== region.sourceHash || !media || media.kind !== 'source'
                || path.basename(media.filename) !== media.filename
                || path.resolve(directory, 'media', media.filename) !== path.resolve(source.storage_path)) {
                throw new Error('原图任务来源与记录不一致');
            }
            // This is the persisted MobileRecognitionStore format, never a hash bypass
            // or fallback to normalized pixels when its preserved original is missing.
            filename = path.join(directory, 'source-original.jpg');
        }
    }
    const stat = fs.statSync(filename);
    if (stat.size > 15 * 1024 * 1024)
        throw new Error('原图超过 15 MiB 限制');
    const bytes = fs.readFileSync(filename);
    if (createHash('sha256').update(bytes).digest('hex') !== region.sourceHash)
        throw new Error('原图 hash 核对失败');
    return bytes;
}
export async function readNormalizedSource(store: MaterialStore, region: SourceRegion): Promise<Buffer> {
    const bytes = readSourceBytes(store, region);
    const normalized = await normalizePhoto(bytes);
    const result = await sharp(normalized).resize({ width: 4096, height: 4096, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    // File reads and sharp processing may yield. Never publish using a replaced source.
    readSourceBytes(store, region);
    return result;
}
export async function readFragmentImage(store: MaterialStore, fragmentId: string, revision: number): Promise<Buffer> {
    const row = store.db.prepare('SELECT content_json FROM material_fragment WHERE owner_id=? AND id=? AND revision=?').get(store.studentId, fragmentId, revision) as {
        content_json: string;
    } | undefined;
    if (!row)
        throw new Error('材料片段版本不存在');
    const fragment = JSON.parse(row.content_json) as Fragment;
    const box = validateBox(fragment.box), source = await readNormalizedSource(store, fragment), meta = await sharp(source).metadata();
    const width = meta.width!, height = meta.height!;
    const left = Math.min(width - 1, Math.floor(box.x * width)), top = Math.min(height - 1, Math.floor(box.y * height));
    const right = Math.min(width, Math.ceil((box.x + box.width) * width)), bottom = Math.min(height, Math.ceil((box.y + box.height) * height));
    const result = await sharp(source).extract({ left, top, width: right - left, height: bottom - top }).jpeg({ quality: 88 }).toBuffer();
    readSourceBytes(store, fragment);
    return result;
}
