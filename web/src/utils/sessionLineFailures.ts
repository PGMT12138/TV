import { useSyncExternalStore } from 'react';

export type SessionLineFailure = { movieId: string; siteKey: string; vodId: string; flag: string; reason: string };
// 只存在于当前页面的 JS 内存中；站内返回/重新搜索保留，刷新或关闭页面即清除。
let failures: ReadonlyMap<string, SessionLineFailure> = new Map();
const listeners = new Set<() => void>();
const keyOf = (movieId: string, siteKey: string, vodId: string, flag = '') => JSON.stringify([movieId, siteKey, vodId, flag]);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => failures;
export const useSessionLineFailures = () => useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
export const getSessionLineFailure = (movieId: string, siteKey: string, vodId: string, flag?: string) =>
  failures.get(keyOf(movieId, siteKey, vodId, flag));
export function markSessionLineFailure(failure: SessionLineFailure) {
  const key = keyOf(failure.movieId, failure.siteKey, failure.vodId, failure.flag);
  if (failures.has(key)) return;
  failures = new Map(failures).set(key, failure);
  listeners.forEach((listener) => listener());
}
