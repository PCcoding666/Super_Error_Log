import type { ApiError, DiscardResponse, IntakeResponse, ItemDetailResponse, ItemInsight, ItemRemark, NotebookResponse, SettingsResponse, UploadModeResponse } from '../../../src/web/apiTypes';

export class RequestError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: { accept: 'application/json', ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
  });
  const type = response.headers.get('content-type') ?? '';
  if (!type.includes('application/json')) {
    // 登录过期时网关回登录页（HTML）；整页跳过去让学生重新登录。
    if (response.status === 401 || response.status === 403 || response.redirected || response.status === 200) { location.assign('/s/'); }
    throw new RequestError(response.status, 'not_json', '暂时连不上，稍后再试。');
  }
  const body = (await response.json()) as T | ApiError;
  if (!response.ok) {
    const error = (body as ApiError).error ?? { code: 'unknown', message: '暂时连不上，稍后再试。' };
    throw new RequestError(response.status, error.code, error.message);
  }
  return body as T;
}

export const api = {
  notebook: (query: Record<string, string>) => call<NotebookResponse>(`/s/api/notebook?${new URLSearchParams(query)}`),
  item: (id: string) => call<ItemDetailResponse>(`/s/api/items/${encodeURIComponent(id)}`),
  discard: (ids: string[]) => call<DiscardResponse>('/s/api/items/discard', { method: 'POST', body: JSON.stringify({ ids }) }),
  restore: (id: string) => call<{ ok: true }>(`/s/api/items/${encodeURIComponent(id)}/restore`, { method: 'POST', body: '{}' }),
  insight: (id: string) => call<ItemInsight>(`/s/api/items/${encodeURIComponent(id)}/insight`),
  requestInsight: (id: string) => call<ItemInsight>(`/s/api/items/${encodeURIComponent(id)}/insight`, { method: 'POST', body: '{}' }),
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
