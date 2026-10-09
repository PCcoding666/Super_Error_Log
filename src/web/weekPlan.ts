// 学生网页版（/s/）的「今天」规则：逐条移植自 iOS 第 1 期 `iOS/StudentApp/Domain/V2/WeekPlan.swift`
// （设计稿 2026-10-06 §3.2–3.5、§4.0、§4.9）。规则、阈值、文案与 Swift 版一致；单测 tests/unit/weekPlan.test.ts
// 逐例对照 `iOS/Tests/WeekPlanTests.swift`。
// 输入只用服务器已有的状态（周视图、识别任务、练习列表/详情/回报、设置）和今天的日期；
// 两处「跳过」只在本次打开里记着（网页版用会话 cookie，由调用方传入）。
// 与 Swift 的唯一差别：日历按显式时区（默认 Asia/Shanghai）算「本地日历日」，因为服务器的时区不等于学生的时区。

export type StepKind = 'shoot' | 'record' | 'pick' | 'choose' | 'why' | 'print';
export const STEP_KINDS: readonly StepKind[] = ['shoot', 'record', 'pick', 'choose', 'why', 'print'];

/** 语气色：gray 说明，blue AI 在干活，orange 要你处理，green 好了，red 出错可重试（与 iOS CardTone 同五色）。 */
export type Tone = 'gray' | 'blue' | 'orange' | 'green' | 'red';

/** 下一步按钮与清单行能做的事；页面把它翻译成链接或表单。 */
export type NextStepAction =
  | { kind: 'scan' }
  | { kind: 'rescan' }
  | { kind: 'capture' }
  | { kind: 'skipShoot' }
  | { kind: 'uploadPending' }
  | { kind: 'openPick'; taskID: string }
  | { kind: 'choose' }
  | { kind: 'why'; practiceID: string }
  | { kind: 'skipWhy'; practiceID: string }
  | { kind: 'print'; practiceID: string }
  | { kind: 'record'; practiceID: string }
  | { kind: 'skipRecord' }
  | { kind: 'summary'; practiceID: string }
  | { kind: 'goHome' };

/** 界面稳定标识用的短名（`next-step-secondary-<key>`、`today-step-…`），与 Swift `NextStepAction.key` 一致。 */
export function actionKey(action: NextStepAction): string {
  return action.kind === 'uploadPending' ? 'upload' : action.kind;
}

/** 是否要连服务器才能做（没联网 / 服务器忙 / 连不上时变灰）。拍照与两种「跳过」只在手机上。 */
export function needsServer(action: NextStepAction): boolean {
  return !['capture', 'skipShoot', 'skipRecord', 'goHome', 'scan', 'rescan'].includes(action.kind);
}

