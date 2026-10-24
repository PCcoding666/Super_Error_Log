import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  cropPhoto,
  isHeif,
  normalizePhoto,
  uprightJpeg,
  validateBox,
} from '../../src/media/images.js';

const dependencyControl = vi.hoisted(() => ({
  rejectSharpHeif: false,
  rejectSipsConversion: false,
  sipsCalls: [] as Array<{
    file: string;
    args: readonly string[];
    options: Record<string, unknown>;
  }>,
}));

vi.mock('sharp', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const realSharp = actual.default as typeof sharp;
  const wrapped = ((...args: unknown[]) => {
    const input = args[0];
    if (
      dependencyControl.rejectSharpHeif
      && Buffer.isBuffer(input)
      && input.length >= 12
      && input.toString('ascii', 4, 8) === 'ftyp'
    ) {
      throw new Error('forced Sharp HEIF decode failure');
    }
    return Reflect.apply(realSharp, undefined, args) as ReturnType<typeof realSharp>;
  }) as typeof realSharp;
  Object.assign(wrapped, realSharp);
  return { ...actual, default: wrapped };
});

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  const recordSipsCall = (args: unknown[]) => {
    const [file, commandArgs, options] = args;
    if (file !== '/usr/bin/sips') return;
    dependencyControl.sipsCalls.push({
      file,
      args: Array.isArray(commandArgs) ? [...commandArgs] as string[] : [],
      options: options && typeof options === 'object'
        ? { ...options as Record<string, unknown> }
        : {},
    });
  };
  const wrappedExecFile = ((...args: unknown[]) => {
    recordSipsCall(args);
    return Reflect.apply(actual.execFile, undefined, args);
  }) as typeof actual.execFile;
  const promisifyCustom = Symbol.for('nodejs.util.promisify.custom');
  const actualPromisified = Reflect.get(actual.execFile, promisifyCustom) as (...args: unknown[]) => unknown;
  Reflect.set(wrappedExecFile, promisifyCustom, (...args: unknown[]) => {
    recordSipsCall(args);
    const commandArgs = args[1];
    if (
      dependencyControl.rejectSipsConversion
      && Array.isArray(commandArgs)
      && commandArgs.includes('format')
      && commandArgs.includes('jpeg')
    ) {
      return Promise.reject(new Error('forced sips conversion failure'));
    }
    return Reflect.apply(actualPromisified, actual.execFile, args);
  });
  return { ...actual, execFile: wrappedExecFile };
});

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sel-images-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  dependencyControl.rejectSharpHeif = false;
  dependencyControl.rejectSipsConversion = false;
  dependencyControl.sipsCalls.length = 0;
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('validateBox', () => {
  it('accepts a fractional box wholly inside the normalized image', () => {
    expect(validateBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.3,
      height: 0.4,
    });
  });

  it.each([
    ['not an object', null],
    ['missing a field', { x: 0, y: 0, width: 1 }],
    ['non-numeric coordinate', { x: '0', y: 0, width: 1, height: 1 }],
    ['non-finite coordinate', { x: Number.NaN, y: 0, width: 1, height: 1 }],
    ['negative offset', { x: -0.01, y: 0, width: 1, height: 1 }],
    ['zero width', { x: 0, y: 0, width: 0, height: 1 }],
    ['zero height', { x: 0, y: 0, width: 1, height: 0 }],
    ['right edge outside image', { x: 0.7, y: 0, width: 0.31, height: 1 }],
    ['bottom edge outside image', { x: 0, y: 0.6, width: 1, height: 0.41 }],
  ])('rejects %s', (_description, value) => {
    expect(() => validateBox(value)).toThrow();
  });
});

describe('isHeif', () => {
  it('recognizes an ISO BMFF HEIF brand and not an unrelated buffer containing its text', () => {
    const heif = Buffer.from('000000186674797068656963000000006d69663168656963', 'hex');
    expect(isHeif(heif)).toBe(true);
    expect(isHeif(Buffer.from('prefix-heic-suffix'))).toBe(false);
    expect(isHeif(Buffer.from('000000186674797069736f6d0000000069736f6d', 'hex'))).toBe(false);
  });
});

