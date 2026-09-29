import { Router } from 'express';

export const V2_PROTOCOL_VERSION = 2 as const;

/**
 * /v2 手机接口路由（v2.0 T2 起装配；业务接口在 T4 增加）。
 * 鉴权由挂载方统一施加（与 /v1 同一中间件：云端设备令牌 / 回环共享令牌），本路由器不再鉴权。
 */
export function createV2Router(): Router {
  const r = Router();
  r.get('/health', (_request, response) => {
    response.json({ protocolVersion: V2_PROTOCOL_VERSION });
  });
  return r;
}
