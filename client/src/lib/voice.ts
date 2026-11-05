/**
 * 说一段话转成文字：浏览器录音（iOS Safari 录 audio/mp4，其他多是 audio/webm）→ POST /s/voice（服务器端语音转写，和旧页面同一个接口）→ 文字。
 * 最长 59 秒（服务器上限 60 秒）；到点自动停，onLimit 通知界面去收尾。
 */
export function voiceSupported(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
}

export interface VoiceSession {
  /** 停止并转文字；失败时抛出可以直接给学生看的话。 */
  finish(): Promise<string>;
  cancel(): void;
}

const MAX_MS = 59_000;

export async function startVoice(onLimit: () => void): Promise<VoiceSession> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find(candidate => MediaRecorder.isTypeSupported?.(candidate)) ?? '';
  const recorder = type ? new MediaRecorder(stream, { mimeType: type }) : new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
  const release = (): void => stream.getTracks().forEach(track => track.stop());
  recorder.start();
  const limit = setTimeout(() => { if (recorder.state === 'recording') { recorder.stop(); onLimit(); } }, MAX_MS);
  return {
    async finish() {
      clearTimeout(limit);
      if (recorder.state === 'recording') recorder.stop();
      await stopped;
      release();
      const mime = (recorder.mimeType || type || 'audio/mp4').split(';')[0]!;
      const blob = new Blob(chunks, { type: mime });
      if (!blob.size) throw new Error('没录到声音，再说一次。');
      let response: Response;
      try {
        response = await fetch('/s/voice', { method: 'POST', credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': mime, accept: 'application/json' }, body: blob });
      } catch { throw new Error('暂时连不上，稍后再试，或者直接打字。'); }
      const body = await response.json().catch(() => null) as { text?: unknown; error?: { message?: string } } | null;
      if (!response.ok || typeof body?.text !== 'string') throw new Error(body?.error?.message ?? '这次没转成文字，再说一次，或者直接打字。');
      return body.text;
    },
    cancel() {
      clearTimeout(limit);
      if (recorder.state === 'recording') recorder.stop();
      release();
    },
  };
}
