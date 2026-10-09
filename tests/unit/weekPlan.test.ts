/**
 * 学生网页版的 WeekPlan：逐例对照 iOS/Tests/WeekPlanTests.swift（设计稿 §3.2 规则、§3.4「打开的日子不对」、§4.0、§4.9）。
 * 全部是合成数据；日期按 Asia/Shanghai 本地日历日算，避免跑测试的机器时区影响「距生成几天」。
 */
import { describe, expect, it } from 'vitest';
import {
  allRecorded, daysSince, header, make, makeInput, needsServer, practice, practicesFrom,
  type Input, type LocalPhoto, type LocalPhotoState, type Practice, type Result, type StepKind,
} from '../../src/web/weekPlan.js';

const TZ = 'Asia/Shanghai';
/** 上海时间 → Date。 */
function date(year: number, month: number, day: number, hour: number, minute = 0): Date {
  return new Date(Date.UTC(year, month - 1, day, hour - 8, minute));
}
/** 周六 2026-10-10 10:00（上海）。 */
const saturday = date(2026, 10, 10, 10);
const thisWeek = '2026-W41';
const lastWeek = '2026-W40';
const DAY = 86_400_000;

function input(options: {
  today?: Date; connection?: Input['connection']; weekKey?: string | null; photos?: string[]; items?: number;
  local?: LocalPhoto[]; practices?: Practice[]; preparing?: string | null; skipped?: StepKind[];
} = {}): Input {
  return makeInput({
    today: options.today ?? saturday, connection: options.connection ?? 'ok',
    weekKey: options.weekKey === undefined ? thisWeek : options.weekKey,
    weekPhotoJobIDs: options.photos ?? [], weekItemCount: options.items ?? 0, localPhotos: options.local ?? [],
    practices: options.practices ?? [], preparingPrintID: options.preparing ?? null,
    skipped: new Set(options.skipped ?? []), timeZone: TZ,
  });
}

/** 本周已建、还没生成练习纸的一份练习。 */
function thisWeekPractice(options: { items?: number; reflected?: number | null; generatedAt?: Date | null; answered?: number | null } = {}): Practice {
  return practice({
    id: 'pkt_this', week: thisWeek, generatedAt: options.generatedAt ?? null, itemCount: options.items ?? 3,
    practiceSlot: '周三晚自习', reflectedCount: options.reflected === undefined ? 0 : options.reflected,
    answered: options.answered ?? null,
  });
}

/** 上周的练习纸，生成于 daysAgo 天前（相对周六）。 */
function lastWeekPractice(daysAgo: number, options: { items?: number; answered?: number | null; correct?: number | null } = {}): Practice {
  const items = options.items ?? 6;
  return practice({
    id: 'pkt_last', week: lastWeek, generatedAt: new Date(saturday.getTime() - daysAgo * DAY), itemCount: items,
    practiceSlot: '周三晚自习', reflectedCount: items, answered: options.answered === undefined ? 0 : options.answered,
    independentCorrect: options.correct ?? null,
  });
}

let photoSeq = 0;
function photo(number: number, state: LocalPhotoState, job: string | null = null): LocalPhoto {
  photoSeq += 1;
  return { number, taskID: `task-${photoSeq}`, jobID: job, state };
}

const kinds = (result: Result): StepKind[] => result.steps.map(step => step.kind);
const titles = (items: Array<{ title: string }> | undefined): string[] => (items ?? []).map(item => item.title);

describe('规则 0：先连上', () => {
  it('没配对：连接页「扫码连接」，不显示步骤', () => {
    const result = make(input({ connection: 'unpaired', practices: [thisWeekPractice()] }));
    expect(result.stage).toBe('connect');
    expect(result.connectReason).toBe('unpaired');
    expect(result.steps).toEqual([]);
    expect(result.next?.primary?.title).toBe('扫码连接');
    expect(result.next?.primary?.action).toEqual({ kind: 'scan' });
  });

  it('授权失效与版本不一致：都要新的二维码', () => {
    const unauthorized = make(input({ connection: 'unauthorized' }));
    expect(unauthorized.connectReason).toBe('unauthorized');
    expect(unauthorized.next?.primary?.title).toBe('重新扫码');
    expect(unauthorized.next?.primary?.action).toEqual({ kind: 'rescan' });
    const incompatible = make(input({ connection: 'incompatible' }));
    expect(incompatible.connectReason).toBe('incompatible');
    expect(incompatible.next?.primary?.title).toBe('扫新的二维码');
    expect(incompatible.next?.primary?.action).toEqual({ kind: 'rescan' });
  });

  it('还没取到周视图：只说正在读取', () => {
    const result = make(input({ weekKey: null, practices: [thisWeekPractice()] }));
    expect(result.stage).toBe('loading');
    expect(result.steps).toEqual([]);
    expect(result.next).toBeNull();
  });
});