describe('normalizePhoto', () => {
  it('applies EXIF orientation, emits JPEG, strips metadata, and leaves input unchanged', async () => {
    const source = await sharp({
      create: { width: 3, height: 2, channels: 3, background: '#ff0000' },
    })
      .jpeg()
      .withMetadata({ orientation: 6 })
      .toBuffer();
    const before = Buffer.from(source);

    const normalized = await normalizePhoto(source);
    const metadata = await sharp(normalized).metadata();

    expect(source.equals(before)).toBe(true);
    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(2);
    expect(metadata.height).toBe(3);
    expect(metadata.orientation).toBeUndefined();
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
  });

  it.each([
    ['malformed bytes', Buffer.from('not an image')],
    ['an unsupported SVG', Buffer.from('<svg width="10" height="10"></svg>')],
    ['an oversized upload', Buffer.alloc(15 * 1024 * 1024 + 1)],
  ])('rejects %s', async (_description, source) => {
    await expect(normalizePhoto(source)).rejects.toThrow();
  });

  it('rejects a raster whose decoded dimensions exceed 40 million pixels', async () => {
    const source = await sharp({
      create: { width: 6_500, height: 6_200, channels: 3, background: '#ffffff' },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();

    await expect(normalizePhoto(source)).rejects.toThrow();
  });

  const sipsSupportsHeic = (() => {
    if (process.platform !== 'darwin' || !fs.existsSync('/usr/bin/sips')) return false;
    try {
      return execFileSync('/usr/bin/sips', ['--formats'], { encoding: 'utf8' }).includes('heic');
    } catch {
      return false;
    }
  })();

  async function makeSyntheticHeic(directory: string): Promise<Buffer> {
    const pngPath = path.join(directory, 'source.png');
    const heicPath = path.join(directory, 'source.heic');
    await sharp({
      create: { width: 8, height: 6, channels: 3, background: '#336699' },
    })
      .png()
      .toFile(pngPath);
    execFileSync('/usr/bin/sips', ['-s', 'format', 'heic', pngPath, '--out', heicPath]);
    return fs.readFileSync(heicPath);
  }

  it.skipIf(!sipsSupportsHeic)('uses bounded real sips fallback and removes its owned temp directory', async () => {
    const fixtureDirectory = makeTemporaryDirectory();
    const heic = await makeSyntheticHeic(fixtureDirectory);
    const fallbackParent = path.join(makeTemporaryDirectory(), 'fallback-parent');
    fs.mkdirSync(fallbackParent);
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = fallbackParent;
    dependencyControl.rejectSharpHeif = true;

    let normalized: Buffer;
    try {
      normalized = await normalizePhoto(heic);
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }

    expect(isHeif(heic)).toBe(true);
    await expect(sharp(normalized).metadata()).resolves.toMatchObject({
      format: 'jpeg',
      width: 8,
      height: 6,
    });
    expect(dependencyControl.sipsCalls).toHaveLength(2);
    for (const call of dependencyControl.sipsCalls) {
      expect(call.file).toBe('/usr/bin/sips');
      expect(call.options).toMatchObject({ timeout: 15_000, maxBuffer: 1024 * 1024 });
      expect(call.options.shell).not.toBe(true);
      expect(call.args).not.toContain(heic.toString());
    }
    expect(fs.readdirSync(fallbackParent).filter((name) => name.startsWith('sel-heif-'))).toEqual([]);
  });

  it.skipIf(!sipsSupportsHeic)('rejects clearly when Sharp cannot decode HEIF off macOS', async () => {
    const heic = await makeSyntheticHeic(makeTemporaryDirectory());
    dependencyControl.rejectSharpHeif = true;
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');

    await expect(normalizePhoto(heic)).rejects.toThrow('HEIF fallback requires macOS');
    expect(dependencyControl.sipsCalls).toHaveLength(0);
  });

  it.skipIf(!sipsSupportsHeic)('removes its owned temp directory when sips conversion fails', async () => {
    const heic = await makeSyntheticHeic(makeTemporaryDirectory());
    const fallbackParent = path.join(makeTemporaryDirectory(), 'failing-fallback-parent');
    fs.mkdirSync(fallbackParent);
    const originalTmpdir = process.env.TMPDIR;
    process.env.TMPDIR = fallbackParent;
    dependencyControl.rejectSharpHeif = true;
    dependencyControl.rejectSipsConversion = true;

    try {
      await expect(normalizePhoto(heic)).rejects.toThrow('forced sips conversion failure');
    } finally {
      if (originalTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = originalTmpdir;
    }

    expect(dependencyControl.sipsCalls).toHaveLength(2);
    expect(fs.readdirSync(fallbackParent).filter((name) => name.startsWith('sel-heif-'))).toEqual([]);
  });

  it('never invokes sips for a non-HEIF Sharp failure', async () => {
    await expect(normalizePhoto(Buffer.from('not an image'))).rejects.toThrow();
    expect(dependencyControl.sipsCalls).toHaveLength(0);
  });
});

describe('uprightJpeg', () => {
  it('returns an upright jpeg unchanged and rotates EXIF orientation 6 to the same pixels cropPhoto uses', async () => {
    const pixels = await sharp({ create: { width: 30, height: 10, channels: 3, background: { r: 10, g: 20, b: 30 } } }).jpeg().toBuffer();
    const turned = await sharp(pixels).withMetadata({ orientation: 6 }).toBuffer();
    expect((await sharp(turned).metadata()).orientation).toBe(6);
    const page = await uprightJpeg(turned);
    const whole = await cropPhoto(turned, { x: 0, y: 0, width: 1, height: 1 });
    const pageMeta = await sharp(page).metadata();
    const wholeMeta = await sharp(whole).metadata();
    expect(pageMeta.width).toBe(wholeMeta.width);
    expect(pageMeta.height).toBe(wholeMeta.height);
    expect(pageMeta.width).toBe(10);
    expect(pageMeta.height).toBe(30);
    expect(pageMeta.orientation ?? 1).toBe(1);
    expect(await uprightJpeg(pixels)).toBe(pixels);
  });
});

describe('cropPhoto', () => {
  it('returns the requested upright evidence region rather than the whole source', async () => {
    const source = await sharp({
      create: { width: 100, height: 60, channels: 3, background: '#ff0000' },
    })
      .composite([{ input: Buffer.from([0, 255, 0]), raw: { width: 1, height: 1, channels: 3 }, tile: true, left: 50, top: 0 }])
      .png()
      .toBuffer();

    const cropped = await cropPhoto(source, { x: 0.5, y: 0, width: 0.5, height: 1 });
    const metadata = await sharp(cropped).metadata();
    const pixel = await sharp(cropped).removeAlpha().raw().toBuffer();

    expect(metadata.format).toBe('jpeg');
    expect(metadata.width).toBe(50);
    expect(metadata.height).toBe(60);
    expect(pixel[1]).toBeGreaterThan(pixel[0]! * 2);
    expect(pixel[1]).toBeGreaterThan(pixel[2]! * 2);
  });

  it('keeps a tiny positive crop at least one pixel in each dimension', async () => {
    const source = await sharp({
      create: { width: 10, height: 10, channels: 3, background: '#123456' },
    })
      .webp()
      .toBuffer();

    const cropped = await cropPhoto(source, {
      x: 0.999,
      y: 0.999,
      width: 0.001,
      height: 0.001,
    });

    await expect(sharp(cropped).metadata()).resolves.toMatchObject({ width: 1, height: 1, format: 'jpeg' });
  });

  it('validates the box before processing image data', async () => {
    await expect(
      cropPhoto(Buffer.from('not an image'), { x: 0, y: 0, width: 1.1, height: 1 }),
    ).rejects.toThrow();
  });
});
