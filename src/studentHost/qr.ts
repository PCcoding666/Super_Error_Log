/**
 * 纯 TypeScript 的 QR 码编码器（ISO/IEC 18004 字节模式、纠错等级 M、版本 1–10），给邀请码登录链接用：
 * admin-cli `--qr` 在终端画一份，「我的邀请码」页内联一份 SVG。不引入任何依赖——
 * 生产用 `npm ci --omit=dev --ignore-scripts` 装包（deploy/ci/README.md），不想为一张二维码多一个包。
 *
 * 只实现这条链路需要的子集：字节模式（UTF-8），不做数字 / 字母数字 / 汉字压缩，不做结构化拼接；
 * 版本 1–10 足够放 `https://<域名>/s/?code=XXXX-XXXX-XXXX`（约 55 字节，版本 4-M）和更长的本机测试地址。
 * 输出是 `true = 深色模块` 的方阵；渲染（SVG / 终端）在下面两个纯函数里，和编码分开测。
 */

export type QrMatrix = boolean[][];

interface BlockGroup { count: number; dataCodewords: number }
interface VersionSpec { version: number; totalCodewords: number; ecPerBlock: number; groups: BlockGroup[]; alignment: number[]; remainderBits: number }

/** 纠错等级 M 的版本表（ISO/IEC 18004 表 9）。只到版本 10：再长的内容不是这条链路的用途。 */
const VERSIONS: readonly VersionSpec[] = [
  { version: 1, totalCodewords: 26, ecPerBlock: 10, groups: [{ count: 1, dataCodewords: 16 }], alignment: [], remainderBits: 0 },
  { version: 2, totalCodewords: 44, ecPerBlock: 16, groups: [{ count: 1, dataCodewords: 28 }], alignment: [6, 18], remainderBits: 7 },
  { version: 3, totalCodewords: 70, ecPerBlock: 26, groups: [{ count: 1, dataCodewords: 44 }], alignment: [6, 22], remainderBits: 7 },
  { version: 4, totalCodewords: 100, ecPerBlock: 18, groups: [{ count: 2, dataCodewords: 32 }], alignment: [6, 26], remainderBits: 7 },
  { version: 5, totalCodewords: 134, ecPerBlock: 24, groups: [{ count: 2, dataCodewords: 43 }], alignment: [6, 30], remainderBits: 7 },
  { version: 6, totalCodewords: 172, ecPerBlock: 16, groups: [{ count: 4, dataCodewords: 27 }], alignment: [6, 34], remainderBits: 7 },
  { version: 7, totalCodewords: 196, ecPerBlock: 18, groups: [{ count: 4, dataCodewords: 31 }], alignment: [6, 22, 38], remainderBits: 0 },
  { version: 8, totalCodewords: 242, ecPerBlock: 22, groups: [{ count: 2, dataCodewords: 38 }, { count: 2, dataCodewords: 39 }], alignment: [6, 24, 42], remainderBits: 0 },
  { version: 9, totalCodewords: 292, ecPerBlock: 22, groups: [{ count: 3, dataCodewords: 36 }, { count: 2, dataCodewords: 37 }], alignment: [6, 26, 46], remainderBits: 0 },
  { version: 10, totalCodewords: 346, ecPerBlock: 26, groups: [{ count: 4, dataCodewords: 43 }, { count: 1, dataCodewords: 44 }], alignment: [6, 28, 50], remainderBits: 0 },
];

export const QR_MAX_VERSION = VERSIONS[VERSIONS.length - 1]!.version;
/** 纠错等级 M 在格式信息里的两位指示（L=01、M=00、Q=11、H=10）。 */
const EC_LEVEL_M_BITS = 0b00;

export class QrEncodeError extends Error {
  constructor(message: string) { super(message); this.name = 'QrEncodeError'; }
}

function dataCapacityCodewords(spec: VersionSpec): number {
  return spec.groups.reduce((sum, group) => sum + group.count * group.dataCodewords, 0);
}

/** 字节模式字符数的位宽：版本 1–9 是 8 位，10 以上 16 位。 */
function countBits(version: number): number {
  return version <= 9 ? 8 : 16;
}

export function sizeOfVersion(version: number): number {
  return version * 4 + 17;
}

/** 最小能装下 `bytes` 字节的版本（含模式与长度头）；装不下返回 null。 */
export function pickVersion(byteLength: number, minVersion = 1): VersionSpec | null {
  for (const spec of VERSIONS) {
    if (spec.version < minVersion) continue;
    const needed = 4 + countBits(spec.version) + byteLength * 8;
    if (needed <= dataCapacityCodewords(spec) * 8) return spec;
  }
  return null;
}