describe('规则 4：周末 A', () => {
  it('第一次用：五步，步骤 1 高亮，没有空白页', () => {
    const result = make(input());
    expect(result.stage).toBe('weekendA');
    expect(kinds(result)).toEqual(['shoot', 'pick', 'choose', 'why', 'print']);
    expect(header(result)).toBe('今天大约 13 分钟，一共 5 步');
    expect(result.currentIndex).toBe(0);
    expect(result.steps[0]!.detail).toBe('整页拍，一页一张');
    expect(result.next?.primary?.title).toBe('拍第一页');
    expect(result.next?.primary?.action).toEqual({ kind: 'capture' });
    expect(result.next?.caption).toBe('第 1 步，共 5 步 · 大约 2 分钟');
    expect(titles(result.next?.secondary)).toEqual(['这周没发卷子，跳过']);
    expect(result.steps[3]!.isOptional).toBe(true);
  });

  it('跳过拍照：去选题，说这周没有新卷子', () => {
    const result = make(input({ skipped: ['shoot'] }));
    expect(result.steps[0]!.isDone).toBe(true);
    expect(result.steps[0]!.detail).toBe('这周没拍卷子');
    expect(result.steps[1]!.detail).toBe('这周没有新卷子');
    expect(result.steps[1]!.isDone).toBe(true);
    expect(result.currentIndex).toBe(2);
    expect(result.next?.primary?.title).toBe('选这周要练的题');
    expect(result.next?.caption).toBe('第 3 步，共 5 步 · 大约 1 分钟');
  });

  it('AI 在找题：主按钮等待、不可点；周末 A 没有次要按钮', () => {
    const result = make(input({ local: [photo(1, 'uploading'), photo(2, 'finding', 'job-2')] }));
    expect(result.steps[0]!.detail).toBe('已拍 2 张');
    expect(result.steps[1]!.detail).toBe('AI 正在找题（2 张）');
    expect(result.steps[1]!.tone).toBe('blue');
    expect(result.currentIndex).toBe(1);
    expect(result.next?.primary?.title).toBe('AI 正在找题…');
    expect(result.next?.isEnabled).toBe(false);
    expect(result.next?.isWaiting).toBe(true);
    expect(result.next?.secondary).toEqual([]);
  });

  it('没批改痕迹的页：勾那一张', () => {
    const needsPick = photo(3, 'needsPick', 'job-3');
    const result = make(input({ photos: ['job-1', 'job-3'], items: 3, local: [needsPick] }));
    expect(result.steps[0]!.detail).toBe('已拍 2 张');
    expect(result.steps[1]!.detail).toBe('第 3 张要你勾');
    expect(result.steps[1]!.tone).toBe('orange');
    expect(result.next?.primary?.title).toBe('勾第 3 张');
    expect(result.next?.primary?.action).toEqual({ kind: 'openPick', taskID: needsPick.taskID });
  });

  it('照片还在手机上：上传', () => {
    const result = make(input({ local: [photo(1, 'notUploaded')] }));
    expect(result.steps[1]!.detail).toBe('1 张还没上传');
    expect(result.next?.primary?.title).toBe('上传照片');
    expect(result.next?.primary?.action).toEqual({ kind: 'uploadPending' });
    expect(result.next?.caption).toBe('照片还在手机上，传上去 AI 才能找题');
  });

  it('没认出来的照片不挡路，但橙字写明', () => {
    const result = make(input({ photos: ['job-1', 'job-2'], items: 9, local: [photo(2, 'failed', 'job-2')] }));
    expect(result.steps[1]!.isDone).toBe(true);
    expect(result.steps[1]!.detail).toBe('找到 9 道错题');
    expect(result.steps[1]!.warning).toBe('1 张没认出来');
    expect(result.next?.primary?.title).toBe('选这周要练的题');
  });

  it('选好题后：说说为什么错，可跳过', () => {
    const result = make(input({ photos: ['job-1'], items: 3, practices: [thisWeekPractice()] }));
    expect(result.steps[2]!.detail).toBe('选了 3 道');
    expect(result.currentIndex).toBe(3);
    expect(result.next?.primary?.title).toBe('说说为什么错');
    expect(result.next?.primary?.action).toEqual({ kind: 'why', practiceID: 'pkt_this' });
    expect(titles(result.next?.secondary)).toEqual(['跳过，直接打印']);
    expect(result.next?.secondary[0]?.action).toEqual({ kind: 'skipWhy', practiceID: 'pkt_this' });
    expect(result.next?.caption).toBe('第 4 步，共 5 步 · 大约 5 分钟');
  });

  it('说了一部分：显示进度', () => {
    const result = make(input({ photos: ['job-1'], practices: [thisWeekPractice({ items: 6, reflected: 2 })] }));
    expect(result.steps[3]!.detail).toBe('说了 2/6 道');
    expect(result.steps[3]!.isDone).toBe(false);
  });

  it('跳过或说完：去打印', () => {
    const skipped = make(input({ photos: ['job-1'], practices: [thisWeekPractice()], skipped: ['why'] }));
    expect(skipped.steps[3]!.isDone).toBe(true);
    expect(skipped.steps[3]!.detail).toBe('跳过了');
    expect(skipped.next?.primary?.title).toBe('打印练习纸');
    expect(skipped.next?.primary?.action).toEqual({ kind: 'print', practiceID: 'pkt_this' });
    const reflected = make(input({ photos: ['job-1'], practices: [thisWeekPractice({ reflected: 3 })] }));
    expect(reflected.steps[3]!.detail).toBe('说了 3/3 道');
    expect(reflected.next?.primary?.title).toBe('打印练习纸');
  });

  it('正在准备练习纸', () => {
    const result = make(input({ photos: ['job-1'], practices: [thisWeekPractice({ reflected: 3 })], preparing: 'pkt_this' }));
    expect(result.steps[4]!.detail).toBe('正在准备练习纸…');
    expect(result.steps[4]!.tone).toBe('blue');
  });
});

