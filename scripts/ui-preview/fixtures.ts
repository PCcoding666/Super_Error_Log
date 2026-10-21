/** One synthetic input set shared by both independent SSR exports. No database reads. */
import type { V2WeekItem } from '../../src/v2/weekService.js';
import type { PracticeCard } from '../../src/v2/practiceService.js';
import type { PhotoView } from '../../src/web/state.js';

export const FIXTURE_DATE = '2026-10-17T02:00:00.000Z';
export const FIXTURE_WEEK = '2026-W42';
export const SCENARIOS = [
  ['login', '邀请码登录'], ['today', '今天'],
  ['capture', '拍照'], ['photos', '照片识别状态'], ['pick', '勾出错题'],
  ['items', '题目列表'], ['practices', '以前的练习'], ['item', '题目详情'], ['choose', '选题'],
  ['why', '追问'], ['confirm', '确认错因'], ['settings', '设置'], ['install', '主屏幕说明'],
] as const;

export const items: V2WeekItem[] = [
  { id: 'demo-linear', shortId: 'M-01', subject: '数学', knowledgeTags: ['一元一次方程'], questionExcerpt: '解方程：3(x − 2) = 12，并写出检验过程。', badge: 'ok', status: 'eligible_for_review', cropUrl: '', jobId: 'demo-photo' },
  { id: 'demo-triangle', shortId: 'M-02', subject: '数学', knowledgeTags: ['三角形内角和'], questionExcerpt: '三角形中，∠A = 50°，∠B = 65°，求 ∠C。', badge: 'low', status: 'needs_recheck', cropUrl: '', jobId: 'demo-photo' },
  { id: 'demo-fraction', shortId: 'M-03', subject: '数学', knowledgeTags: ['分数运算'], questionExcerpt: '计算：1/2 + 1/3，写出通分的步骤。', badge: 'ok', status: 'eligible_for_review', cropUrl: '', jobId: 'demo-photo' },
];
export const cards: PracticeCard[] = items.map((item, i) => ({ ...item, reason: i === 1 ? '隔几天再独立做一次' : '还没有独立做对过', tier: 1, reflected: false }));
export const photo: PhotoView = {
  number: 1, jobId: 'demo-photo', registeredAt: FIXTURE_DATE, state: 'needsPick', failure: null,
  pickDone: false, dismissed: false, itemCount: 1, unselectedCount: 2,
  job: {
    version: 1, id: 'demo-photo', revision: 1, photoName: 'synthetic-math.svg', sourceHash: 'synthetic', sourceMediaId: 'demo-source', status: 'completed', phase: 'complete', inventoryWarnings: [], error: null, createdAt: FIXTURE_DATE, updatedAt: FIXTURE_DATE,
    questions: items.map((item, i) => ({ id: item.id, number: String(i + 1), revision: 1, status: i === 0 ? 'ready' : 'unselected', selectionEvidence: i === 0 ? 'marked_wrong' : 'unmarked', evidence: null, verification: null, questionMediaId: i === 0 ? 'demo-crop' : null, diagramMediaIds: [], error: null, confirmedAt: null })),
  },
};

/** Mathematical artwork authored for this preview; never sourced from student photos. */
export function questionSvg(index: number): string {
  const lines = [
    ['1. Solve: 3(x - 2) = 12', '3x - 6 = 12', '3x = 6', 'x = 2'],
    ['2. Find angle C', 'A = 50 degrees', 'B = 65 degrees', 'C = ?'],
    ['3. Calculate: 1/2 + 1/3', '= 1/5', 'Show your working.'],
  ][index]!;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="360" viewBox="0 0 720 360"><rect width="720" height="360" fill="#fffef8"/><path d="M24 75H695M24 135H695M24 195H695M24 255H695M24 315H695" stroke="#e3e7ec"/>${lines.map((line, i) => `<text x="40" y="${53 + i * 62}" font-family="sans-serif" font-size="27" fill="${i ? '#42566d' : '#172934'}">${line}</text>`).join('')}${index === 1 ? '<path d="M440 265L535 75L650 265Z" fill="none" stroke="#344c58" stroke-width="3"/><text x="520" y="65" font-family="sans-serif" font-size="20">A</text><text x="420" y="290" font-family="sans-serif" font-size="20">B</text><text x="650" y="290" font-family="sans-serif" font-size="20">C</text>' : '<path d="M560 180l55 55m0-55l-55 55" stroke="#b23a36" stroke-width="7" stroke-linecap="round"/>'}<text x="40" y="342" font-family="sans-serif" font-size="15" fill="#64707a">SYNTHETIC PREVIEW / NO STUDENT DATA</text></svg>`;
}

export function photoSvg(): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="760" height="1160" viewBox="0 0 760 1160"><rect width="760" height="1160" fill="#d8dfe0"/><rect x="15" y="15" width="730" height="1130" fill="#fffef8"/><text x="40" y="58" font-family="sans-serif" font-size="25">SYNTHETIC MATH WORKSHEET / 2026-10-17</text>${items.map((_, i) => `<svg x="20" y="${85 + i * 350}" width="720" height="350" viewBox="0 0 720 360">${questionSvg(i).replace(/^<svg[^>]*>|<\/svg>$/g, '')}</svg>`).join('')}</svg>`;
}
