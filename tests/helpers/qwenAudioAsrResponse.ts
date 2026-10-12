/**
 * qwen-audio-3.1-asr-flash 原生接口（multimodal-generation/generation）的响应样例。
 * 形状取自 2026-10-11 的真实调用（内容是合成的一句话；已去掉各层 request_id，词级时间戳只留几条）。
 * 真实响应里 `output.text`、`output.sentence`、`usage` 之外，同一份内容还会在 `output.output` 里重复一遍。
 */
export const QWEN_AUDIO_ASR_TRANSCRIPT = '今天的作业是第3页第5题，把答案写在练习纸上，明天早上交。';

export function qwenAudioAsrResponse(): Record<string, unknown> {
  const sentence = {
    begin_time: 160,
    channel_id: 0,
    end_time: 6880,
    sentence_end: true,
    sentence_id: 1,
    text: QWEN_AUDIO_ASR_TRANSCRIPT,
    words: [
      { begin_time: 160, end_time: 680, fixed: true, punctuation: '', text: '今天的' },
      { begin_time: 680, end_time: 1080, fixed: true, punctuation: '', text: '作业' },
      { begin_time: 6440, end_time: 6880, fixed: true, punctuation: '。', text: '交' },
    ],
  };
  const usage = { duration: 7, input_tokens: 144, output_tokens: 19, total_tokens: 163 };
  return {
    output: { output: { sentence, text: QWEN_AUDIO_ASR_TRANSCRIPT }, sentence, text: QWEN_AUDIO_ASR_TRANSCRIPT, usage },
    usage,
  };
}