describe('规则 1：做完了（≤ 1 天）', () => {
  it('今天刚生成：没有主按钮，只留「没打出来？现在打印」', () => {
    const printed = thisWeekPractice({ reflected: 3, generatedAt: date(2026, 10, 10, 9) });
    const result = make(input({ photos: ['job-1'], practices: [printed] }));
    expect(result.stage).toBe('done');
    expect(result.steps).toEqual([]);
    expect(result.next?.primary).toBeNull();
    expect(result.next?.caption).toBe('下次打开：下个周末，录结果');
    expect(titles(result.next?.secondary)).toEqual(['没打出来？现在打印']);
    expect(result.practice?.id).toBe('pkt_this');
  });

  it('昨晚 23:50 生成、今天 0:10 打开：按本地日历日算 1 天，仍是做完了', () => {
    const printed = thisWeekPractice({ generatedAt: date(2026, 10, 9, 23, 50) });
    expect(daysSince(date(2026, 10, 9, 23, 50), date(2026, 10, 10, 0, 10), TZ)).toBe(1);
    expect(make(input({ today: date(2026, 10, 10, 0, 10), practices: [printed] })).stage).toBe('done');
  });
});

describe('规则 2：周中（2–4 天）', () => {
  it.each([2, 3, 4])('距生成 %i 天是周中', daysAgo => {
    const result = make(input({ practices: [lastWeekPractice(daysAgo)] }));
    expect(result.stage).toBe('midweek');
    expect(result.next?.primary).toBeNull();
    expect(titles(result.next?.secondary)).toEqual(['已经做完了？现在录结果', '又发了卷子？现在拍']);
    expect(result.next?.secondary[0]?.action).toEqual({ kind: 'record', practiceID: 'pkt_last' });
  });

  it('周中录完了：回到新一周的周末 A，没有录结果', () => {
    const result = make(input({ practices: [lastWeekPractice(3, { items: 6, answered: 6, correct: 4 })] }));
    expect(result.stage).toBe('weekendA');
    expect(kinds(result)).not.toContain('record');
  });
});

