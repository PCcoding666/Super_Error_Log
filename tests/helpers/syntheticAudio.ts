/** 合成录音字节（测试用）：只有 MP4 盒结构，没有任何真实声音。 */
function box(type: string, ...parts: Buffer[]): Buffer {
  const body = Buffer.concat(parts);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
}
function mvhdV0(timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(100);
  body.writeUInt8(0, 0);
  body.writeUInt32BE(timescale, 12);
  body.writeUInt32BE(duration, 16);
  return box('mvhd', body);
}
function mvhdV1(timescale: number, duration: number): Buffer {
  const body = Buffer.alloc(112);
  body.writeUInt8(1, 0);
  body.writeUInt32BE(timescale, 20);
  body.writeBigUInt64BE(BigInt(duration), 24);
  return box('mvhd', body);
}
function mehd(duration: number): Buffer {
  const body = Buffer.alloc(8);
  body.writeUInt32BE(duration, 4);
  return box('mehd', body);
}
/** 合成 MP4：ftyp + moov(mvhd …) + mdat。 */
export function syntheticMp4(seconds: number, options: { version?: 0 | 1; fragmented?: boolean } = {}): Buffer {
  const timescale = 44_100;
  const ticks = Math.round(seconds * timescale);
  const ftyp = box('ftyp', Buffer.from('M4A \0\0\0\0isomM4A ', 'latin1'));
  const header = options.fragmented ? mvhdV0(timescale, 0) : (options.version === 1 ? mvhdV1(timescale, ticks) : mvhdV0(timescale, ticks));
  const moov = options.fragmented ? box('moov', header, box('mvex', mehd(ticks))) : box('moov', header);
  return Buffer.concat([ftyp, moov, box('mdat', Buffer.alloc(256, 7))]);
}

