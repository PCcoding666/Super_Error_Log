import sharp from 'sharp';

let sequence = 0;

/** Small synthetic JPEG. Color changes per call so two pages are not byte-identical. */
export async function syntheticJpeg(): Promise<{ name: string; mimeType: string; buffer: Buffer }> {
  sequence += 1;
  const buffer = await sharp({
    create: {
      width: 240,
      height: 320,
      channels: 3,
      background: { r: (sequence * 53) % 256, g: (sequence * 97) % 256, b: 120 },
    },
  }).jpeg().toBuffer();
  return { name: `synthetic-${sequence}.jpg`, mimeType: 'image/jpeg', buffer };
}