describe('规则 3：下个周末（≥ 5 天）', () => {
  it('先拍后录：六步', () => {
    const result = make(input({ practices: [lastWeekPractice(7)] }));
    expect(result.stage).toBe('weekendB');
    expect(kinds(result)).toEqual(['shoot', 'record', 'pick', 'choose', 'why', 'print']);
    expect(header(result)).toBe('今天大约 16 分钟，一共 6 步');
    expect(result.steps[1]!.detail).toBe('AI 找题要几分钟，正好先录这个');
    expect(result.next?.primary?.title).toBe('拍第一页');
    expect(result.next?.caption).toBe('第 1 步，共 6 步 · 大约 2 分钟');
  });

  it('这周没发卷子：直接录结果', () => {
    const result = make(input({ practices: [lastWeekPractice(5)], skipped: ['shoot'] }));
    expect(result.stage).toBe('weekendB');
    expect(result.next?.primary?.title).toBe('录练习纸的结果');
    expect(result.next?.primary?.action).toEqual({ kind: 'record', practiceID: 'pkt_last' });
    expect(titles(result.next?.secondary)).toEqual(['先跳过，下次再录']);
    expect(result.next?.caption).toBe('第 2 步，共 6 步 · 大约 3 分钟');
  });

  it('拍完趁 AI 找题先录；跳过录结果后只能等', () => {
    const result = make(input({ local: [photo(1, 'finding', 'job-9')], practices: [lastWeekPractice(7)] }));
    expect(result.next?.primary?.title).toBe('录练习纸的结果');
    const skipped = make(input({ local: [photo(1, 'finding', 'job-9')], practices: [lastWeekPractice(7)], skipped: ['record'] }));
    expect(skipped.steps[1]!.detail).toBe('先跳过了，下次再录');
    expect(skipped.next?.isWaiting).toBe(true);
    expect(skipped.next?.secondary).toEqual([]);
  });

  it('录了一部分：显示进度', () => {
    const partly = make(input({ local: [photo(1, 'finding', 'job-9')], practices: [lastWeekPractice(7, { items: 6, answered: 2 })] }));
    expect(partly.steps[1]!.detail).toBe('录了 2/6 道');
    expect(partly.steps[1]!.tone).toBe('orange');
    expect(partly.currentIndex).toBe(1);
  });

  it('上周录完了：显示结果并往下走', () => {
    const result = make(input({ local: [photo(1, 'finding', 'job-9')], practices: [lastWeekPractice(7, { items: 6, answered: 6, correct: 4 })] }));
    expect(result.stage).toBe('weekendB');
    expect(result.steps[1]!.detail).toBe('录完了，6 道里独立做对 4 道');
    expect(result.steps[1]!.isDone).toBe(true);
    expect(result.steps[1]!.action).toEqual({ kind: 'summary', practiceID: 'pkt_last' });
    expect(result.next?.primary?.title).toBe('AI 正在找题…');
  });

  it('「先跳过录结果」只靠输入记着：不带跳过再算一次又会问', () => {
    const result = make(input({ practices: [lastWeekPractice(6)], skipped: ['shoot', 'record'] }));
    expect(result.steps[1]!.isDone).toBe(true);
    expect(result.next?.primary?.title).toBe('选这周要练的题');
    const reopened = make(input({ practices: [lastWeekPractice(6)], skipped: ['shoot'] }));
    expect(reopened.next?.primary?.title).toBe('录练习纸的结果');
  });

  it('没取到这份的回报：不说录完', () => {
    const p = lastWeekPractice(7, { answered: null });
    expect(allRecorded(p)).toBeNull();
    const result = make(input({ practices: [p], skipped: ['shoot'] }));
    expect(result.steps[1]!.isDone).toBe(false);
    expect(result.next?.primary?.title).toBe('录练习纸的结果');
  });

  it('评审修正：录完上一份、又建了这周的练习以后，录结果仍是完成', () => {
    const lastPrinted = new Date(saturday.getTime() - 7 * DAY);
    const list = [
      { id: 'pkt_q', week: thisWeek, createdAt: new Date(saturday.getTime() - 600_000).toISOString(), generatedAt: null, itemCount: 3, practiceSlot: '周三晚自习' },
      { id: 'pkt_p', week: lastWeek, createdAt: new Date(lastPrinted.getTime() - 600_000).toISOString(), generatedAt: lastPrinted.toISOString(), itemCount: 6, practiceSlot: '周三晚自习' },
    ];
    const current = {
      id: 'pkt_q', week: thisWeek, createdAt: new Date(saturday.getTime() - 600_000).toISOString(), generatedAt: null, practiceSlot: '周三晚自习',
      items: [{ reflected: false }, { reflected: false }, { reflected: false }],
    };
    const practices = practicesFrom(list, current, {
      pkt_p: { answered: 6, total: 6, independentCorrect: 4 }, pkt_q: { answered: 0, total: 3, independentCorrect: 0 },
    });
    expect(practices.map(p => p.id)).toEqual(['pkt_q', 'pkt_p']);
    const result = make(input({ photos: ['job-1'], items: 3, practices }));
    expect(result.stage).toBe('weekendB');
    expect(kinds(result)).toEqual(['shoot', 'record', 'pick', 'choose', 'why', 'print']);
    expect(result.steps[1]!.isDone).toBe(true);
    expect(result.steps[1]!.detail).toBe('录完了，6 道里独立做对 4 道');
    expect(result.next?.primary?.title).toBe('说说为什么错');
  });

  it('当前详情不在列表里时插到最前', () => {
    const practices = practicesFrom([], {
      id: 'pkt_new', week: thisWeek, createdAt: saturday.toISOString(), generatedAt: null, practiceSlot: null, items: [{ reflected: true }],
    }, {});
    expect(practices.map(p => p.id)).toEqual(['pkt_new']);
    expect(practices[0]!.reflectedCount).toBe(1);
  });

  it('评审修正：周一生成的练习纸到同一 ISO 周的周末要录结果', () => {
    const monday = date(2026, 10, 5, 19);
    const p = practice({ id: 'pkt_mon', week: thisWeek, generatedAt: monday, itemCount: 4, practiceSlot: '周三晚自习', reflectedCount: 4, answered: 0 });
    const result = make(input({ practices: [p] }));
    expect(daysSince(monday, saturday, TZ)).toBe(5);
    expect(result.stage).toBe('weekendB');
    expect(kinds(result)).toEqual(['shoot', 'record', 'pick', 'choose', 'why', 'print']);
    expect(result.steps[1]!.action).toEqual({ kind: 'record', practiceID: 'pkt_mon' });
    expect(result.steps[3]!.isDone).toBe(false);
    expect(result.currentIndex).toBe(0);
    expect(result.next?.primary?.title).toBe('拍第一页');
  });
});