// ---------- GF(256) 与 Reed–Solomon ----------

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255]!;
}

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a]! + GF_LOG[b]!]!;
}

/** 生成多项式 ∏(x − α^i)，i = 0..degree−1；返回最高次项系数 1 之后的 degree 个系数。 */
function rsGenerator(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < degree) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], generator: readonly number[]): number[] {
  const result = new Array<number>(generator.length).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift()!;
    result.push(0);
    generator.forEach((coefficient, index) => { result[index]! ^= gfMul(coefficient, factor); });
  }
  return result;
}

// ---------- 数据位流 ----------

class BitBuffer {
  readonly bits: number[] = [];
  push(value: number, length: number): void {
    for (let i = length - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
  }
  toBytes(): number[] {
    const bytes: number[] = [];
    for (let i = 0; i < this.bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | (this.bits[i + j] ?? 0);
      bytes.push(byte);
    }
    return bytes;
  }
}

/** 字节模式编码 + 终止符 + 填充字节（0xEC / 0x11 交替），得到正好 dataCapacity 个数据码字。 */
function encodeData(bytes: Uint8Array, spec: VersionSpec): number[] {
  const capacityBits = dataCapacityCodewords(spec) * 8;
  const buffer = new BitBuffer();
  buffer.push(0b0100, 4);
  buffer.push(bytes.length, countBits(spec.version));
  for (const byte of bytes) buffer.push(byte, 8);
  if (buffer.bits.length > capacityBits) throw new QrEncodeError('内容超出该版本容量');
  buffer.push(0, Math.min(4, capacityBits - buffer.bits.length));
  while (buffer.bits.length % 8 !== 0) buffer.bits.push(0);
  const codewords = buffer.toBytes();
  for (let pad = 0xec; codewords.length < dataCapacityCodewords(spec); pad ^= 0xec ^ 0x11) codewords.push(pad);
  return codewords;
}

/** 分块算纠错码再交错（ISO 18004 §7.6）：短块先放，数据列优先，然后是纠错列。 */
function interleave(data: readonly number[], spec: VersionSpec): number[] {
  const generator = rsGenerator(spec.ecPerBlock);
  const blocks: number[][] = [];
  const ecBlocks: number[][] = [];
  let offset = 0;
  for (const group of spec.groups) {
    for (let i = 0; i < group.count; i += 1) {
      const block = data.slice(offset, offset + group.dataCodewords);
      offset += group.dataCodewords;
      blocks.push(block);
      ecBlocks.push(rsRemainder(block, generator));
    }
  }
  const result: number[] = [];
  const longest = Math.max(...blocks.map(block => block.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.length) result.push(block[i]!);
  for (let i = 0; i < spec.ecPerBlock; i += 1) for (const block of ecBlocks) result.push(block[i]!);
  if (result.length !== spec.totalCodewords) throw new QrEncodeError('码字数与版本表不符');
  return result;
}

// ---------- 功能图形与布局 ----------

interface Canvas { size: number; modules: boolean[][]; isFunction: boolean[][] }

function newCanvas(size: number): Canvas {
  return {
    size,
    modules: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
    isFunction: Array.from({ length: size }, () => new Array<boolean>(size).fill(false)),
  };
}

/** x 是列、y 是行。 */
function setFunction(canvas: Canvas, x: number, y: number, dark: boolean): void {
  canvas.modules[y]![x] = dark;
  canvas.isFunction[y]![x] = true;
}

function drawFinder(canvas: Canvas, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy += 1) {
    for (let dx = -4; dx <= 4; dx += 1) {
      const x = cx + dx; const y = cy + dy;
      if (x < 0 || y < 0 || x >= canvas.size || y >= canvas.size) continue;
      const distance = Math.max(Math.abs(dx), Math.abs(dy));
      setFunction(canvas, x, y, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignment(canvas: Canvas, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy += 1) {
    for (let dx = -2; dx <= 2; dx += 1) setFunction(canvas, cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
}

/** 格式信息：5 位（纠错等级 2 位 + 掩码 3 位）+ BCH(15,5) 校验，再异或 0x5412。 */
export function formatBits(mask: number, ecLevelBits = EC_LEVEL_M_BITS): number {
  const data = (ecLevelBits << 3) | mask;
  let remainder = data;
  for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537);
  const bits = ((data << 10) | remainder) ^ 0x5412;
  if (bits >>> 15 !== 0) throw new QrEncodeError('格式信息溢出');
  return bits;
}

/** 版本信息（版本 ≥ 7）：6 位版本号 + BCH(18,6) 校验。 */
export function versionBits(version: number): number {
  let remainder = version;
  for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25);
  return (version << 12) | remainder;
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0;
}

function drawFormat(canvas: Canvas, mask: number): void {
  const bits = formatBits(mask);
  const size = canvas.size;
  // 左上角那一份（绕着左上定位图形）
  for (let i = 0; i <= 5; i += 1) setFunction(canvas, 8, i, bit(bits, i));
  setFunction(canvas, 8, 7, bit(bits, 6));
  setFunction(canvas, 8, 8, bit(bits, 7));
  setFunction(canvas, 7, 8, bit(bits, 8));
  for (let i = 9; i < 15; i += 1) setFunction(canvas, 14 - i, 8, bit(bits, i));
  // 另一份：右上横着、左下竖着
  for (let i = 0; i < 8; i += 1) setFunction(canvas, size - 1 - i, 8, bit(bits, i));
  for (let i = 8; i < 15; i += 1) setFunction(canvas, 8, size - 15 + i, bit(bits, i));
  setFunction(canvas, 8, size - 8, true); // 固定深色模块
}

function drawVersion(canvas: Canvas, version: number): void {
  if (version < 7) return;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i += 1) {
    const a = canvas.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    setFunction(canvas, a, b, bit(bits, i));
    setFunction(canvas, b, a, bit(bits, i));
  }
}

function drawFunctionPatterns(canvas: Canvas, spec: VersionSpec): void {
  const size = canvas.size;
  for (let i = 0; i < size; i += 1) {
    setFunction(canvas, 6, i, i % 2 === 0);
    setFunction(canvas, i, 6, i % 2 === 0);
  }
  drawFinder(canvas, 3, 3);
  drawFinder(canvas, size - 4, 3);
  drawFinder(canvas, 3, size - 4);
  const positions = spec.alignment;
  const last = positions.length - 1;
  for (let i = 0; i < positions.length; i += 1) {
    for (let j = 0; j < positions.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      drawAlignment(canvas, positions[i]!, positions[j]!);
    }
  }
  drawFormat(canvas, 0); // 先占位；选定掩码后重画
  drawVersion(canvas, spec.version);
}

/** 从右下角起、两列一组、上下交替蛇形放码字位；第 6 列（竖向定位图形）跳过。 */
function drawCodewords(canvas: Canvas, codewords: readonly number[]): void {
  const size = canvas.size;
  let index = 0;
  const total = codewords.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vertical = 0; vertical < size; vertical += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vertical : vertical;
        if (canvas.isFunction[y]![x] || index >= total) continue;
        canvas.modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7));
        index += 1;
      }
    }
  }
  if (index !== total) throw new QrEncodeError('码字放不完');
}

