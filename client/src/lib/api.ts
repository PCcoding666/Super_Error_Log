import type { ApiError, DiscardResponse, IntakeResponse, ItemAnswerPhoto, ItemDetailResponse, ItemInsight, ItemRemark, NotebookResponse, SettingsResponse, UploadModeResponse } from '../../../src/web/apiTypes';
import { report } from './report';

export class RequestError extends Error {
  /** requestId：服务器给这次请求的编号（响应头 x-sel-request-id / 错误 JSON 里的 requestId）；页面上显示成「错误编号」。 */
  constructor(public status: number, public code: string, message: string, public requestId: string | null = null) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
  } catch (error) {
    // 请求根本没发出去 / 没回来（断网、被壳拦截）：服务器看不到，由浏览器报一条。
    report('api_network', { code: error instanceof Error ? error.name : 'fetch', message: error instanceof Error ? error.message : undefined });
    throw new RequestError(0, 'network', '网络没连上，稍后再试。');
  }
  const rid = response.headers.get('x-sel-request-id');
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    // 登录过期时网关回登录页（HTML）；整页跳过去让学生重新登录。
    if (response.status === 401 || response.status === 403 || response.redirected || response.status === 200) { location.assign('/s/'); }
    else report('api_not_json', { code: `http_${response.status}`, status: response.status, rid });
    throw new RequestError(response.status, 'not_json', '暂时连不上，稍后再试。', rid);
  }
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const error = (body as ApiError).error ?? { code: 'unknown', message: '暂时连不上，稍后再试。' };
    const requestId = error.requestId ?? rid;
    if (response.status >= 500) report('api_server_error', { code: error.code, status: response.status, rid: requestId });
    throw new RequestError(response.status, error.code, error.message, requestId);
  }
  return body as T;
}

export const api = {
  notebook: (query: Record<string, string>) => call<NotebookResponse>(`/s/api/notebook?${new URLSearchParams(query)}`),
  item: (id: string) => call<ItemDetailResponse>(`/s/api/items/${encodeURIComponent(id)}`),
  discard: (ids: string[]) => call<DiscardResponse>('/s/api/items/discard', { method: 'POST', body: JSON.stringify({ ids }) }),
  restore: (id: string) => call<{ ok: true }>(`/s/api/items/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' }),
  insight: (id: string) => call<ItemInsight>(`/s/api/items/${encodeURIComponent(id)}/insight`),
  requestInsight: (id: string, retry = false) => call<ItemInsight>(`/s/api/items/${encodeURIComponent(id)}/insight`, { method: 'POST', body: JSON.stringify({ retry }) }),
  /** 改识别出的文字：target 是 'question'（题干）或观察 ID。 */
  editText: (id: string, revision: number, target: string, text: string) => call<{ revision: number }>(`/s/api/items/${encodeURIComponent(id)}/text`, { method: 'POST', body: JSON.stringify({ revision, target, text }) }),
  addAnswerPhoto: (id: string, jpeg: Blob) => call<{ photo: ItemAnswerPhoto }>(`/s/api/items/${encodeURIComponent(id)}/answer-photos`, { method: 'POST', body: jpeg, headers: { 'content-type': 'image/jpeg' } }),
  editAnswerPhoto: (id: string, photoId: string, text: string) => call<{ photo: ItemAnswerPhoto }>(`/s/api/items/${encodeURIComponent(id)}/answer-photos/${encodeURIComponent(photoId)}`, { method: 'POST', body: JSON.stringify({ text }) }),
  retryAnswerPhoto: (id: string, photoId: string) => call<{ ok: true }>(`/s/api/items/${encodeURIComponent(id)}/answer-photos/${encodeURIComponent(photoId)}/retry`, { method: 'POST', body: '{}' }),
  deleteAnswerPhoto: (id: string, photoId: string) => call<{ ok: true }>(`/s/api/items/${encodeURIComponent(id)}/answer-photos/${encodeURIComponent(photoId)}/delete`, { method: 'POST', body: '{}' }),
  remark: (id: string, text: string) => call<{ remark: ItemRemark }>(`/s/api/items/${encodeURIComponent(id)}/remark`, { method: 'POST', body: JSON.stringify({ text }) }),
  category: (id: string, values: { grade: string; subject: string; chapter: string }) => call<{ ok: true }>(`/s/api/items/${encodeURIComponent(id)}/category`, { method: 'POST', body: JSON.stringify(values) }),
  settings: () => call<SettingsResponse>('/s/api/settings'),
  grade: (grade: string) => call<{ ok: true }>('/s/api/settings/grade', { method: 'POST', body: JSON.stringify({ grade }) }),
  intake: () => call<IntakeResponse>('/s/api/intake'),
  uploadMode: () => call<UploadModeResponse>('/s/api/upload'),
  select: (photoId: string, ids: string[]) => call<{ ok: true }>(`/s/api/intake/photos/${encodeURIComponent(photoId)}/select`, { method: 'POST', body: JSON.stringify({ ids }) }),
  retry: (photoId: string) => call<{ ok: true }>(`/s/api/intake/photos/${encodeURIComponent(photoId)}/retry`, { method: 'POST', body: '{}' }),
  dismiss: (photoId: string) => call<{ ok: true }>(`/s/api/intake/photos/${encodeURIComponent(photoId)}/dismiss`, { method: 'POST', body: '{}' }),
};