describe('§3.4 打开的日子不对', () => {
  it('两周没打开：写明是哪天的那一份', () => {
    const result = make(input({ practices: [lastWeekPractice(14)] }));
    expect(result.stage).toBe('weekendB');
    expect(result.steps[1]!.detail).toBe('上一份练习纸（9/26）还没录');
  });

  it('选了题没打印就关了：停在说说为什么错', () => {
    const result = make(input({ photos: ['job-1'], practices: [thisWeekPractice({ items: 3, reflected: 1 })] }));
    expect(result.stage).toBe('weekendA');
    expect(result.next?.primary?.title).toBe('说说为什么错');
  });

  it('上周日选的、周一打开：还是那份要打印', () => {
    const carried = practice({ id: 'pkt_sun', week: lastWeek, createdAt: date(2026, 10, 4, 20), generatedAt: null, itemCount: 4, reflectedCount: 4 });
    const result = make(input({ today: date(2026, 10, 5, 18), practices: [carried] }));
    expect(result.steps[2]!.isDone).toBe(true);
    expect(result.next?.primary?.action).toEqual({ kind: 'print', practiceID: 'pkt_sun' });
  });

  it('很久以前忘了打印的那份不再算这周的', () => {
    const stale = practice({ id: 'pkt_old', week: lastWeek, createdAt: date(2026, 10, 1, 20), generatedAt: null, itemCount: 4, reflectedCount: 4 });
    const result = make(input({ practices: [stale] }));
    expect(result.stage).toBe('weekendA');
    expect(result.steps[0]!.isDone).toBe(false);
    expect(result.steps[2]!.isDone).toBe(false);
    expect(result.next?.primary?.title).toBe('拍第一页');
  });

  it('本周选的、没有建包时间：仍是这周的', () => {
    const chosen = practice({ id: 'pkt_this', week: thisWeek, generatedAt: null, itemCount: 3, reflectedCount: 3 });
    expect(make(input({ practices: [chosen] })).next?.primary?.action).toEqual({ kind: 'print', practiceID: 'pkt_this' });
  });

  it('当天就录完：全部打勾、没有按钮，只说已生成', () => {
    const printed = thisWeekPractice({ reflected: 3, generatedAt: date(2026, 10, 10, 9), answered: 3 });
    const result = make(input({ photos: ['job-1'], practices: [printed] }));
    expect(result.stage).toBe('weekendA');
    expect(result.currentIndex).toBeNull();
    expect(result.next).toBeNull();
    expect(result.steps[4]!.detail).toBe('练习纸已生成');
  });
});

