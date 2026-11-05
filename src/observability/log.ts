/**
 * 主进程与学生 worker 共用的一行一条 JSON 日志（写 stderr；systemd 下进 journald）。
 *
 * 约定（deploy/ops/RUNBOOK.md「学生说出问题了怎么查」）：
 * - 每行 `{ "event": "sel_…", "level": "info|warn|error", "at": ISO 时间, ...字段 }`，worker 的行会被父进程
 *   加 `[worker xxxxxxxx] ` 前缀（workers.ts forwardWorkerStderr），巡检脚本的 countEvents 两种都能解析。
 * - 只放元数据：请求 ID、方法、路由模板、状态码、耗时、学生 ID 前 8 位、错误类别、浏览器家族。
 *   绝不放题目、照片、姓名、手机号、邀请码、会话 / 设备令牌、cookie、密钥、原始 User-Agent、查询串。
 * - 请求 ID 由网关生成，经内部头 x-sel-internal-request-id 交给 worker，并以 x-sel-request-id 响应头回给浏览器；
 *   学生看到的错误提示带「错误编号」就是它，三边日志用它对上。
 *
 * 事件一览：
 *   sel_http            网关每个请求一行（静态资源与成功的图片不记）
 *   sel_login           邀请码登录结果（成功 / 码不对 / 限速），带 IP
 *   sel_proxy_error     转发到 worker 失败：起不来、名额满、上游断开、超时
 *   sel_worker_start    worker 拉起成功（耗时、当前存活数）
 *   sel_worker_stop     worker 按预期退出（空闲 / 腾位置 / 关闭）
 *   sel_worker_error    worker 崩溃 / 启动失败（workers.ts 原有）
 *   sel_request_failed  worker 内处理请求抛了未预期的错误（500）
 *   sel_client_event    浏览器上报的脚本错误 / 上传失败 / 接口失败（src/web/api.ts /client-log）
 */
import crypto from 'node:crypto';

export type LogLevel = 'info' | 'warn' | 'error';
export type LogValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogValue>;

const MAX_STRING = 500;
const REQUEST_ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

type Sink = (line: string) => void;
const defaultSink: Sink = line => {
  try { process.stderr.write(`${line}\n`); } catch { /* stderr 已关闭 */ }
};
let sink: Sink = defaultSink;

/** 测试用：拦截日志行。传 null 恢复写 stderr。 */
export function setLogSink(next: Sink | null): void {
  sink = next ?? defaultSink;
}

/** 写一行。字段里的 undefined 丢掉，字符串截到 500 字；序列化失败也不能影响业务。 */
export function logEvent(event: string, level: LogLevel, fields: LogFields = {}): void {
  const record: Record<string, string | number | boolean | null> = { event, level, at: new Date().toISOString() };
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || key === 'event' || key === 'level' || key === 'at') continue;
    record[key] = typeof value === 'string' && value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…` : value;
  }
  try { sink(JSON.stringify(record)); } catch { /* 日志不能把业务打挂 */ }
}

/** 12 个小写字母数字（去掉易混的 0/o/1/l/i），够一天内在日志里唯一，也方便学生照着念。 */
export function newRequestId(): string {
  const bytes = crypto.randomBytes(12);
  let id = '';
  for (let i = 0; i < 12; i += 1) id += REQUEST_ID_ALPHABET[bytes[i]! % REQUEST_ID_ALPHABET.length];
  return id;
}

const REQUEST_ID = /^[a-z0-9]{8,32}$/;
/** 只认我们自己生成的形状；别的一律当没有（不信任任何外来值）。 */
export function requestIdOf(value: unknown): string | null {
  return typeof value === 'string' && REQUEST_ID.test(value) ? value : null;
}

export type UaFamily = 'ios-safari' | 'ios-webview' | 'android-chrome' | 'android-webview' | 'android-other' | 'wechat' | 'desktop' | 'other' | 'none';

/** 把 User-Agent 压成几个家族，够回答「是不是只有某种手机 / 微信里出事」；原始 UA 不进日志。 */
export function uaFamily(userAgent: string | string[] | undefined): UaFamily {
  const ua = Array.isArray(userAgent) ? userAgent[0] ?? '' : userAgent ?? '';
  if (!ua) return 'none';
  if (/MicroMessenger/i.test(ua)) return 'wechat';
  if (/iPhone|iPad|iPod/i.test(ua)) return /Safari\//i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua) ? 'ios-safari' : 'ios-webview';
  if (/Android/i.test(ua)) {
    // 真正的 WebView（「添加到桌面」的壳、App 内置页）带 "; wv)"；各家国产浏览器与系统浏览器带 Version/x Chrome 或自己的名字。
    if (/; wv\)/.test(ua)) return 'android-webview';
    if (/MiuiBrowser|HuaweiBrowser|HeyTapBrowser|VivoBrowser|UCBrowser|QQBrowser|Quark|Version\/\d+\.\d+ Chrome/i.test(ua)) return 'android-other';
    if (/Chrome\//i.test(ua)) return 'android-chrome';
    return 'android-other';
  }
  if (/Windows NT|Macintosh|X11; Linux|CrOS/i.test(ua)) return 'desktop';
  return 'other';
}

/** 把一个 unknown 错误压成三个可记的字段：类名、消息（截短）、栈的前三帧（只有文件:行号，没有参数）。 */
export function errorSummary(error: unknown): { errName: string; errMessage: string; errStack: string | undefined } {
  if (error instanceof Error) {
    const frames = (error.stack ?? '').split('\n').slice(1).map(line => line.trim()).filter(line => line.startsWith('at ')).slice(0, 3);
    return { errName: error.name || 'Error', errMessage: error.message.slice(0, 300), errStack: frames.length ? frames.join(' | ').slice(0, 600) : undefined };
  }
  return { errName: typeof error, errMessage: String(error).slice(0, 300), errStack: undefined };
}

/** 毫秒数（整数）：从 process.hrtime.bigint() 起算。 */
export function elapsedMs(startedAt: bigint): number {
  return Number((process.hrtime.bigint() - startedAt) / 1_000_000n);
}
