import { useCallback, useEffect, useState } from 'react';
import { RequestError } from './api';
import { uploader, type UploadEntry } from './uploader';

export interface Loaded<T> { data: T | null; error: RequestError | null; loading: boolean; reload: () => Promise<void> }

/** 取一份数据；stageRequired 由页面统一处理（先选学段）。 */
export function useLoad<T>(load: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<RequestError | null>(null);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try { setData(await load()); setError(null); }
    catch (caught) { setError(caught instanceof RequestError ? caught : new RequestError(0, 'network', '暂时连不上，稍后再试。')); }
    finally { setLoading(false); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { void reload(); }, [reload]);
  return { data, error, loading, reload };
}

export function useUploads(): UploadEntry[] {
  const [entries, setEntries] = useState(uploader.entries);
  useEffect(() => uploader.subscribe(() => setEntries(uploader.entries)), []);
  return entries;
}

/** 本机偏好（网格 / 列表）：只是显示方式，不涉及任何内容。 */
export function useLocalPreference(key: string, fallback: string): [string, (value: string) => void] {
  const [value, setValue] = useState(() => { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } });
  const update = useCallback((next: string) => { setValue(next); try { localStorage.setItem(key, next); } catch { /* 隐私模式 */ } }, [key]);
  return [value, update];
}
