/**
 * 学生端单页应用（client/）用的 JSON 接口，挂在 /s/api 下，和服务端页面同一套鉴权、限流与学段门槛。
 * 只做「取数 → 整形 → 返回」，规则都在现有服务里（学习周、证据、分类、材料收录），不在这里另写一份。
 * 出错一律 { error: { code, message } }；写操作要求同源（Origin / Sec-Fetch-Site），和表单页一致。
 */
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import express, { Router, type Request, type Response } from 'express';
import { getDb } from '../db/connection.js';
import { audit } from '../services/eventLog.js';
import { requireProfile } from '../services/studentService.js';
import { readCatalog } from '../classification/catalog.js';
import { JUNIOR_CATALOG } from '../classification/juniorCatalog.js';
import { ALL_STAGES } from '../classification/stages.js';
import { categoryForItem, chapterOf, chooseStudentStage, editItemCategory, stageChoices, STAGE_REQUIRED_MESSAGE } from '../classification/itemCategories.js';
import { ACCOUNT_ROLE_LABELS, isAccountRole, type AccountRole } from '../studentHost/accountRole.js';
import { getLearningWeek, listLearningPractices, getLearningPractice } from '../learning/queries.js';
import type { Figure } from '../ai/evidence.js';
import type { LearningCard } from '../learning/contracts.js';
import { getLearningSource, learningCard, learningImageFragments, materialStoreForItem } from '../learning/sources.js';
import { intakeDay } from '../learning/redoSchedule.js';
import {
  addAnswerPhoto, ANSWER_TEXT_MAX_CHARS, answerPhotoImage, deleteAnswerPhoto, editAnswerPhoto, getItemNote, insightState, listAnswerPhotos, NOTE_MAX_CHARS,
  prioritizeInsight, requestInsight, retryAnswerPhoto, saveItemNote, type AnswerPhotoRecord, type InsightState,
} from '../v2/insightService.js';
import { directCorrection, getEvidenceView } from '../v2/correctionService.js';
import { discardV2Item, getRegisteredPhotos, restoreV2Item } from '../v2/weekService.js';
import { MobileRequestError, type MobileRecognitionService } from '../mobile/service.js';
import { canRecover } from '../mobile/contracts.js';
import { includeQuestions, inclusionIntents, markedRight, notYetIncluded, setQuestionIncluded, sortQuestions, unplacedMaterial } from '../materials/learning.js';
import { unsupportedSubject, UNSUPPORTED_SUBJECT_MESSAGE } from '../materials/subjects.js';
import type { MaterialJobs } from '../materials/jobs.js';
import type { QuestionBundle } from '../materials/contracts.js';
import { dayOrdinal, localDayText } from '../domain/calendarDay.js';
import { COOKIE, readCookies, readPhotoMarks, setCookie, clearCookie, writePhotoMarks } from './session.js';
import { matchesNotebook, NOTEBOOK_STATUS_GROUPS, notebookStatusFilter, notebookStatusGroup, resolveNotebookStage, stagesInScope } from './notebook.js';
import { loadPhotos, type PhotoView, type WebContext } from './state.js';
import { detailPhotos } from './detailPhotos.js';
import { stemFirstSentence } from './views/materials.js';
import type {
  DiscardResponse, IntakeCandidate, IntakePhoto, IntakeQuestion, IntakeResponse, ItemAnswerPhoto, ItemDetailResponse, ItemInsight, ItemTrace,
  NotebookGroup, NotebookItem, NotebookResponse, SettingsResponse, UploadModeResponse,
} from './apiTypes.js';

