import fs from 'node:fs';
import path from 'node:path';
import { chromium } from '@playwright/test';
import { packetsDir } from '../config.js';
import { getDb, now } from '../db/connection.js';
import { audit } from './eventLog.js';
import { getPacket, packetItems } from './planService.js';
import { buildPacketHtml, type PacketHtml, type PacketPrintItem } from './printPacket.js';
import { getProfile } from './studentService.js';
import { diagramPath, getEvidence, assertEvidenceReady } from './evidenceService.js';
import { isDemoAsset } from './assetOrigin.js';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

function loadImageDataUrl(storagePath: string): string | null {
  const ext = path.extname(storagePath).toLowerCase();
  const mime = MIME_BY_EXT[ext];
  if (!mime) return null; // PDF 原图不内嵌（MVP：真实模式 PDF 逐页转图为后续增强）
  try {
    const buf = fs.readFileSync(storagePath);
    if (buf.length > 8 * 1024 * 1024) return null;
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

export function buildPacketPrintData(packetId: string): (PacketHtml & { itemCount: number }) | null {
  const packet = getPacket(packetId);
  if (!packet) return null;
  const db = getDb();
  const items = packetItems(packetId);
  const profile = getProfile();

  const printItems: PacketPrintItem[] = items.map((it) => {
    const evidence = getEvidence(it.id);
    if (evidence) {
      assertEvidenceReady(it.id, evidence);
      const diagramDataUrls = evidence.content.regions.flatMap((region, index) => {
        if (region.kind !== 'diagram') return [];
        const image = loadImageDataUrl(diagramPath(it.id, evidence.revision, index));
        if (!image) throw new Error('已确认的图示缓存不可用，请重新校对后打印');
        return [image];
      });
      return { ...it, text_excerpt: evidence.content.questionText, imageDataUrl: null, diagramDataUrls };
    }
    if (!isDemoAsset(it.asset_id)) throw new Error('旧真实条目缺少可核验题面，请重新提取并校对；不能打印整张原答案页');
    const asset = db.prepare('SELECT storage_path FROM source_asset WHERE id = ?').get(it.asset_id) as
      | { storage_path: string }
      | undefined;
    return { ...it, imageDataUrl: asset ? loadImageDataUrl(asset.storage_path) : null };
  });

  const html = buildPacketHtml({ packet, items: printItems, nickname: profile?.nickname ?? '同学' });
  return { ...html, itemCount: items.length };
}

export async function generatePacketPdf(packetId: string): Promise<{ ok: boolean; path?: string; error?: string }> {
  let data;
  try { data = buildPacketPrintData(packetId); }
  catch (e) { return { ok: false, error: e instanceof Error ? e.message : '题面校验失败' }; }
  if (!data) return { ok: false, error: '复习包不存在' };
  if (data.itemCount === 0) return { ok: false, error: '复习包为空' };
  const packet = getPacket(packetId)!;
  if (packet.status !== 'scheduled' && packet.status !== 'generated') {
    return { ok: false, error: '当前状态不可重新生成 PDF' };
  }

  const outPath = path.join(packetsDir(), `packet_${packetId}.pdf`);
  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setContent(data.fullHtml, { waitUntil: 'load' });
    await page.pdf({
      path: outPath,
      format: 'A4',
      printBackground: false,
      margin: { top: '15mm', bottom: '15mm', left: '15mm', right: '15mm' },
    });
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await browser?.close();
  }

  const db = getDb();
  db.prepare("UPDATE review_packet SET status = 'generated', pdf_path = ?, generated_at = COALESCE(generated_at, ?) WHERE id = ?").run(outPath, now(), packetId);
  db.prepare(
    `UPDATE error_item SET status = 'packet_generated', updated_at = ?
     WHERE status = 'scheduled' AND id IN (SELECT item_id FROM review_packet_item WHERE packet_id = ?)`,
  ).run(now(), packetId);
  audit('packet_generated', 'packet', packetId);
  return { ok: true, path: outPath };
}
