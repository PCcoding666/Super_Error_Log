/**
 * 自写二维码编码器（src/studentHost/qr.ts）的单测。
 * 参考矩阵 FIXTURE 由本编码器生成，并在 2026-11-01 用 jsQR 1.4.0 解码核对：解出的内容就是 LINK；
 * 同一轮核对还覆盖了版本 1–10、8 种掩码和中文（UTF-8）内容。仓库里不放解码器，这里用参考矩阵守住回归。
 */
import { describe, expect, it } from 'vitest';
import { encodeQr, formatBits, penaltyScore, pickVersion, QR_MAX_VERSION, QrEncodeError, qrSvg, qrTerminalLines, sizeOfVersion, versionBits } from '../../src/studentHost/qr.js';

const LINK = 'https://study.pccoding666.com/s/?code=ABCD-EFGH-JKLM';
const FIXTURE = [
  '#######.#..###...#####.##.#######',
  '#.....#.#.#.##..#.#.#####.#.....#',
  '#.###.#...##.....#..#.#...#.###.#',
  '#.###.#.##..#.#.#..#.####.#.###.#',
  '#.###.#..#..###..#..##.##.#.###.#',
  '#.....#..#..#.#..#####..#.#.....#',
  '#######.#.#.#.#.#.#.#.#.#.#######',
  '........##..#....##....##........',
  '#.##.###..#.#.#.##...#..#.#..#.##',
  '###.....#.##..#.#..#####..##.##.#',
  '.##.#.#.##.##.#.##...###..####.##',
  '..#..#..#.#.####..##....#..#.#..#',
  '.####.##.###......##.##.##.#.#.##',
  '#....#..##..##..###....##.##.#.#.',
  '#....##..#..#.######..#.#.#####..',
  '.#.......#....#.#.#.##...##.###..',
  '#.##.##.#..#####...####..##.###..',
  '..#.#..##..#.#.#.##.#####.#.##..#',
  '####..#....##.####...#.....##.#..',
  '.#.###.#.####.##.......##...#..#.',
  '#.#####.#...##....##.##....#.##.#',
  '#......###.#..##..#.##.##..#.#..#',
  '..#...##.##.....#.#..#.#..##..###',
  '.##..#.#.#.##...#.......#.####.#.',
  '#.##..##..##.###.###..#.#####..#.',
  '........#.....######.#..#...##...',
  '#######.###...#.#..##..##.#.#..#.',
  '#.....#.#####.#.#..######...#####',
  '#.###.#...#..#.#.#.##.#######.#.#',
  '#.###.#.#.#.#.....###.#....#.#..#',
  '#.###.#.####..#..#.....#####..#..',
  '#.....#..#########.##.##..###...#',
  '#######.#..#######...#.#..#.#.#..',
];

function rows(modules: boolean[][]): string[] {
  return modules.map(row => row.map(dark => (dark ? '#' : '.')).join(''));
}

function darkCount(modules: boolean[][]): number {
  return modules.flat().filter(Boolean).length;
}