function maskBit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5: return (x * y) % 2 + (x * y) % 3 === 0;
    case 6: return ((x * y) % 2 + (x * y) % 3) % 2 === 0;
    case 7: return ((x + y) % 2 + (x * y) % 3) % 2 === 0;
    default: throw new QrEncodeError('掩码编号不合法');
  }
}

/** 对非功能模块套掩码（再套一次即还原）。 */
function applyMask(canvas: Canvas, mask: number): void {
  for (let y = 0; y < canvas.size; y += 1) {
    for (let x = 0; x < canvas.size; x += 1) {
      if (!canvas.isFunction[y]![x] && maskBit(mask, x, y)) canvas.modules[y]![x] = !canvas.modules[y]![x];
    }
  }
}

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** 一行（或一列）的罚分：≥5 连续同色，以及形似定位图形的 1011101 加 4 个浅色。 */
function linePenalty(line: readonly boolean[]): number {
  let penalty = 0;
  let run = 1;
  for (let i = 1; i <= line.length; i += 1) {
    if (i < line.length && line[i] === line[i - 1]) { run += 1; continue; }
    if (run >= 5) penalty += PENALTY_N1 + (run - 5);
    run = 1;
  }
  const text = line.map(dark => (dark ? '1' : '0')).join('');
  for (const pattern of ['10111010000', '00001011101']) {
    let at = text.indexOf(pattern);
    while (at >= 0) { penalty += PENALTY_N3; at = text.indexOf(pattern, at + 1); }
  }
  return penalty;
}