const require = createRequire(import.meta.url);
const VERSION: string = (require('../../package.json') as { version: string }).version;
const ITEM_ID = /^itm_[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * 详情页的识别文字分三处放：你写的（原作，订正和看不出是谁写的另外标出）、批改痕迹、资料上的参考答案。
 * 同一类的几段合在一处，不再一段一行（以前两段原作会出现两行「你写的」）。带着观察 ID，学生可以逐段改。
 */
export function groupTraces(observations: Array<{ id: string; kind: string; text: string }>): { work: ItemTrace[]; marking: ItemTrace[]; sourceAnswers: ItemTrace[] } {
  const work: Array<ItemTrace & { rank: number }> = [], marking: ItemTrace[] = [], sourceAnswers: ItemTrace[] = [];
  for (const { id, kind, text: raw } of observations) {
    const text = raw.trim();
    if (!text) continue;
    if (kind === 'student_work') work.push({ id, label: null, text, rank: 0 });
    else if (kind === 'correction') work.push({ id, label: '订正', text, rank: 1 });
    else if (kind === 'teacher_note') marking.push({ id, label: null, text });
    else if (kind === 'reference_answer') sourceAnswers.push({ id, label: null, text });
    else work.push({ id, label: '看不出是谁写的', text, rank: 2 });
  }
  return { work: work.sort((a, b) => a.rank - b.rank).map(({ id, label, text }) => ({ id, label, text })), marking, sourceAnswers };
}

/** 服务里的解答状态 → 学生看到的文字；low：题目文字可能认错了；figureUrl：有交互图时它的地址。 */
export function toItemInsight(state: InsightState, low: boolean, figureUrl: (figure: Figure) => string = () => ''): ItemInsight {
  switch (state.state) {
    case 'unavailable': return { state: 'unavailable', message: '题目文字还没识别完整，AI 暂时解不了这道题，先对照照片核对。' };
    case 'failed': return state.rateLimited
      ? { state: 'failed', message: '这道题这一小时试得太多了，过一会儿再点重试。', retryable: false }
      : { state: 'failed', message: 'AI 没解出来这道题。', retryable: true };
    case 'ready': {
      const { insight } = state;
      const warnings = [
        ...(low ? ['识别出的题目文字可能有错，解答以照片为准。'] : []),
        ...(state.requiresDiagram && state.images === 0 ? ['这题有图，但 AI 没看到照片，只看了文字。'] : []),
        ...(insight.uncertain ? [insight.uncertain] : []),
      ];
      return { state: 'ready', answer: insight.answer, solution: insight.solution, mistake: insight.mistake, cause: insight.cause, warnings, figureUrl: insight.figure ? figureUrl(insight.figure) : null };
    }
    default: return state;
  }
}

/**
 * 交互图单独一页，在 iframe（sandbox="allow-scripts"）里显示。这一页有自己的 CSP：只许内联脚本和样式，不许任何网络请求、表单和外部资源，
 * 并用 CSP sandbox 强制成不透明来源（直接打开也读不到 cookie、存储）；只许本站嵌入。高度用 postMessage 告诉父页面。
 */
export const FIGURE_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts";
/** 立体图：我们自己的脚本（不是模型写的）把坐标画成能拖动旋转的 3D 线框图；点名、说明都用 textContent 放进去。 */
const SOLID_SCRIPT = `(function(){var D=JSON.parse(document.getElementById('d').textContent);var svg=document.getElementById('s'),NS='http://www.w3.org/2000/svg',W=320,H=280;
var names=Object.keys(D.points),c=[0,0,0];names.forEach(function(n){for(var i=0;i<3;i++)c[i]+=D.points[n][i]/names.length});
var r=0;names.forEach(function(n){var p=D.points[n];r=Math.max(r,Math.hypot(p[0]-c[0],p[1]-c[1],p[2]-c[2]))});r=r||1;
var yaw0=-0.55,pitch0=0.38,yaw=yaw0,pitch=pitch0,COLORS=['#d32f2f','#1565c0','#2e7d32','#ef6c00','#6a1b9a','#00838f','#c2185b','#5d4037'];
function proj(n){var p=D.points[n],x=(p[0]-c[0])/r,y=(p[1]-c[1])/r,z=(p[2]-c[2])/r,cy=Math.cos(yaw),sy=Math.sin(yaw),x1=x*cy-y*sy,y1=x*sy+y*cy,cp=Math.cos(pitch),sp=Math.sin(pitch);return[W/2+x1*105,H/2-(y1*sp+z*cp)*105,y1*cp-z*sp]}
function el(t,a){var e=document.createElementNS(NS,t);for(var k in a)e.setAttribute(k,a[k]);svg.appendChild(e);return e}
function draw(){while(svg.firstChild)svg.removeChild(svg.firstChild);var P={};names.forEach(function(n){P[n]=proj(n)});
D.faces.forEach(function(f,i){el('polygon',{points:f.map(function(n){return P[n][0]+','+P[n][1]}).join(' '),fill:COLORS[(i+2)%COLORS.length],'fill-opacity':0.12,stroke:'none'})});
D.edges.forEach(function(e){var a=P[e[0]],b=P[e[1]],far=(a[2]+b[2])/2>0.15;el('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:far?'#9e9e9e':'#37474f','stroke-width':far?1.2:1.8,'stroke-dasharray':far?'5 4':''})});
D.highlights.forEach(function(h,i){var a=P[h.from],b=P[h.to];el('line',{x1:a[0],y1:a[1],x2:b[0],y2:b[1],stroke:COLORS[i%COLORS.length],'stroke-width':3,'stroke-linecap':'round'});if(h.label){var t=el('text',{x:(a[0]+b[0])/2+6,y:(a[1]+b[1])/2-6,fill:COLORS[i%COLORS.length],'font-size':13});t.textContent=h.label}});
names.forEach(function(n){var p=P[n];el('circle',{cx:p[0],cy:p[1],r:2.6,fill:'#263238'});var t=el('text',{x:p[0]+(p[0]>=W/2?6:-6),y:p[1]-6,'text-anchor':p[0]>=W/2?'start':'end','font-size':14,fill:'#263238'});t.textContent=n.replace(/([A-Za-z])(\\d+)$/,function(m,a,d){return a+d.split('').map(function(x){return '₀₁₂₃₄₅₆₇₈₉'[+x]}).join('')})})}
var drag=null;svg.addEventListener('pointerdown',function(e){drag=[e.clientX,e.clientY];svg.setPointerCapture(e.pointerId)});
svg.addEventListener('pointermove',function(e){if(!drag)return;yaw+=(e.clientX-drag[0])*0.012;pitch=Math.max(-1.45,Math.min(1.45,pitch+(e.clientY-drag[1])*0.012));drag=[e.clientX,e.clientY];draw()});
['pointerup','pointercancel'].forEach(function(t){svg.addEventListener(t,function(){drag=null})});
document.getElementById('reset').addEventListener('click',function(){yaw=yaw0;pitch=pitch0;draw()});
if(D.caption)document.getElementById('cap').textContent=D.caption;draw()})();`;

/** 交互图页面：立体图用我们自己的渲染脚本，其他用模型写的 HTML。高度用 postMessage 告诉父页面。 */
export function figureDocument(figure: Figure): string {
  const body = figure.kind === 'html' ? figure.html
    : '<svg id="s" viewBox="0 0 320 280" width="100%" style="max-height:360px;touch-action:none;cursor:grab;display:block;user-select:none;-webkit-user-select:none;-webkit-touch-callout:none" role="img" aria-label="可以拖动旋转的立体图"></svg>'
      + '<p class="hint">用手指拖动可以旋转 · <button type="button" id="reset">回到原来的角度</button></p><p id="cap" class="hint"></p>'
      + `<script type="application/json" id="d">${JSON.stringify(figure).replace(/</g, '\\u003c')}</script><script>${SOLID_SCRIPT}</script>`;
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>交互图</title>'
    + '<style>html,body{margin:0;background:#fff}body{padding:6px;color:#1c1c1e;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",system-ui,sans-serif;overflow-x:hidden}svg,canvas,img{max-width:100%}.hint{margin:6px 4px 0;font-size:13px;color:#555}.hint button{font:inherit;color:#0066d6;background:none;border:0;padding:0}</style></head><body>'
    + body
    + '<script>(function(){function post(){parent.postMessage({selFigureHeight:Math.ceil(document.body.getBoundingClientRect().height)},"*")}addEventListener("load",post);if(window.ResizeObserver)new ResizeObserver(post).observe(document.body);setTimeout(post,300)})();</script></body></html>';
}

const toAnswerPhoto = (itemId: string, photo: AnswerPhotoRecord): ItemAnswerPhoto => ({
  id: photo.id, status: photo.status, text: photo.text, imageUrl: `/s/api/items/${itemId}/answer-photos/${photo.id}/image`,
});
const figureUrlFor = (itemId: string) => (figure: Figure): string => `/s/api/items/${itemId}/figure?v=${crypto.createHash('sha256').update(JSON.stringify(figure)).digest('hex').slice(0, 12)}`;

class ApiFailure extends Error { constructor(public status: number, public code: string, message: string) { super(message); } }
const fail = (status: number, code: string, message: string): never => { throw new ApiFailure(status, code, message); };
const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const list = (value: unknown): string[] => (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []);

function crossSite(request: Request): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return true;
  const origin = request.headers.origin;
  if (!origin || origin === 'null') return false;
  try { return new URL(origin).host !== request.headers.host; } catch { return true; }
}