describe('二维码编码器（字节模式、纠错 M）', () => {
  it('登录链接编成版本 4（33×33），与 jsQR 核对过的参考矩阵逐格一致', () => {
    const qr = encodeQr(LINK);
    expect(qr.version).toBe(4);
    expect(qr.size).toBe(33);
    expect(qr.mask).toBe(3);
    expect(rows(qr.modules)).toEqual(FIXTURE);
    // 同样的输入永远得到同样的图（页面和终端各画一份也不会对不上）
    expect(rows(encodeQr(LINK).modules)).toEqual(FIXTURE);
  });

  it('功能图形齐全：三个定位图形、定时图形、固定深色模块；版本 ≥ 7 带版本信息', () => {
    for (const version of [1, 4, 7, 10]) {
      const text = 'x'.repeat({ 1: 10, 4: 50, 7: 120, 10: 200 }[version]!);
      const qr = encodeQr(text);
      expect(qr.version).toBe(version);
      const size = sizeOfVersion(version);
      expect(qr.size).toBe(size);
      const m = qr.modules;
      // 定位图形 7×7：外圈深、内圈浅、中心 3×3 深；分隔条浅
      for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]] as const) {
        expect(m[cy]![cx]).toBe(true);
        expect(m[cy - 3]![cx - 3]).toBe(true);
        expect(m[cy - 2]![cx - 2]).toBe(false);
        expect(m[cy - 1]![cx - 1]).toBe(true);
      }
      expect(m[7]!.slice(0, 8).every(dark => !dark)).toBe(true); // 左上分隔条
      // 定时图形：第 6 行 / 第 6 列在两个定位图形之间深浅交替
      for (let i = 8; i < size - 8; i += 1) {
        expect(m[6]![i]).toBe(i % 2 === 0);
        expect(m[i]![6]).toBe(i % 2 === 0);
      }
      expect(m[size - 8]![8]).toBe(true); // 固定深色模块 (4v+9, 8)
      if (version >= 7) {
        const bits = versionBits(version);
        for (let i = 0; i < 18; i += 1) {
          const a = size - 11 + (i % 3);
          const b = Math.floor(i / 3);
          expect(m[b]![a]).toBe(((bits >>> i) & 1) === 1);
          expect(m[a]![b]).toBe(((bits >>> i) & 1) === 1);
        }
      }
    }
  });

  it('格式信息与版本信息用 ISO 18004 附录里的已知向量校验', () => {
    // 纠错 M、掩码 5 → 100000011001110（附录 C 的例子）
    expect(formatBits(5).toString(2).padStart(15, '0')).toBe('100000011001110');
    // 版本 7 → 000111 110010010100（附录 D 的例子）
    expect(versionBits(7).toString(2).padStart(18, '0')).toBe('000111110010010100');
  });

  it('掩码按罚分选最低的；强制指定掩码时格式信息跟着走，内容区按掩码翻转', () => {
    const auto = encodeQr(LINK);
    const scores = Array.from({ length: 8 }, (_, mask) => penaltyScore(encodeQr(LINK, { mask }).modules));
    expect(scores[auto.mask]).toBe(Math.min(...scores));
    const forced = encodeQr(LINK, { mask: 5 });
    expect(forced.mask).toBe(5);
    const bits = formatBits(5);
    for (let i = 0; i <= 5; i += 1) expect(forced.modules[i]![8]).toBe(((bits >>> i) & 1) === 1);
    expect(rows(forced.modules)).not.toEqual(FIXTURE);
    expect(() => encodeQr(LINK, { mask: 8 })).toThrow(QrEncodeError);
  });

  it('版本按字节数选最小的：14 字节版本 1、62 字节版本 4、213 字节版本 10，再多就报错', () => {
    expect(pickVersion(14)!.version).toBe(1);
    expect(pickVersion(15)!.version).toBe(2);
    expect(pickVersion(62)!.version).toBe(4);
    expect(pickVersion(63)!.version).toBe(5);
    expect(pickVersion(213)!.version).toBe(QR_MAX_VERSION);
    expect(pickVersion(214)).toBeNull();
    expect(pickVersion(1, 3)!.version).toBe(3);
    expect(() => encodeQr('y'.repeat(214))).toThrow(/太长/);
    // 中文按 UTF-8 字节算（5 个汉字 15 字节 → 版本 2）
    expect(encodeQr('超级错题本').version).toBe(2);
    expect(encodeQr('').version).toBe(1);
  });

  it('SVG path 只画深色模块、带 4 模块静区；终端每行两排模块，强制黑字白底', () => {
    const qr = encodeQr('A');
    expect(qr.version).toBe(1);
    const svg = qrSvg(qr.modules);
    expect(svg.side).toBe(21 + 8);
    // 每段 path 覆盖的模块数之和 = 深色模块数
    const covered = [...svg.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)].reduce((sum, match) => {
      expect(Number(match[1])).toBeGreaterThanOrEqual(4);
      expect(Number(match[2])).toBeGreaterThanOrEqual(4);
      return sum + Number(match[3]);
    }, 0);
    expect(covered).toBe(darkCount(qr.modules));
    const plain = qrTerminalLines(qr.modules, { ansi: false });
    expect(plain).toHaveLength(Math.ceil(29 / 2));
    expect(plain.every(line => [...line].length === 29)).toBe(true);
    const drawn = plain.join('').split('').reduce((sum, ch) => sum + (ch === '█' ? 2 : ch === '▀' || ch === '▄' ? 1 : 0), 0);
    expect(drawn).toBe(darkCount(qr.modules));
    expect(plain[0]!.trim()).toBe(''); // 静区
    const ansi = qrTerminalLines(qr.modules);
    expect(ansi[0]!.startsWith('\u001b[0;30;47m')).toBe(true);
    expect(ansi[0]!.endsWith('\u001b[0m')).toBe(true);
    expect(ansi.map(line => line.replace(/\u001b\[[0-9;]*m/g, ''))).toEqual(plain);
  });
});