export function sameAction(a: NextStepAction | null | undefined, b: NextStepAction | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export interface Choice { title: string; icon: string | null; action: NextStepAction }

/** 底部固定的下一步按钮（§4.0）：上面一行小字，下面一个主按钮，旁边可有次要按钮。主按钮可以没有（§4.9）。 */
export interface NextStepModel {
  caption: string;
  primary: Choice | null;
  /** 主按钮可不可点（等待 AI 或没联网时不可点）。 */
  isEnabled: boolean;
  /** 等待 AI：主按钮带转圈、不可点。 */
  isWaiting: boolean;
  secondary: Choice[];
}

function model(caption: string, primary: Choice | null, options: { isEnabled?: boolean; isWaiting?: boolean; secondary?: Choice[] } = {}): NextStepModel {
  return { caption, primary, isEnabled: options.isEnabled ?? true, isWaiting: options.isWaiting ?? false, secondary: options.secondary ?? [] };
}

function choice(title: string, icon: string | null, action: NextStepAction): Choice {
  return { title, icon, action };
}

// MARK: - 常量（试用后可调）

export const THRESHOLD = {
  /** ≤ 1 天「做完了」。 */
  doneMaxDays: 1,
  /** 2–4 天「周中」；≥ 5 天「下个周末」。 */
  midweekMaxDays: 4,
  /** 上一份练习纸生成后超过这么多天还没录完：录结果那行写明是哪天的那一份（§3.4「两周没打开」）。 */
  staleRecordDays: 12,
  /** 选了题还没生成练习纸的那份，跨进新的 ISO 周后还算「这周的练习」的天数。 */
  unprintedCarryDays: 2,
} as const;

/** 每步大约几分钟（§3.5，估计值）。 */
export function minutes(kind: StepKind): number {
  switch (kind) {
    case 'shoot': return 2;
    case 'record': return 3;
    case 'pick': return 3;
    case 'choose': return 1;
    case 'why': return 5;
    case 'print': return 2;
  }
}

// MARK: - 输入

export type Connection = 'ok' | 'unpaired' | 'unauthorized' | 'incompatible' | 'offline' | 'busy' | 'failed';

export type LocalPhotoState = 'notUploaded' | 'uploading' | 'finding' | 'needsPick' | 'failed';

/** 一张还没走完识别流程的照片（网页版的照片拍完立刻上传登记，所以只会是 finding / needsPick / failed）。 */
export interface LocalPhoto {
  /** 「第几张」（按登记顺序）。 */
  number: number;
  /** 打开勾选面板用的标识（网页版即识别任务 ID）。 */
  taskID: string | null;
  /** 已上传时的识别任务 ID（用来和周视图的 photos 去重）。 */
  jobID: string | null;
  state: LocalPhotoState;
}

export interface Practice {
  id: string;
  week: string;
  createdAt: Date | null;
  generatedAt: Date | null;
  itemCount: number;
  practiceSlot: string | null;
  /** 说过为什么错的题数；null = 没有这份的详情。 */
  reflectedCount: number | null;
  /** 录了几道；null = 还没取到这份的回报。 */
  answered: number | null;
  /** 独立做对几道；null = 还没取到这份的回报。 */
  independentCorrect: number | null;
}

export function practice(fields: Partial<Practice> & Pick<Practice, 'id' | 'week' | 'itemCount'> & { generatedAt: Date | null }): Practice {
  return {
    createdAt: null, practiceSlot: null, reflectedCount: null, answered: null, independentCorrect: null,
    ...fields,
  };
}

/** 录完了吗：有这份的回报看 answered/total；没有 = 不知道（null）。 */
export function allRecorded(p: Practice): boolean | null {
  if (p.answered === null) return null;
  return p.itemCount > 0 && p.answered >= p.itemCount;
}

export interface Input {
  connection: Connection;
  /** 周视图的 ISO 周（如 2026-W41）；null = 还没取到。 */
  weekKey: string | null;
  /** 周视图里本周已登记的照片（识别任务 ID）。 */
  weekPhotoJobIDs: string[];
  /** 本周错题数（周视图 items）。 */
  weekItemCount: number;
  /** 还没走完识别流程的照片。 */
  localPhotos: LocalPhoto[];
  /** 练习，新的在前。 */
  practices: Practice[];
  /** 正在准备打印内容的练习。 */
  preparingPrintID: string | null;
  /** 本次打开里点过的「跳过」。 */
  skipped: ReadonlySet<StepKind>;
  today: Date;
  /** 学生所在时区（IANA 名）；「距生成几天」按这个时区的本地日历日算。 */
  timeZone: string;
}

export function makeInput(fields: Partial<Input> & Pick<Input, 'weekKey' | 'today'>): Input {
  return {
    connection: 'ok', weekPhotoJobIDs: [], weekItemCount: 0, localPhotos: [], practices: [],
    preparingPrintID: null, skipped: new Set(), timeZone: DEFAULT_TIME_ZONE,
    ...fields,
  };
}

export const DEFAULT_TIME_ZONE = 'Asia/Shanghai';

// MARK: - 输出

export type ConnectReason = 'unpaired' | 'unauthorized' | 'incompatible';
export type Stage = 'connect' | 'loading' | 'done' | 'midweek' | 'weekendB' | 'weekendA';

export interface Step {
  kind: StepKind;
  title: string;
  /** 标题下一句：没做时是说明 / 进行中的说法，做完时是完成的说法。 */
  detail: string;
  tone: Tone;
  /** 做完了但要提醒的一句（橙字，如「1 张没认出来」）。 */
  warning: string | null;
  isDone: boolean;
  isOptional: boolean;
  minutes: number;
  /** 点这一行去哪；null = 这一行没有可去的页面。 */
  action: NextStepAction | null;
}

export interface Result {
  stage: Stage;
  connectReason: ConnectReason | null;
  steps: Step[];
  /** 第一个没做完的步骤（「现在做这个」）。 */
  currentIndex: number | null;
  next: NextStepModel | null;
  /** 「做完了」「周中」时是哪一份练习纸。 */
  practice: Practice | null;
}

export function totalMinutes(result: Result): number {
  return result.steps.reduce((sum, step) => sum + step.minutes, 0);
}

/** 清单头：「今天大约 13 分钟，一共 5 步」。 */
export function header(result: Result): string {
  return `今天大约 ${totalMinutes(result)} 分钟，一共 ${result.steps.length} 步`;
}

// MARK: - 日历

const dayFormatters = new Map<string, Intl.DateTimeFormat>();
function dayParts(date: Date, timeZone: string): { year: number; month: number; day: number } {
  let formatter = dayFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' });
    dayFormatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

/** 某时刻在给定时区里的本地日历日序号（自 1970-01-01 起的天数）。 */
export function localDayOrdinal(date: Date, timeZone: string): number {
  const { year, month, day } = dayParts(date, timeZone);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/** 本地日历日 YYYY-MM-DD。 */
export function localDayText(date: Date, timeZone: string): string {
  const { year, month, day } = dayParts(date, timeZone);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** 「距生成几天」= date 所在本地日历日到今天的天数。 */
export function daysSince(date: Date, today: Date, timeZone: string): number {
  return localDayOrdinal(today, timeZone) - localDayOrdinal(date, timeZone);
}

// MARK: - 规则（§3.2，从上往下，命中即停）

export function make(input: Input): Result {
  if (input.connection === 'unpaired' || input.connection === 'unauthorized' || input.connection === 'incompatible') {
    return connect(input.connection);
  }
  const weekKey = input.weekKey;
  if (weekKey === null) {
    return { stage: 'loading', connectReason: null, steps: [], currentIndex: null, next: null, practice: null };
  }

  // 规则 1、2：最近一份已生成练习纸、没录完。
  const latest = input.practices[0];
  if (latest && latest.generatedAt && allRecorded(latest) !== true) {
    const days = daysSince(latest.generatedAt, input.today, input.timeZone);
    if (days <= THRESHOLD.doneMaxDays) {
      return gate({ stage: 'done', connectReason: null, steps: [], currentIndex: null, next: doneNext(latest), practice: latest }, input.connection);
    }
    if (days <= THRESHOLD.midweekMaxDays) {
      return gate({ stage: 'midweek', connectReason: null, steps: [], currentIndex: null, next: midweekNext(latest), practice: latest }, input.connection);
    }
  }

  // 规则 3、4：步骤清单。
  const steps = buildSteps(input, weekKey);
  const stage: Stage = steps.some(step => step.kind === 'record') ? 'weekendB' : 'weekendA';
  const index = steps.findIndex(step => !step.isDone);
  const currentIndex = index >= 0 ? index : null;
  const next = currentIndex === null ? null : stepNext(steps, currentIndex, input, weekKey);
  return gate({ stage, connectReason: null, steps, currentIndex, next, practice: null }, input.connection);
}

function connect(reason: ConnectReason): Result {
  const primary = reason === 'unpaired' ? choice('扫码连接', 'qrcode', { kind: 'scan' })
    : reason === 'unauthorized' ? choice('重新扫码', 'qrcode', { kind: 'rescan' })
      : choice('扫新的二维码', 'qrcode', { kind: 'rescan' });
  return { stage: 'connect', connectReason: reason, steps: [], currentIndex: null, next: model('这一步要大人帮一下', primary), practice: null };
}

// MARK: - 做完了 / 周中（§4.9）

function doneNext(p: Practice): NextStepModel {
  return model('下次打开：下个周末，录结果', null, {
    secondary: [choice('没打出来？现在打印', 'printer', { kind: 'print', practiceID: p.id })],
  });
}

function midweekNext(p: Practice): NextStepModel {
  return model('', null, {
    secondary: [
      choice('已经做完了？现在录结果', 'pencil', { kind: 'record', practiceID: p.id }),
      choice('又发了卷子？现在拍', 'camera', { kind: 'capture' }),
    ],
  });
}

// MARK: - 步骤（§3.2「步骤与完成判定」，§4.1 文案）

/**
 * 这周的练习（最近一份）：
 * - 还没生成练习纸：本周建的；或跨周没多久（≤ unprintedCarryDays 天）。更旧的不算。
 * - 已生成练习纸：本周建的、且生成后还不到「下个周末」（≤ midweekMaxDays 天）。
 */
export function currentPractice(input: Input, weekKey: string): Practice | null {
  const latest = input.practices[0];
  if (!latest) return null;
  if (latest.generatedAt) {
    const fresh = daysSince(latest.generatedAt, input.today, input.timeZone) <= THRESHOLD.midweekMaxDays;
    return latest.week === weekKey && fresh ? latest : null;
  }
  if (latest.week === weekKey) return latest;
  if (!latest.createdAt) return null;
  return daysSince(latest.createdAt, input.today, input.timeZone) <= THRESHOLD.unprintedCarryDays ? latest : null;
}

/** 上一份练习纸：不是这周的那份、已生成练习纸的最近一份（不管哪个 ISO 周）。 */
export function previousPractice(input: Input, weekKey: string): Practice | null {
  const current = currentPractice(input, weekKey);
  return input.practices.find(p => p.id !== current?.id && p.generatedAt !== null) ?? null;
}

export interface PracticeListEntry { id: string; week: string; createdAt: string; generatedAt: string | null; itemCount: number; practiceSlot: string | null }
export interface PracticeDetailEntry { id: string; week: string; createdAt: string; generatedAt: string | null; practiceSlot: string | null; items: Array<{ reflected: boolean }> }
export interface ReturnSummaryEntry { answered: number; total: number; independentCorrect: number }

/** 把练习列表、当前详情、按练习分开的回报合成 WeekPlan 的输入（新的在前）。与 Swift `WeekPlan.practices` 同规则。 */
export function practicesFrom(list: PracticeListEntry[], current: PracticeDetailEntry | null, summaries: Record<string, ReturnSummaryEntry>): Practice[] {
  const date = (value: string | null): Date | null => (value ? new Date(value) : null);
  const build = (id: string, week: string, createdAt: string, generatedAt: string | null, itemCount: number, slot: string | null): Practice => {
    const detail = current?.id === id ? current : null;
    const summary = summaries[id];
    return {
      id, week, createdAt: date(createdAt), generatedAt: date(detail?.generatedAt ?? generatedAt),
      itemCount: summary?.total ?? detail?.items.length ?? itemCount, practiceSlot: slot,
      reflectedCount: detail ? detail.items.filter(item => item.reflected).length : null,
      answered: summary?.answered ?? null, independentCorrect: summary?.independentCorrect ?? null,
    };
  };
  const result = list.map(entry => build(entry.id, entry.week, entry.createdAt, entry.generatedAt, entry.itemCount, entry.practiceSlot));
  if (current && !result.some(p => p.id === current.id)) {
    result.unshift(build(current.id, current.week, current.createdAt, current.generatedAt, current.items.length, current.practiceSlot));
  }
  return result;
}

function buildSteps(input: Input, weekKey: string): Step[] {
  const current = currentPractice(input, weekKey);
  const previous = previousPractice(input, weekKey);
  const registered = new Set(input.weekPhotoJobIDs);
  // 本周的照片：周视图里已登记的 + 还没走完流程、也还没登记进周视图的。
  const unregisteredLocal = input.localPhotos.filter(photo => (photo.jobID === null ? true : !registered.has(photo.jobID)));
  const photoCount = registered.size + unregisteredLocal.length;
  const steps: Step[] = [];

  // 1. 拍这周的卷子
  const shootDone = photoCount > 0 || input.skipped.has('shoot') || current !== null;
  steps.push({
    kind: 'shoot', title: '拍这周的卷子',
    detail: shootDone ? (photoCount > 0 ? `已拍 ${photoCount} 张` : '这周没拍卷子') : '整页拍，一页一张',
    tone: shootDone ? 'green' : 'gray', warning: null, isDone: shootDone, isOptional: false,
    minutes: minutes('shoot'), action: { kind: 'capture' },
  });

  // 周末 B：录练习纸的结果（上一份生成后 ≥ 5 天）
  if (previous && previous.generatedAt && daysSince(previous.generatedAt, input.today, input.timeZone) > THRESHOLD.midweekMaxDays) {
    steps.push(recordStep(previous, input));
  }

  // 2. 勾出做错的题
  steps.push(pickStep(input, current, photoCount));

  // 3. 选这周要练的题
  steps.push({
    kind: 'choose', title: '选这周要练的题',
    detail: current ? `选了 ${current.itemCount} 道` : 'AI 先帮你选好，5–8 道',
    tone: current ? 'green' : 'gray', warning: null, isDone: current !== null, isOptional: false,
    minutes: minutes('choose'), action: current ? { kind: 'why', practiceID: current.id } : { kind: 'choose' },
  });

  // 4. 说说为什么错（可跳过）
  steps.push(whyStep(input, current));

  // 5. 打印练习纸
  const printed = current?.generatedAt != null;
  const preparing = current ? input.preparingPrintID === current.id : false;
  steps.push({
    kind: 'print', title: '打印练习纸',
    detail: printed ? '练习纸已生成' : (preparing ? '正在准备练习纸…' : '打出来，带回学校'),
    tone: printed ? 'green' : (preparing ? 'blue' : 'gray'), warning: null, isDone: printed, isOptional: false,
    minutes: minutes('print'), action: current ? { kind: 'print', practiceID: current.id } : { kind: 'choose' },
  });
  return steps;
}

function recordStep(previous: Practice, input: Input): Step {
  const skipped = input.skipped.has('record');
  const recorded = allRecorded(previous) === true;
  const done = recorded || skipped;
  let detail: string;
  let tone: Tone;
  if (recorded) {
    detail = previous.independentCorrect !== null ? `录完了，${previous.itemCount} 道里独立做对 ${previous.independentCorrect} 道` : '录完了';
    tone = 'green';
  } else if (skipped) {
    detail = '先跳过了，下次再录';
    tone = 'gray';
  } else if (previous.answered !== null && previous.answered > 0) {
    detail = `录了 ${previous.answered}/${previous.itemCount} 道`;
    tone = 'orange';
  } else if (previous.generatedAt && daysSince(previous.generatedAt, input.today, input.timeZone) >= THRESHOLD.staleRecordDays) {
    const { month, day } = dayParts(previous.generatedAt, input.timeZone);
    detail = `上一份练习纸（${month}/${day}）还没录`;
    tone = 'orange';
  } else {
    detail = 'AI 找题要几分钟，正好先录这个';
    tone = 'gray';
  }
  return {
    kind: 'record', title: '录练习纸的结果', detail, tone, warning: null, isDone: done, isOptional: false,
    minutes: minutes('record'), action: recorded ? { kind: 'summary', practiceID: previous.id } : { kind: 'record', practiceID: previous.id },
  };
}

function pickStep(input: Input, current: Practice | null, photoCount: number): Step {
  const photos = input.localPhotos;
  const needsPick = photos.filter(photo => photo.state === 'needsPick');
  const notUploaded = photos.filter(photo => photo.state === 'notUploaded');
  const working = photos.filter(photo => photo.state === 'uploading' || photo.state === 'finding');
  const failed = photos.filter(photo => photo.state === 'failed');
  const found = `找到 ${input.weekItemCount} 道错题`;
  const failedWarning = failed.length === 0 ? null : `${failed.length} 张没认出来`;
  const make_ = (detail: string, tone: Tone, done: boolean, action: NextStepAction | null, warning: string | null = null): Step => ({
    kind: 'pick', title: '勾出做错的题', detail, tone, warning, isDone: done, isOptional: false, minutes: minutes('pick'), action,
  });

  if (photoCount === 0) {
    const done = input.skipped.has('shoot') || current !== null;
    return make_(done ? '这周没有新卷子' : '有红叉的题 AI 自己找；没批改的页要你勾', done ? 'green' : 'gray', done, null);
  }
  // 已经选过这周的题：这一步算完成。
  if (current) return make_(found, 'green', true, null, failedWarning);
  const first = needsPick[0];
  if (first) {
    return make_(`第 ${first.number} 张要你勾`, 'orange', false, first.taskID === null ? null : { kind: 'openPick', taskID: first.taskID });
  }
  if (notUploaded.length > 0) return make_(`${notUploaded.length} 张还没上传`, 'orange', false, { kind: 'uploadPending' });
  if (working.length > 0) return make_(`AI 正在找题（${working.length} 张）`, 'blue', false, null);
  // 没认出来的照片不挡路：这一行算完成，橙字写明（§3.2）。
  return make_(found, 'green', true, null, failedWarning);
}

function whyStep(input: Input, current: Practice | null): Step {
  const title = '说说为什么错';
  if (!current) {
    return { kind: 'why', title, detail: '每道 AI 问你一句，说一句就行', tone: 'gray', warning: null, isDone: false, isOptional: true, minutes: minutes('why'), action: { kind: 'choose' } };
  }
  const reflected = current.reflectedCount ?? 0;
  const allReflected = current.reflectedCount !== null && current.reflectedCount >= current.itemCount && current.itemCount > 0;
  const done = allReflected || input.skipped.has('why') || current.generatedAt !== null;
  const detail = reflected > 0 ? `说了 ${reflected}/${current.itemCount} 道` : done ? '跳过了' : '每道 AI 问你一句，说一句就行';
  return {
    kind: 'why', title, detail, tone: done ? 'green' : (reflected > 0 ? 'orange' : 'gray'), warning: null,
    isDone: done, isOptional: true, minutes: minutes('why'), action: { kind: 'why', practiceID: current.id },
  };
}

// MARK: - 下一步按钮（§3.2 末段、§4.0）

/** 第 index 步的说明行：「第 2 步，共 5 步 · 大约 3 分钟」。 */
export function stepCaption(steps: Step[], index: number): string {
  const step = steps[index];
  return `第 ${index + 1} 步，共 ${steps.length} 步 · 大约 ${step ? step.minutes : 0} 分钟`;
}

function stepNext(steps: Step[], index: number, input: Input, weekKey: string): NextStepModel {
  const step = steps[index]!;
  const caption = stepCaption(steps, index);
  const current = currentPractice(input, weekKey);
  const chooseModel = (): NextStepModel => model(caption, choice('选这周要练的题', 'list', { kind: 'choose' }));
  switch (step.kind) {
    case 'shoot':
      return model(caption, choice('拍第一页', 'camera', { kind: 'capture' }), {
        secondary: [choice('这周没发卷子，跳过', null, { kind: 'skipShoot' })],
      });
    case 'record':
      return model(caption, choice('录练习纸的结果', 'pencil', step.action ?? { kind: 'goHome' }), {
        secondary: [choice('先跳过，下次再录', null, { kind: 'skipRecord' })],
      });
    case 'pick': {
      const action = step.action;
      if (action?.kind === 'openPick') {
        const number = input.localPhotos.find(photo => photo.taskID === action.taskID)?.number ?? 1;
        return model(caption, choice(`勾第 ${number} 张`, 'checklist', action));
      }
      if (action?.kind === 'uploadPending') {
        return model('照片还在手机上，传上去 AI 才能找题', choice('上传照片', 'upload', action));
      }
      // 等 AI 找题：主按钮不可点；周末 B 给一个次要按钮先去录结果。
      const record = steps.find(s => s.kind === 'record' && !s.isDone);
      const secondary = record?.action ? [choice('先录结果', null, record.action)] : [];
      return model(secondary.length === 0 ? '大约 1–2 分钟。找好了这里会变成下一步' : '大约 1–2 分钟。可以先做下一步',
        choice('AI 正在找题…', null, { kind: 'goHome' }), { isEnabled: false, isWaiting: true, secondary });
    }
    case 'choose':
      return chooseModel();
    case 'why':
      if (!current) return chooseModel();
      return model(caption, choice('说说为什么错', 'bubble', { kind: 'why', practiceID: current.id }), {
        secondary: [choice('跳过，直接打印', null, { kind: 'skipWhy', practiceID: current.id })],
      });
    case 'print':
      if (!current) return chooseModel();
      return model(caption, choice('打印练习纸', 'printer', { kind: 'print', practiceID: current.id }));
  }
}

// MARK: - 没联网 / 服务器忙 / 连不上（§3.4、§4.0「被挡」）

/** 需要服务器的主按钮变灰并换说明；需要服务器的次要按钮收起，只在手机上的保留。 */
export function gate(result: Result, connection: Connection): Result {
  const next = result.next;
  if (!next) return result;
  let note: string;
  switch (connection) {
    case 'offline': note = '没联网，连上后再继续'; break;
    case 'busy': note = '服务器有点忙，过一会儿再试'; break;
    case 'failed': note = '连不上服务器，连上后再继续'; break;
    default: return result;
  }
  const secondary = next.secondary.filter(item => !needsServer(item.action));
  const primaryBlocked = next.primary ? needsServer(next.primary.action) || next.isWaiting : false;
  let gated: NextStepModel;
  if (primaryBlocked) {
    gated = { caption: note, primary: next.primary, isEnabled: false, isWaiting: false, secondary };
  } else if (secondary.length !== next.secondary.length) {
    // 没有主按钮的状态（做完了 / 周中）保留原来那句；原来没有说明的换成没联网的说明。
    const caption = next.primary === null && next.caption !== '' ? next.caption : (next.primary === null ? note : next.caption);
    gated = { caption, primary: next.primary, isEnabled: next.isEnabled, isWaiting: next.isWaiting, secondary };
  } else {
    return result;
  }
  return { ...result, next: gated };
}