export function penaltyScore(modules: QrMatrix): number {
  const size = modules.length;
  let penalty = 0;
  for (let y = 0; y < size; y += 1) penalty += linePenalty(modules[y]!);
  for (let x = 0; x < size; x += 1) penalty += linePenalty(modules.map(row => row[x]!));
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      const color = modules[y]![x];
      if (modules[y]![x + 1] === color && modules[y + 1]![x] === color && modules[y + 1]![x + 1] === color) penalty += PENALTY_N2;
    }
  }
  let dark = 0;
  for (const row of modules) for (const module of row) if (module) dark += 1;
  const total = size * size;
  const deviation = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  penalty += Math.max(0, deviation) * PENALTY_N4;
  return penalty;
}

export interface QrCode { version: number; size: number; mask: number; modules: QrMatrix }

/**
 * 编码一段文本（UTF-8 字节模式，纠错 M）。自动选最小版本，掩码按罚分选（options.mask 可强制指定，测试用）。
 * 超过版本 10 的容量抛 QrEncodeError（调用方决定怎么提示）。
 */
export function encodeQr(text: string, options: { minVersion?: number; mask?: number } = {}): QrCode {
  const bytes = new TextEncoder().encode(text);
  const spec = pickVersion(bytes.length, options.minVersion ?? 1);
  if (!spec) throw new QrEncodeError(`内容太长（${bytes.length} 字节），超过版本 ${QR_MAX_VERSION} 的容量`);
  const codewords = interleave(encodeData(bytes, spec), spec);
  const canvas = newCanvas(sizeOfVersion(spec.version));
  drawFunctionPatterns(canvas, spec);
  drawCodewords(canvas, codewords);
  let bestMask = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  if (options.mask !== undefined) {
    if (!Number.isInteger(options.mask) || options.mask < 0 || options.mask > 7) throw new QrEncodeError('掩码编号只能是 0–7');
    bestMask = options.mask;
  } else {
    for (let mask = 0; mask < 8; mask += 1) {
      applyMask(canvas, mask);
      drawFormat(canvas, mask);
      const score = penaltyScore(canvas.modules);
      if (score < bestScore) { bestScore = score; bestMask = mask; }
      applyMask(canvas, mask);
    }
  }
  applyMask(canvas, bestMask);
  drawFormat(canvas, bestMask);
  return { version: spec.version, size: canvas.size, mask: bestMask, modules: canvas.modules };
}

// ---------- 渲染 ----------

/** 深色模块的 SVG path（每个模块 1×1，原点在静区外侧）。 */
export function qrSvgPath(modules: QrMatrix, quiet = 4): string {
  const parts: string[] = [];
  for (let y = 0; y < modules.length; y += 1) {
    const row = modules[y]!;
    let x = 0;
    while (x < row.length) {
      if (!row[x]) { x += 1; continue; }
      let width = 1;
      while (x + width < row.length && row[x + width]) width += 1;
      parts.push(`M${x + quiet} ${y + quiet}h${width}v1h-${width}z`);
      x += width;
    }
  }
  return parts.join('');
}

/** 内联 SVG 用：viewBox 边长（含静区）与 path。 */
export function qrSvg(modules: QrMatrix, quiet = 4): { side: number; path: string } {
  return { side: modules.length + quiet * 2, path: qrSvgPath(modules, quiet) };
}

/**
 * 终端渲染：每行文字对应两行模块（▀ 上深、▄ 下深、█ 都深、空格都浅），四周留 4 模块静区。
 * ansi=true 时每行强制黑字白底（终端配色不管深浅主题，扫码都认）；测试用 ansi=false 看纯字符。
 */
export function qrTerminalLines(modules: QrMatrix, options: { quiet?: number; ansi?: boolean } = {}): string[] {
  const quiet = options.quiet ?? 4;
  const ansi = options.ansi ?? true;
  const size = modules.length;
  const padded = size + quiet * 2;
  const at = (x: number, y: number): boolean => {
    const mx = x - quiet; const my = y - quiet;
    return mx >= 0 && my >= 0 && mx < size && my < size ? modules[my]![mx]! : false;
  };
  const lines: string[] = [];
  for (let y = 0; y < padded; y += 2) {
    let line = '';
    for (let x = 0; x < padded; x += 1) {
      const top = at(x, y);
      const bottom = y + 1 < padded ? at(x, y + 1) : false;
      line += top && bottom ? '█' : top ? '▀' : bottom ? '▄' : ' ';
    }
    lines.push(ansi ? `\u001b[0;30;47m${line}\u001b[0m` : line);
  }
  return lines;
}
