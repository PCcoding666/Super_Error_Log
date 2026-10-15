import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import sharp, { type Metadata } from 'sharp';

export type Box = {
  x: number;
  y: number;
  width: number;
  height: number;
};

const MAX_INPUT_BYTES = 15 * 1024 * 1024;
const MAX_DECODED_PIXELS = 40_000_000;
const JPEG_QUALITY = 88;
const SIPS_PATH = '/usr/bin/sips';
const SIPS_TIMEOUT_MS = 15_000;
const HEIF_BRANDS = new Set([
  'heic',
  'heix',
  'hevc',
  'hevx',
  'heim',
  'heis',
  'hevm',
  'hevs',
  'mif1',
  'msf1',
]);
const execFileAsync = promisify(execFile);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function validateBox(value: unknown): Box {
  if (!isRecord(value)) throw new Error('Crop box must be an object');

  const fields = ['x', 'y', 'width', 'height'] as const;
  for (const field of fields) {
    if (typeof value[field] !== 'number' || !Number.isFinite(value[field])) {
      throw new Error(`Crop box ${field} must be a finite number`);
    }
  }

  const box: Box = {
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
  if (box.x < 0 || box.y < 0) throw new Error('Crop box offsets cannot be negative');
  if (box.width <= 0 || box.height <= 0) throw new Error('Crop box dimensions must be positive');
  if (box.x + box.width > 1 || box.y + box.height > 1) {
    throw new Error('Crop box must stay within the image');
  }
  return box;
}

export function isHeif(buffer: Buffer): boolean {
  if (buffer.length < 16 || buffer.toString('ascii', 4, 8) !== 'ftyp') return false;

  const declaredSize = buffer.readUInt32BE(0);
  if (declaredSize !== 0 && (declaredSize < 16 || declaredSize > buffer.length)) return false;
  const boxEnd = declaredSize === 0 ? buffer.length : declaredSize;
  if (HEIF_BRANDS.has(buffer.toString('ascii', 8, 12))) return true;

  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    if (HEIF_BRANDS.has(buffer.toString('ascii', offset, offset + 4))) return true;
  }
  return false;
}

function assertInputSize(buffer: Buffer): void {
  if (buffer.length === 0) throw new Error('Image is empty');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('Image exceeds the 15 MB upload limit');
}

function assertDecodedSize(metadata: Metadata): void {
  const { width, height } = metadata;
  if (!width || !height) throw new Error('Image dimensions are unavailable');
  const pages = metadata.pages ?? 1;
  if (width * height * pages > MAX_DECODED_PIXELS) {
    throw new Error('Image exceeds the 40 megapixel decode limit');
  }
}

async function normalizeWithSharp(buffer: Buffer): Promise<Buffer> {
  const input = sharp(buffer, {
    failOn: 'error',
    limitInputPixels: MAX_DECODED_PIXELS,
  });
  const metadata = await input.metadata();
  if (!metadata.format || !['jpeg', 'png', 'webp', 'heif'].includes(metadata.format)) {
    throw new Error('Unsupported image format');
  }
  assertDecodedSize(metadata);
  return input.rotate().jpeg({ quality: JPEG_QUALITY }).toBuffer();
}

function parseSipsDimension(output: string, property: 'pixelWidth' | 'pixelHeight'): number {
  const match = output.match(new RegExp(`${property}:\\s*(\\d+)`));
  const value = match ? Number(match[1]) : Number.NaN;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`HEIF ${property} is unavailable`);
  }
  return value;
}

async function runSips(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync(SIPS_PATH, args, {
    encoding: 'utf8',
    timeout: SIPS_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

async function normalizeHeifWithSips(buffer: Buffer): Promise<Buffer> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sel-heif-'));
  const inputPath = path.join(directory, 'input.heic');
  const outputPath = path.join(directory, 'output.jpg');
  try {
    await fs.writeFile(inputPath, buffer, { flag: 'wx' });
    const { stdout } = await runSips(['-g', 'pixelWidth', '-g', 'pixelHeight', inputPath]);
    const width = parseSipsDimension(stdout, 'pixelWidth');
    const height = parseSipsDimension(stdout, 'pixelHeight');
    if (width * height > MAX_DECODED_PIXELS) {
      throw new Error('Image exceeds the 40 megapixel decode limit');
    }

    await runSips([
      '-s',
      'format',
      'jpeg',
      '-s',
      'formatOptions',
      String(JPEG_QUALITY),
      inputPath,
      '--out',
      outputPath,
    ]);
    const converted = await fs.readFile(outputPath);
    return normalizeWithSharp(converted);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

export async function normalizePhoto(buffer: Buffer): Promise<Buffer> {
  assertInputSize(buffer);
  try {
    return await normalizeWithSharp(buffer);
  } catch (error) {
    if (!isHeif(buffer)) throw error;
    if (process.platform !== 'darwin') {
      throw new Error('HEIF fallback requires macOS /usr/bin/sips', { cause: error });
    }
    return normalizeHeifWithSips(buffer);
  }
}

export async function cropPhoto(buffer: Buffer, boxValue: Box): Promise<Buffer> {
  const box = validateBox(boxValue);
  const normalized = await normalizePhoto(buffer);
  const metadata = await sharp(normalized).metadata();
  const width = metadata.width;
  const height = metadata.height;
  if (!width || !height) throw new Error('Normalized image dimensions are unavailable');

  const left = Math.min(width - 1, Math.floor(box.x * width));
  const top = Math.min(height - 1, Math.floor(box.y * height));
  const right = Math.min(width, Math.max(left + 1, Math.ceil((box.x + box.width) * width)));
  const bottom = Math.min(height, Math.max(top + 1, Math.ceil((box.y + box.height) * height)));

  return sharp(normalized)
    .extract({ left, top, width: right - left, height: bottom - top })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
}
