/**
 * POST /v2/reflections/transcribe（以及网页版同源镜像 POST /s/voice）：把一段短录音转成文字。
 * - 正文是原始录音字节：iOS Safari 的 MediaRecorder 产出 audio/mp4（AAC）；桌面测试用 audio/webm。
 * - 上限：≤ 5 MB；容器里写了时长（MP4 mvhd/mehd）时还要 ≤ 60 秒。网页端录到 60 秒自动停。
 * - 录音只在内存里经过一次：不落盘、不写日志、不进数据库；返回的文字也不在服务器保存——
 *   学生在文本框里改完、自己点「说完了」才作为回答提交（AI 只转写，不替学生提交）。
 */
import { TranscribeError, type SpeechTranscriber } from '../ai/asr.js';

export const TRANSCRIBE_MAX_BYTES = 5 * 1024 * 1024;
export const TRANSCRIBE_MAX_SECONDS = 60;
const ACCEPTED = new Set(['audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/aac', 'audio/webm']);

export type TranscribeOutcome =
  | { status: 200; body: { text: string } }
  | { status: 400 | 413 | 415 | 502; body: { error: { code: string; message: string } } };

function fail(status: 400 | 413 | 415 | 502, code: string, message: string): TranscribeOutcome {
  return { status, body: { error: { code, message } } };
}

/** content-type 去掉参数（如 `audio/webm;codecs=opus` → `audio/webm`），小写。 */
export function baseMimeType(header: string | undefined): string {
  return (header ?? '').split(';')[0]!.trim().toLowerCase();
}

/**
 * 读 MP4 容器声明的时长（秒）：moov/mvhd，或分片录音的 moov/mvex/mehd。
 * 读不到（非 MP4、分片且没写总时长、结构异常）返回 null——此时只靠 5 MB 上限与网页端 60 秒自动停。
 */
export function mp4DurationSeconds(bytes: Buffer): number | null {
  const boxes = (start: number, end: number): Array<{ type: string; body: number; end: number }> => {
    const list: Array<{ type: string; body: number; end: number }> = [];
    let offset = start;
    while (offset + 8 <= end) {
      let size = bytes.readUInt32BE(offset);
      const type = bytes.toString('latin1', offset + 4, offset + 8);
      let body = offset + 8;
      if (size === 1) {
        if (offset + 16 > end) break;
        const large = bytes.readBigUInt64BE(offset + 8);
        if (large > BigInt(end - offset)) break;
        size = Number(large); body = offset + 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < body - offset || offset + size > end) break;
      list.push({ type, body, end: offset + size });
      offset += size;
    }
    return list;
  };
  try {
    const moov = boxes(0, bytes.length).find(box => box.type === 'moov');
    if (!moov) return null;
    const inner = boxes(moov.body, moov.end);
    const mvhd = inner.find(box => box.type === 'mvhd');
    if (!mvhd) return null;
    const version = bytes.readUInt8(mvhd.body);
    const timescale = version === 1 ? bytes.readUInt32BE(mvhd.body + 20) : bytes.readUInt32BE(mvhd.body + 12);
    if (timescale === 0) return null;
    let duration = version === 1 ? Number(bytes.readBigUInt64BE(mvhd.body + 24)) : bytes.readUInt32BE(mvhd.body + 16);
    if (duration === 0 || duration === 0xffffffff) {
      const mvex = inner.find(box => box.type === 'mvex');
      const mehd = mvex ? boxes(mvex.body, mvex.end).find(box => box.type === 'mehd') : undefined;
      if (!mehd) return null;
      const mehdVersion = bytes.readUInt8(mehd.body);
      duration = mehdVersion === 1 ? Number(bytes.readBigUInt64BE(mehd.body + 4)) : bytes.readUInt32BE(mehd.body + 4);
      if (duration === 0) return null;
    }
    return duration / timescale;
  } catch {
    return null;
  }
}

/** 校验并转写；调用方负责鉴权与限流。音频 Buffer 用完即丢。 */
export async function transcribeClip(transcriber: SpeechTranscriber, body: unknown, contentType: string | undefined, signal?: AbortSignal): Promise<TranscribeOutcome> {
  const mime = baseMimeType(contentType);
  if (!ACCEPTED.has(mime)) return fail(415, 'unsupported_media_type', '只接受 audio/mp4 或 audio/webm 录音。');
  if (!Buffer.isBuffer(body) || body.length === 0) return fail(400, 'invalid_audio', '录音是空的，再说一次。');
  if (body.length > TRANSCRIBE_MAX_BYTES) return fail(413, 'payload_too_large', '录音超过 5 MB 限制。');
  if (mime !== 'audio/webm') {
    const seconds = mp4DurationSeconds(body);
    if (seconds !== null && seconds > TRANSCRIBE_MAX_SECONDS + 0.5) return fail(400, 'audio_too_long', '录音超过 60 秒，说短一点再试。');
  }
  try {
    const text = await transcriber.transcribe(body, mime === 'audio/x-m4a' || mime === 'audio/m4a' ? 'audio/mp4' : mime, signal);
    return { status: 200, body: { text } };
  } catch (error) {
    if (error instanceof TranscribeError) return fail(502, 'bad_gateway', '这次没转成文字，再说一次，或者直接打字。');
    throw error;
  }
}
