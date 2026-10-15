import type { ItemRow } from '../services/itemService.js';
import type { Packet } from '../services/planService.js';

export interface PacketPrintItem extends ItemRow {
  position: number;
  hint_text: string | null;
  answer_text: string | null;
  imageDataUrl: string | null;
  diagramDataUrls?: string[];
}

function esc(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

const PRINT_CSS = `
@page { size: A4; margin: 15mm; }
* { box-sizing: border-box; }
body { font-family: "PingFang SC", "Songti SC", "SimSun", serif; color: #000; margin: 0; font-size: 12pt; }
.cover h1 { font-size: 20pt; margin: 0 0 8mm; }
.cover .meta { line-height: 2; }
.cover .rules { margin-top: 10mm; padding: 4mm; border: 1px solid #000; }
.cover { page-break-after: always; }
.qpage { page-break-after: always; }
.qhead { display: flex; justify-content: space-between; border-bottom: 2px solid #000; padding-bottom: 2mm; margin-bottom: 4mm; font-weight: bold; }
.qbody img { max-width: 100%; max-height: 90mm; display: block; margin: 2mm 0; }
.qtext { font-size: 12pt; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.qbody img { filter: grayscale(1); }
.ans-text { white-space: pre-wrap; overflow-wrap: anywhere; }
.workspace { border: 1px dashed #666; min-height: 85mm; margin-top: 4mm; padding: 2mm; }
.workspace .label { color: #333; font-size: 10pt; }
.result { border: 1px solid #000; margin-top: 4mm; padding: 3mm; }
.cb { display: inline-block; width: 4mm; height: 4mm; border: 1.5px solid #000; margin-right: 2mm; vertical-align: -0.5mm; }
.result label { margin-right: 6mm; white-space: nowrap; }
.answers { page-break-before: always; }
.answers h1 { font-size: 16pt; border-bottom: 2px solid #000; padding-bottom: 2mm; }
.ans-item { margin-bottom: 6mm; page-break-inside: avoid; }
.ans-item .sid { font-weight: bold; }
.footer-note { font-size: 9pt; color: #333; margin-top: 6mm; }
`;

export interface PacketHtml {
  /** 封面+题目页（绝不含答案/提示内容） */
  questionPart: string;
  /** 答案部分（独立成章） */
  answersPart: string;
  /** 完整文档 */
  fullHtml: string;
}

export function buildPacketHtml(input: {
  packet: Packet;
  items: PacketPrintItem[];
  nickname: string;
}): PacketHtml {
  const { packet, items, nickname } = input;

  const cover = `<section class="cover">
  <h1>每周错题复习包</h1>
  <div class="meta">
    <div>学生：${esc(nickname)}（匿名档案）</div>
    <div>周次：${esc(packet.week)}</div>
    <div>计划完成日期：${esc(packet.planned_date ?? '待定')}</div>
    <div>题目数量：${items.length} 道</div>
  </div>
  <div class="rules">
    <strong>使用说明</strong>
    <ol>
      <li>不看答案、不看笔记，独立作答；写在每题的演算区内。</li>
      <li>做完一题就在底部勾选：完成情况 + 对错。</li>
      <li>卡住超过 5 分钟再看提示页，并如实勾选「使用提示」。</li>
      <li>周末把本包带回，在 App 里回传结果。</li>
    </ol>
  </div>
  <p class="footer-note">本复习包由 Super Error Log 生成 · 题目页不含答案 · 黑白打印即可</p>
</section>`;

  const questionPages = items
    .map((it) => {
      const tags = (JSON.parse(it.knowledge_tags) as string[]).join('、');
      const img = (it.diagramDataUrls ?? (it.imageDataUrl ? [it.imageDataUrl] : []))
        .map((url) => `<img src="${esc(url)}" alt="已确认题目图示 ${esc(it.short_id ?? '')}" />`).join('');
      const text = it.text_excerpt ? `<p class="qtext">${esc(it.text_excerpt)}</p>` : '';
      return `<section class="qpage" data-short-id="${esc(it.short_id ?? '')}">
  <div class="qhead">
    <span>题号：${esc(it.short_id ?? '未编号')}</span>
    <span>${esc(it.subject ?? '')} · ${esc(tags)}</span>
    <span>计划日期：${esc(packet.planned_date ?? '')}</span>
  </div>
  <div class="qbody">${img}${text}</div>
  <div class="workspace"><span class="label">演算区（在这里重新独立做一遍）</span></div>
  <div class="result">
    <div>实际作答日期：________年____月____日</div>
    <div><strong>完成后勾选：</strong></div>
    <label><span class="cb"></span>独立完成</label>
    <label><span class="cb"></span>做出但不确定</label>
    <label><span class="cb"></span>使用提示</label>
    <label><span class="cb"></span>完全不会</label>
    <label><span class="cb"></span>未完成</label>
    <div style="margin-top:2mm"><strong>结果：</strong>
      <label><span class="cb"></span>做对</label>
      <label><span class="cb"></span>做错</label>
    </div>
  </div>
</section>`;
    })
    .join('\n');

  const answers = `<section class="answers">
  <h1>提示与答案核对要点（可沿此处裁开，留在家里）</h1>
  ${items
    .map(
      (it) => `<div class="ans-item" data-short-id="${esc(it.short_id ?? '')}">
    <div class="sid">${esc(it.short_id ?? '')}</div>
    <div class="ans-text">${esc(it.hint_text ?? '')}</div>
    <div class="ans-text">${esc(it.answer_text ?? '')}</div>
  </div>`,
    )
    .join('\n')}
</section>`;

  const head = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>复习包 ${esc(packet.week)}</title><style>${PRINT_CSS}</style></head><body>`;
  return {
    questionPart: `${cover}\n${questionPages}`,
    answersPart: answers,
    fullHtml: `${head}${cover}\n${questionPages}\n${answers}</body></html>`,
  };
}