describe('没联网 / 服务器忙 / 连不上', () => {
  it('没联网：需要服务器的按钮变灰，拍照不受影响', () => {
    const shooting = make(input({ connection: 'offline' }));
    expect(shooting.next?.isEnabled).toBe(true);
    expect(titles(shooting.next?.secondary)).toEqual(['这周没发卷子，跳过']);
    const choosing = make(input({ connection: 'offline', skipped: ['shoot'] }));
    expect(choosing.stage).toBe('weekendA');
    expect(choosing.next?.primary?.title).toBe('选这周要练的题');
    expect(choosing.next?.isEnabled).toBe(false);
    expect(choosing.next?.caption).toBe('没联网，连上后再继续');
  });

  it('服务器忙与连不上：说明原因', () => {
    const busy = make(input({ connection: 'busy', skipped: ['shoot'] }));
    expect(busy.next?.caption).toBe('服务器有点忙，过一会儿再试');
    expect(busy.next?.isEnabled).toBe(false);
    expect(make(input({ connection: 'failed', skipped: ['shoot'] })).next?.caption).toBe('连不上服务器，连上后再继续');
  });

  it('等 AI 时没联网：停止转圈', () => {
    const result = make(input({ connection: 'offline', local: [photo(1, 'finding', 'job-1')] }));
    expect(result.next?.isWaiting).toBe(false);
    expect(result.next?.isEnabled).toBe(false);
    expect(result.next?.caption).toBe('没联网，连上后再继续');
  });

  it('周中没联网：只留手机上能做的', () => {
    const result = make(input({ connection: 'offline', practices: [lastWeekPractice(3)] }));
    expect(result.stage).toBe('midweek');
    expect(titles(result.next?.secondary)).toEqual(['又发了卷子？现在拍']);
    expect(result.next?.caption).toBe('没联网，连上后再继续');
  });

  it('做完了没联网：保留下次打开那句', () => {
    const result = make(input({ connection: 'offline', practices: [thisWeekPractice({ generatedAt: date(2026, 10, 10, 9) })] }));
    expect(result.stage).toBe('done');
    expect(result.next?.secondary).toEqual([]);
    expect(result.next?.caption).toBe('下次打开：下个周末，录结果');
  });
});

describe('需要服务器的动作', () => {
  it('与 Swift NextStepAction.needsServer 一致', () => {
    expect(needsServer({ kind: 'capture' })).toBe(false);
    expect(needsServer({ kind: 'skipShoot' })).toBe(false);
    expect(needsServer({ kind: 'skipRecord' })).toBe(false);
    expect(needsServer({ kind: 'choose' })).toBe(true);
    expect(needsServer({ kind: 'print', practiceID: 'p' })).toBe(true);
    expect(needsServer({ kind: 'uploadPending' })).toBe(true);
  });
});