export interface StudentApiOptions {
  studentHostWorker: boolean;
  service: MobileRecognitionService;
  materialsJobs?: MaterialJobs;
  accountRoleOf: (response: Response) => AccountRole | null;
  inviteExpiresOf: (response: Response) => string | null;
}

export function createStudentApi(ctx: WebContext, options: StudentApiOptions): Router {
  const r = Router();
  r.use(express.json({ limit: '64kb' }));
  r.use((request, response, next) => {
    response.setHeader('cache-control', 'private, no-store');
    if (request.method !== 'GET' && request.method !== 'HEAD' && crossSite(request)) { response.status(403).json({ error: { code: 'forbidden', message: '请从自己的页面提交。' } }); return; }
    next();
  });
  const handler = (fn: (request: Request, response: Response) => Promise<unknown> | unknown) =>
    async (request: Request, response: Response, next: express.NextFunction): Promise<void> => {
      try { const body = await fn(request, response); if (!response.headersSent) response.json(body ?? { ok: true }); }
      catch (error) { next(error); }
    };

  // ---------- 错题本 ----------
  const findItem = (itemId: string): LearningCard => {
    if (!ITEM_ID.test(itemId) || !getLearningSource(itemId)) fail(404, 'not_found', '题目不存在。');
    const week = getLearningWeek(ctx.mobileDataDir, 'all', true);
    const item = [...week.items, ...week.backlog].find(entry => entry.id === itemId);
    if (item) return item;
    for (const summary of listLearningPractices('all', -1)) {
      const card = getLearningPractice(summary.id)?.items.find(entry => entry.id === itemId);
      if (card) return card;
    }
    const stored = learningCard(itemId);
    if (stored) return stored;
    return fail(404, 'not_found', '题目不存在。');
  };
  const toNotebookItem = (item: LearningCard): NotebookItem => {
    const group = notebookStatusGroup(item.status) ?? 'todo';
    return {
      id: item.id, shortId: item.shortId, subject: item.subject || '未分类', grade: item.grade ?? null, chapter: item.chapter || '未分类',
      knowledgeTags: item.knowledgeTags, excerpt: item.questionExcerpt ?? '', status: group, statusLabel: NOTEBOOK_STATUS_GROUPS[group],
      thumb: `/s/img/item/${item.id}?s=thumb`, intakeDay: intakeDay(item.id),
    };
  };
  const todayText = (): string => {
    // 和服务端页面一样按进程时区算「今天」。
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: ctx.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ctx.now());
    return /^\d{4}-\d{2}-\d{2}$/.test(parts) ? parts : localDayText(ctx.now());
  };

  r.get('/notebook', handler((request, response) => {
    const library = getLearningWeek(ctx.mobileDataDir, 'all', true);
    const all = [...library.items, ...library.backlog];
    const cookies = readCookies(request);
    const profile = requireProfile();
    const subjects = [...new Set([...readCatalog(getDb(), profile.id).subjects.map(subject => subject.name), ...all.map(item => item.subject || '未分类')])];
    const requested = str(request.query.subject).trim().slice(0, 100);
    if (requested && !subjects.includes(requested)) subjects.push(requested);
    const subject = [requested, cookies[COOKIE.itemsSubject], ...all.filter(item => item.grade === profile.grade).map(item => item.subject), ...all.map(item => item.subject), ...subjects]
      .find(value => value && subjects.includes(value)) ?? '数学';
    const resolved = resolveNotebookStage(str(request.query.grade), [cookies[COOKIE.itemsGrade], profile.grade, ALL_STAGES], stagesInScope(all, subject));
    setCookie(request, response, COOKIE.itemsSubject, subject, null);
    setCookie(request, response, COOKIE.itemsGrade, resolved.grade, null);
    const scope = all.filter(item => (item.subject || '未分类') === subject && (resolved.grade === ALL_STAGES || item.grade === resolved.grade));
    const chapters = [...new Set(scope.map(item => item.chapter || '未分类'))];
    const chapter = str(request.query.chapter).trim().slice(0, 100);
    if (chapter && !chapters.includes(chapter)) chapters.push(chapter);
    const status = notebookStatusFilter(str(request.query.status));
    const tag = str(request.query.tag).trim().slice(0, 100);
    const tags = [...new Set(scope.flatMap(item => item.knowledgeTags.map(value => value.trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'zh'));
    if (tag && !tags.includes(tag)) tags.push(tag);
    const q = str(request.query.q).trim().slice(0, 200);
    const filters = { grade: resolved.grade, subject, chapter, status, q };
    const shown = scope.filter(item => matchesNotebook(item, filters, q ? getEvidenceView(item.id)?.questionText : '') && (!tag || item.knowledgeTags.includes(tag)));
    const today = todayText(), todayOrdinal = dayOrdinal(today) ?? 0;
    const groups: Record<NotebookGroup['key'], NotebookItem[]> = { today: [], week: [], earlier: [] };
    for (const item of shown.map(toNotebookItem)) {
      const day = item.intakeDay ? dayOrdinal(item.intakeDay) : null;
      const age = day === null ? Infinity : todayOrdinal - day;
      (age <= 0 ? groups.today : age < 7 ? groups.week : groups.earlier).push(item);
    }
    const order = (items: NotebookItem[]) => [...items].sort((a, b) => (b.intakeDay ?? '').localeCompare(a.intakeDay ?? ''));
    const photos = getRegisteredPhotos(ctx.mobileDataDir, true);
    const body: NotebookResponse = {
      subject, subjects, grade: resolved.grade, stages: resolved.stages, chapter, chapters, status, tag, tags, q,
      total: scope.length, shown: shown.length, todo: shown.filter(item => notebookStatusGroup(item.status) === 'todo').length,
      groups: ([['today', '今天'], ['week', '本周'], ['earlier', '更早']] as const).filter(([key]) => groups[key].length).map(([key, title]) => ({ key, title, items: order(groups[key]) })),
      finding: photos.filter(photo => photo.recognition === 'processing').length,
      pendingIntake: ctx.materials ? notYetIncluded(ctx.materials).reduce((n, g) => n + g.questions.length, 0) : 0,
    };
    return body;
  }));

  r.get('/items/:id', handler((request) => {
    const item = findItem(String(request.params.id));
    const evidence = getEvidenceView(item.id);
    const images = detailPhotos(item.id, item.source.kind, learningImageFragments(item.id));
    const traces = groupTraces(evidence?.observations ?? []);
    const badge = evidence?.badge ?? item.badge;
    const category = categoryForItem(item.id);
    const profile = requireProfile();
    const catalog = readCatalog(getDb(), profile.id);
    const subjects = [...new Set([...JUNIOR_CATALOG.map(subject => subject.name), ...catalog.subjects.map(subject => subject.name), category.subject].filter(Boolean))];
    // 可选章节按「学段 × 学科」各给一份：目录里这个学科的章节（细知识点归到所属章节，只有初中有目录），
    // 加上同学段同学科已有题目用过的章节；当前分类的那份一定含当前章节。修改分类时学段、学科改了，候选也要跟着换。
    const week = getLearningWeek(ctx.mobileDataDir, 'all', true);
    const cards = [...week.items, ...week.backlog];
    const stages = stageChoices(category.grade);
    const chapterOptions = stages.flatMap(grade => subjects.map(subject => {
      const used = cards.filter(card => (card.subject || '未分类') === subject && (card.grade || '') === grade).map(card => card.chapter || '').filter(Boolean);
      const fromCatalog = grade === '初中' ? (catalog.subjects.find(entry => entry.name === subject)?.topics ?? []).map(topic => chapterOf(subject, topic.name, [], grade)) : [];
      const current = grade === category.grade && subject === category.subject ? [category.chapter] : [];
      return { grade, subject, chapters: [...new Set([...current, ...fromCatalog, ...used].filter(Boolean))] };
    }));
    const body: ItemDetailResponse = {
      item: toNotebookItem(item), questionText: evidence?.questionText || item.questionExcerpt || '', badge, revision: evidence?.revision ?? null,
      images, ...traces, answerPhotos: listAnswerPhotos(item.id).map(photo => toAnswerPhoto(item.id, photo)), editable: !!evidence,
      insight: toItemInsight(insightState(item.id), badge === 'low', figureUrlFor(item.id)), remark: getItemNote(item.id),
      canDiscard: item.source.kind === 'material' || item.status === 'ready_for_reflection' || item.status === 'eligible_for_review',
      category: { grade: category.grade, subject: category.subject, chapter: category.chapter, stages, subjects, chapterOptions },
      materialUrl: item.source.kind === 'material' && item.source.questionId ? `/s/materials/questions/${item.source.questionId}` : null,
    };
    return body;
  }));

  // 详情页的 AI 解答在后台排队生成（insightService）；打开详情页只把这道题排到最前。只查这一题，不算整本错题本。
  const learningItem = (itemId: string): LearningCard => {
    const card = ITEM_ID.test(itemId) ? learningCard(itemId) : null;
    return card ?? fail(404, 'not_found', '题目不存在。');
  };
  r.get('/items/:id/insight', handler((request) => {
    const card = learningItem(String(request.params.id));
    return toItemInsight(insightState(card.id), card.badge === 'low', figureUrlFor(card.id));
  }));
  r.post('/items/:id/insight', handler((request) => {
    const card = learningItem(String(request.params.id));
    return toItemInsight(requestInsight(card.id, { retry: request.body?.retry === true }), card.badge === 'low', figureUrlFor(card.id));
  }));
  r.get('/items/:id/figure', (request, response, next) => {
    try {
      const card = learningItem(String(request.params.id));
      const state = insightState(card.id);
      if (state.state !== 'ready' || !state.insight.figure) fail(404, 'not_found', '这道题没有交互图。');
      response.setHeader('content-security-policy', FIGURE_CSP);
      response.setHeader('x-frame-options', 'SAMEORIGIN');
      response.type('html').send(figureDocument((state as Extract<InsightState, { state: 'ready' }>).insight.figure!));
    } catch (error) { next(error); }
  });
  r.post('/items/:id/remark', handler((request) => {
    const card = learningItem(String(request.params.id));
    const remark = saveItemNote(card.id, request.body?.text);
    if (!remark) fail(400, 'invalid_request', `备注最多 ${NOTE_MAX_CHARS} 字。`);
    return { remark };
  }));

  // 改识别结果：题干或某一段笔迹，键盘直改（不调用模型），规则同「不对，改一下」：学生原作只能改回纸上写的，不能改对。
  r.post('/items/:id/text', handler((request) => {
    const card = learningItem(String(request.params.id));
    const view = getEvidenceView(card.id) ?? fail(409, 'conflict', '这道题没有可修改的识别结果。');
    const target = str(request.body?.target), after = str(request.body?.text);
    if (!after.trim() || after.length > 4000) fail(400, 'invalid_request', '内容不能为空，最多 4000 字。');
    const observation = target === 'question' ? null : view.observations.find(o => o.id === target) ?? fail(404, 'not_found', '这段文字已经不在了，刷新一下。');
    const before = observation ? observation.text : view.questionText;
    if (after === before) return { revision: view.revision };
    const change = observation ? { field: 'observation', observationId: observation.id, before, after } : { field: 'questionText', before, after };
    const result = directCorrection(card.id, { revision: request.body?.revision, changes: [change] });
    if (!result.ok) fail(result.httpStatus, result.httpStatus === 409 ? 'conflict' : 'invalid_request', result.message);
    prioritizeInsight(card.id);
    return { revision: (result as { revision: number }).revision };
  }));

  // 拍照录入答案：照片存库，后台转写这道题的答案，学生可以改文字、重新转写、删掉。
  r.post('/items/:id/answer-photos', express.raw({ type: () => true, limit: '15mb' }), handler(async (request) => {
    const card = learningItem(String(request.params.id));
    if (!Buffer.isBuffer(request.body) || !request.body.length) fail(400, 'invalid_request', '先拍一张答案。');
    const added = await addAnswerPhoto(card.id, request.body as Buffer);
    if (typeof added === 'string') fail(400, 'invalid_request', added);
    return { photo: toAnswerPhoto(card.id, added as AnswerPhotoRecord) };
  }));
  r.get('/items/:id/answer-photos/:photoId/image', (request, response, next) => {
    try {
      const card = learningItem(String(request.params.id));
      const image = answerPhotoImage(card.id, String(request.params.photoId)) ?? fail(404, 'not_found', '照片不在了。');
      response.type('image/jpeg').send(image);
    } catch (error) { next(error); }
  });
  r.post('/items/:id/answer-photos/:photoId', handler((request) => {
    const card = learningItem(String(request.params.id));
    const photo = editAnswerPhoto(card.id, String(request.params.photoId), request.body?.text) ?? fail(400, 'invalid_request', `答案不能为空，最多 ${ANSWER_TEXT_MAX_CHARS} 字。`);
    return { photo: toAnswerPhoto(card.id, photo) };
  }));
  r.post('/items/:id/answer-photos/:photoId/retry', handler((request) => {
    const card = learningItem(String(request.params.id));
    if (!retryAnswerPhoto(card.id, String(request.params.photoId))) fail(409, 'conflict', '这张照片现在不用重新转写。');
    return { ok: true };
  }));
  r.post('/items/:id/answer-photos/:photoId/delete', handler((request) => {
    const card = learningItem(String(request.params.id));
    if (!deleteAnswerPhoto(card.id, String(request.params.photoId))) fail(404, 'not_found', '照片不在了。');
    return { ok: true };
  }));

  const discardOne = (itemId: string): string | null => {
    const source = getLearningSource(itemId);
    if (!ITEM_ID.test(itemId) || !source) return '题目不存在。';
    if (source.kind === 'material') {
      const store = materialStoreForItem(itemId)!;
      const question = store.getQuestion(source.questionId);
      if (!question) return '题目不存在。';
      setQuestionIncluded(store, source.questionId, false, question.revision);
      return null;
    }
    const result = discardV2Item(itemId);
    return result.ok ? null : result.message;
  };
  r.post('/items/discard', handler((request) => {
    const ids = [...new Set(list(request.body?.ids))].slice(0, 200);
    if (!ids.length) fail(400, 'invalid_request', '先选几道题。');
    const body: DiscardResponse = { removed: [], failed: [] };
    for (const id of ids) {
      const message = discardOne(id);
      if (message) body.failed.push({ id, message }); else body.removed.push(id);
    }
    if (body.removed.length) audit('web_items_discarded', 'item', body.removed.join(','));
    return body;
  }));
  r.post('/items/:id/restore', handler((request) => {
    const itemId = String(request.params.id);
    const source = getLearningSource(itemId);
    if (!ITEM_ID.test(itemId) || !source) fail(404, 'not_found', '题目不存在。');
    if (source!.kind === 'material') {
      const store = materialStoreForItem(itemId)!;
      setQuestionIncluded(store, source!.questionId, true, store.getQuestion(source!.questionId)!.revision);
    } else {
      const result = restoreV2Item(itemId);
      if (!result.ok) fail(result.httpStatus, 'conflict', result.message);
    }
    return { ok: true };
  }));
  r.post('/items/:id/category', handler((request, response) => {
    const item = findItem(String(request.params.id));
    const values = { grade: str(request.body?.grade), subject: str(request.body?.subject), chapter: str(request.body?.chapter) };
    const error = editItemCategory(getDb(), requireProfile().id, item.id, values);
    if (error) fail(400, 'invalid_request', error);
    if (values.grade !== item.grade) clearCookie(request, response, COOKIE.itemsGrade);
    audit('item_category_updated', 'item', item.id);
    return { ok: true };
  }));

  // ---------- 设置 ----------
  r.get('/settings', handler((_request, response) => {
    const role = options.studentHostWorker && isAccountRole(options.accountRoleOf(response)) ? options.accountRoleOf(response) : null;
    const grade = requireProfile().grade;
    const body: SettingsResponse = {
      grade, stages: stageChoices(grade), invitation: options.studentHostWorker, accountRole: role, accountRoleLabel: role ? ACCOUNT_ROLE_LABELS[role] : null,
      inviteExpires: options.studentHostWorker ? options.inviteExpiresOf(response) : null, version: VERSION,
    };
    return body;
  }));
  r.post('/settings/grade', handler((request, response) => {
    if (!chooseStudentStage(getDb(), requireProfile().id, request.body?.grade)) fail(400, 'invalid_request', STAGE_REQUIRED_MESSAGE);
    clearCookie(request, response, COOKIE.itemsGrade);
    audit('student_grade_updated', 'student', requireProfile().id);
    return { ok: true };
  }));

  // ---------- 录入态 ----------
  const legacyIntake = async (request: Request): Promise<IntakeResponse> => {
    const marks = readPhotoMarks(request);
    const week = getLearningWeek(ctx.mobileDataDir, 'all', true);
    const photos = await loadPhotos(ctx, { ...week, photos: getRegisteredPhotos(ctx.mobileDataDir, true) }, marks);
    const byJob = new Map<string, LearningCard[]>();
    for (const item of [...week.items, ...week.backlog]) {
      if (item.source.kind !== 'legacy' || !item.source.jobId) continue;
      byJob.set(item.source.jobId, [...(byJob.get(item.source.jobId) ?? []), item]);
    }
    const toPhoto = (photo: PhotoView): IntakePhoto => {
      const questions: IntakeQuestion[] = (byJob.get(photo.jobId) ?? []).map(item => ({ id: item.id, excerpt: item.questionExcerpt ?? '', chapter: item.chapter || '未分类', thumb: `/s/img/item/${item.id}?s=thumb` }));
      const candidates: IntakeCandidate[] = photo.state === 'needsPick' || (photo.job && !photo.pickDone)
        ? (photo.job?.questions ?? []).filter(q => q.status === 'unselected').map(q => ({ id: q.id, label: `第 ${q.number} 题`, excerpt: '', crop: `/s/img/cand/${photo.jobId}/${q.id}?s=list` }))
        : [];
      const state = photo.state === 'finding' ? 'finding' : photo.state === 'needsPick' ? 'needsPick' : photo.state === 'failed' ? 'failed' : 'done';
      const statusText = state === 'finding' ? 'AI 正在找题' : state === 'needsPick' ? '没有批改痕迹 · 勾出做错的题' : state === 'failed' ? photo.failure?.title ?? '没识别成功'
        : questions.length ? `找到 ${questions.length} 道` : '没有新增错题';
      return {
        id: photo.jobId, number: photo.number, takenAt: photo.registeredAt, thumb: `/s/img/photo/${photo.jobId}`, full: `/s/img/photo/${photo.jobId}?full=1`,
        state, statusText, questions, candidates,
        failure: photo.failure ? { title: photo.failure.title, detail: photo.failure.detail, retryable: photo.failure.retryTitle !== null } : null,
      };
    };
    const visible = photos.filter(photo => !(photo.dismissed && photo.failure)).sort((a, b) => Date.parse(b.registeredAt) - Date.parse(a.registeredAt) || b.number - a.number);
    return { mode: 'legacy', draftNamespace: null, photos: visible.map(toPhoto), busy: visible.some(photo => photo.state === 'finding') };
  };

  const materialsIntake = (): IntakeResponse => {
    const store = ctx.materials!;
    const assets = store.db.prepare('SELECT id, created_at, json_extract(extraction_json, \'$.document.subject\') AS subject FROM material_asset WHERE owner_id=? ORDER BY created_at DESC, rowid DESC').all(store.studentId) as { id: string; created_at: string; subject: string | null }[];
    const jobs = store.db.prepare(`SELECT j.id, j.state, j.asset_id, j.error FROM material_job j WHERE j.owner_id=? AND j.kind='extract'
      AND NOT EXISTS (SELECT 1 FROM material_job n WHERE n.owner_id=j.owner_id AND n.kind='extract' AND n.asset_id=j.asset_id AND n.rowid>j.rowid)`).all(store.studentId) as { id: string; state: string; asset_id: string | null; error: string | null }[];
    const jobByAsset = new Map(jobs.map(job => [job.asset_id, job]));
    const all = sortQuestions(store, store.listQuestions()).filter(q => !unplacedMaterial(q));
    const intents = inclusionIntents(store);
    const pending = new Map(notYetIncluded(store, all, intents).map(group => [group.assetId, group.questions]));
    const assetOf = (q: QuestionBundle): string | null => q.stem.find(f => f.role === 'question')?.assetId ?? q.stem[0]?.assetId ?? null;
    const included = new Map<string, QuestionBundle[]>();
    for (const q of all) {
      const asset = assetOf(q);
      if (!asset || !q.itemId || intents.get(q.id) === false) continue;
      included.set(asset, [...(included.get(asset) ?? []), q]);
    }
    const cropOf = (q: QuestionBundle): string | null => { const f = q.stem.find(fragment => fragment.role === 'question') ?? q.stem[0]; return f ? `/s/materials/fragments/${f.fragmentId}/crop?revision=${f.revision}` : null; };
    const photos: IntakePhoto[] = assets.map((asset, index) => {
      const job = jobByAsset.get(asset.id);
      const other = unsupportedSubject(asset.subject);
      let retryable = true;
      try { if (job?.error) retryable = canRecover({ ...JSON.parse(job.error), stage: 'transcribe' }); } catch { retryable = false; }
      const processing = job?.state === 'queued' || job?.state === 'running';
      const failed = job?.state === 'failed' || job?.state === 'interrupted';
      const questions: IntakeQuestion[] = (included.get(asset.id) ?? []).map(q => ({ id: q.itemId!, excerpt: stemFirstSentence(q, 60), chapter: (() => { try { return categoryForItem(q.itemId!).chapter || '未分类'; } catch { return q.subject ?? '未分类'; } })(), thumb: cropOf(q) ?? `/s/img/item/${q.itemId}?s=thumb` }));
      const candidates: IntakeCandidate[] = (pending.get(asset.id) ?? []).map(q => ({ id: `${q.id}:${q.revision}`, label: q.number ? `第 ${q.number} 题` : '题号不清', excerpt: stemFirstSentence(q, 60), crop: cropOf(q) }));
      const state = processing ? 'finding' : failed ? 'failed' : other ? 'unsupported' : candidates.length ? 'needsPick' : 'done';
      const correct = all.filter(q => assetOf(q) === asset.id && markedRight(q)).length;
      const statusText = state === 'finding' ? 'AI 正在找题' : state === 'failed' ? '没整理成功' : state === 'unsupported' ? `${other}：${UNSUPPORTED_SUBJECT_MESSAGE}`
        : state === 'needsPick' ? '没有批改痕迹 · 勾出做错的题' : questions.length ? `找到 ${questions.length} 道${correct ? ` · ${correct} 道打了 √` : ''}` : correct ? `${correct} 道都打了 √，没有错题` : '没有新增错题';
      return {
        id: asset.id, number: assets.length - index, takenAt: asset.created_at.includes('T') ? asset.created_at : asset.created_at.replace(' ', 'T') + 'Z',
        thumb: `/s/materials/assets/${asset.id}/image`, full: `/s/materials/assets/${asset.id}/image`, state, statusText, questions, candidates,
        failure: failed ? { title: '没整理成功', detail: retryable ? '原图已保留，可以重新整理。' : '看不清或格式不对，请重拍这张。', retryable } : null,
      };
    });
    return { mode: 'materials', draftNamespace: store.getWorkspace().draftNamespace, photos, busy: photos.some(photo => photo.state === 'finding') };
  };

  r.get('/intake', handler(async (request) => (ctx.materials ? materialsIntake() : legacyIntake(request))));
  // 上传队列在发第一张之前先问这个：材料流程的学生空间不接受旧的 /s/capture。
  r.get('/upload', handler((): UploadModeResponse => (ctx.materials ? { mode: 'materials', draftNamespace: ctx.materials.getWorkspace().draftNamespace } : { mode: 'legacy', draftNamespace: null })));

  r.post('/intake/photos/:id/select', handler(async (request) => {
    const photoId = String(request.params.id);
    const ids = [...new Set(list(request.body?.ids))].slice(0, 120);
    if (!ids.length) fail(400, 'invalid_request', '先勾出做错的题。');
    if (ctx.materials) {
      const picks = ids.map(value => { const m = /^([A-Za-z0-9_-]{1,80}):([0-9]{1,9})$/.exec(value); if (!m) fail(400, 'invalid_request', '勾选信息不可用，请刷新后再试。'); return { questionId: m![1]!, revision: Number(m![2]) }; });
      const saved = includeQuestions(ctx.materials, picks);
      return { ok: true, ...saved };
    }
    if (!UUID.test(photoId) || !ids.every(id => UUID.test(id))) fail(400, 'invalid_request', '勾选信息不可用，请刷新后再试。');
    try { await options.service.select(photoId, ids.slice(0, 30)); }
    catch (error) { if (error instanceof MobileRequestError) fail(error.status, error.code, error.message); throw error; }
    return { ok: true, included: ids.length, skipped: 0 };
  }));

  r.post('/intake/photos/:id/retry', handler(async (request) => {
    const photoId = String(request.params.id);
    if (ctx.materials) {
      const job = ctx.materials.db.prepare(`SELECT id FROM material_job WHERE owner_id=? AND kind='extract' AND asset_id=? ORDER BY rowid DESC LIMIT 1`).get(ctx.materials.studentId, photoId) as { id: string } | undefined;
      if (!job || !options.materialsJobs) fail(404, 'not_found', '这张照片没有可以重试的整理任务。');
      const requestId = UUID.test(str(request.body?.requestId)) ? str(request.body?.requestId) : crypto.randomUUID();
      try { options.materialsJobs!.retry(job!.id, requestId); }
      catch (error) { if (error instanceof MobileRequestError) fail(error.status, error.code, error.message); throw error; }
      return { ok: true };
    }
    if (!UUID.test(photoId)) fail(404, 'not_found', '照片不存在。');
    try { await options.service.retry(photoId, null); }
    catch (error) { if (error instanceof MobileRequestError) fail(error.status, error.code, error.message); throw error; }
    return { ok: true };
  }));

  r.post('/intake/photos/:id/dismiss', handler(async (request, response) => {
    const photoId = String(request.params.id);
    if (ctx.materials || !UUID.test(photoId)) fail(400, 'invalid_request', '这张照片不能移除。');
    const week = getRegisteredPhotos(ctx.mobileDataDir, true);
    if (!week.some(photo => photo.jobId === photoId)) fail(404, 'not_found', '照片不存在。');
    const marks = readPhotoMarks(request);
    marks.dismissed.add(photoId);
    writePhotoMarks(request, response, marks, week.map(photo => photo.jobId), { kind: 'dismissed', id: photoId });
    return { ok: true };
  }));

  r.use(((error: unknown, _request: Request, response: Response, _next: express.NextFunction) => {
    if (error instanceof ApiFailure) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof MobileRequestError) { response.status(error.status).json({ error: { code: error.code, message: error.message } }); return; }
    if (error instanceof SyntaxError || (error as { type?: string })?.type === 'entity.parse.failed') { response.status(400).json({ error: { code: 'invalid_request', message: '请求内容不合法。' } }); return; }
    if ((error as { type?: string })?.type === 'entity.too.large') { response.status(413).json({ error: { code: 'payload_too_large', message: '照片太大了（超过 15 MB），换一张。' } }); return; }
    console.error(error);
    response.status(500).json({ error: { code: 'internal', message: '出了点问题，稍后再试。' } });
  }) as express.ErrorRequestHandler);
  return r;
}
