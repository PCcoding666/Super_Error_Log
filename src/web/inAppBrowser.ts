/** 聊天软件/应用内置浏览器识别（旧配对页与邀请码登录/注册页共用）。只看 User-Agent，不做任何追踪。 */
export const IN_APP_BROWSER_PATTERN = /MicroMessenger|QQ\/|Weibo|DingTalk|AlipayClient|Lark|FBAN|FBAV|Instagram/i;

export function isInAppBrowserAgent(userAgent: string | undefined): boolean {
  return IN_APP_BROWSER_PATTERN.test(userAgent ?? '');
}

/** 微信内置浏览器（需要提示「右上角 … → 在浏览器打开」）。 */
export function isWeChatAgent(userAgent: string | undefined): boolean {
  return /MicroMessenger/i.test(userAgent ?? '');
}
