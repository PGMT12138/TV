// 后端（manage FastAPI）接口封装。同源部署（/cine 与 /api 同一服务），开发时由 vite 代理。
import type { MovieItem, UserProfile, ResourceMatch, WatchHistoryItem, CatalogSection, LiveListData, LivePlayData, LiveEpgData, LiveFavoriteItem, LiveHistoryItem, LiveProbeResult } from './types';

/** /api/resource/search/stream 的 SSE 事件。 */
export interface SearchStreamEvent {
  type: 'meta' | 'site' | 'done' | 'error';
  sites?: number;          // meta：本次实时搜索的站点总数
  cached?: boolean;        // meta/done：缓存命中（site 事件合并为一次下发）
  siteKey?: string;        // site：来源站点（缓存命中时缺省）
  siteName?: string;
  matched?: ResourceMatch[];
  searched?: number;       // done：实际搜索的站点数
  deviceOnline?: boolean;  // error：设备离线
  error?: string;
}

async function request<T = any>(url: string, options: RequestInit = {}): Promise<T> {
  const resp = await fetch(url, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  let data: any = null;
  try {
    data = await resp.json();
  } catch {
    data = {};
  }
  if (resp.status === 401) {
    throw Object.assign(new Error(data.error || '未登录'), { status: 401 });
  }
  if (!resp.ok) {
    throw Object.assign(new Error(data.error || `请求失败 (${resp.status})`), { status: resp.status });
  }
  return data as T;
}

export const api = {
  // ---- 认证 ----
  me: () => request<{ user: UserProfile | null }>('/api/auth/me'),
  login: (username: string, password: string) =>
    request<{ ok: boolean; user: UserProfile; error?: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  register: (username: string, password: string) =>
    request<{ ok: boolean; user: UserProfile; error?: string }>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),
  logout: () => request('/api/auth/logout', { method: 'POST' }),

  // ---- 片库 ----
  catalogAll: () => request<{ list: MovieItem[]; sections: CatalogSection[] }>('/api/catalog/all'),
  catalogDetail: (id: string) => request<MovieItem & { error?: string }>(`/api/catalog/detail?id=${encodeURIComponent(id)}`),
  catalogSearch: (wd: string) =>
    request<{ list: MovieItem[] }>(`/api/catalog/search?wd=${encodeURIComponent(wd)}`),
  explore: (p: { type?: string; genre?: string; region?: string; year?: string; sort?: string; cursor?: string }) => {
    const q = new URLSearchParams({
      type: p.type || 'all', genre: p.genre || '', region: p.region || '',
      year: p.year || '', sort: p.sort || 'trending', ...(p.cursor ? { cursor: p.cursor } : {}),
    });
    return request<{ list: MovieItem[]; cursor: string; done: boolean }>(`/api/catalog/explore?${q}`);
  },

  // ---- 播放资源（经设备桥） ----
  resourceSearch: (wd: string) =>
    request<{ deviceOnline: boolean; results: ResourceMatch[]; searched: number; error?: string }>(
      `/api/resource/search?wd=${encodeURIComponent(wd)}`
    ),
  // SSE 逐站推送版聚合搜索：done/error 后自动断开；连接中断回调一个合成 error 事件并关闭
  resourceSearchStream: (wd: string, onEvent: (ev: SearchStreamEvent) => void): EventSource => {
    const es = new EventSource(`/api/resource/search/stream?wd=${encodeURIComponent(wd)}`);
    es.onmessage = (evt) => {
      let ev: SearchStreamEvent;
      try {
        ev = JSON.parse(evt.data);
      } catch {
        return;
      }
      onEvent(ev);
      if (ev.type === 'done' || ev.type === 'error') {
        es.onerror = null;
        es.close();
      }
    };
    es.onerror = () => {
      es.close();
      onEvent({ type: 'error', error: '连接中断' });
    };
    return es;
  },
  resourceAdopt: (key: string, id: string) =>
    request<{ ok: boolean; movie: MovieItem | null; error?: string }>('/api/resource/adopt', {
      method: 'POST',
      body: JSON.stringify({ key, id }),
    }),
  siteDetail: (key: string, id: string) =>
    request<{
      name: string; pic: string; year: string; area: string; typeName: string; director: string;
      actor: string; content: string; remarks: string; error?: string;
      flags: { flag: string; episodes: { name: string; url: string }[] }[];
    }>(`/api/detail?key=${encodeURIComponent(key)}&id=${encodeURIComponent(id)}`),
  player: (key: string, flag: string, id: string) =>
    request<{ url: string; play: string; hls: boolean; local: boolean; error?: string }>(
      `/api/player?key=${encodeURIComponent(key)}&flag=${encodeURIComponent(flag)}&id=${encodeURIComponent(id)}`
    ),
  deviceStatus: () => request<{ online: boolean; name: string; version: string }>('/api/device'),
  resourceScan: (candidates: { key: string; id: string; name?: string }[], refDurationS?: number) =>
    request<{ scanId: string; sites: number; error?: string }>('/api/resource/scan', {
      method: 'POST',
      body: JSON.stringify({ candidates, refDurationS: refDurationS || undefined }),
    }),

  // ---- 直播（经设备桥，直连优先） ----
  liveList: (live = '') =>
    request<LiveListData>(`/api/live/list?live=${encodeURIComponent(live)}`),
  livePlay: (live: string, group: string, channel: string, line = 0) => {
    const q = new URLSearchParams({ live, group, channel, line: String(line) });
    return request<LivePlayData>(`/api/live/play?${q}`);
  },
  liveEpg: (live: string, group: string, channel: string) => {
    const q = new URLSearchParams({ live, group, channel });
    return request<LiveEpgData>(`/api/live/epg?${q}`);
  },
  liveFavorites: () => request<{ list: LiveFavoriteItem[] }>('/api/live/favorites'),
  liveHistory: () => request<{ list: LiveHistoryItem[] }>('/api/live/history'),
  saveLiveHistory: (body: LiveHistoryItem) =>
    request<{ ok: boolean }>('/api/live/history', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  toggleLiveFavorite: (body: LiveFavoriteItem) =>
    request<{ ok: boolean; favorited: boolean }>('/api/live/favorites/toggle', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  saveLiveFavoriteLine: (body: LiveFavoriteItem) =>
    request<{ ok: boolean }>('/api/live/favorites/line', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  liveScan: (live: string, group = '') =>
    request<{ scanId: string; total: number; error?: string }>('/api/live/scan', {
      method: 'POST',
      body: JSON.stringify({ live, group }),
    }),
  liveScanCancel: (scanId: string) =>
    request<{ ok: boolean }>(`/api/live/scan/${scanId}/cancel`, { method: 'POST' }),
  liveProbe: (live: string) =>
    request<{ list: LiveProbeResult[]; ttl: number }>(`/api/live/probe?live=${encodeURIComponent(live)}`),
  liveGroups: (live: string) =>
    request<{ name: string; groups: number; channels: number; error?: string }>(`/api/live/groups?live=${encodeURIComponent(live)}`),

  // ---- 用户数据 ----
  favorites: () => request<{ list: MovieItem[] }>('/api/user/favorites'),
  toggleFavorite: (movie: Pick<MovieItem, 'id' | 'title' | 'cover' | 'rating' | 'year' | 'type'>) =>
    request<{ ok: boolean; favorited: boolean; count: number }>('/api/user/favorites/toggle', {
      method: 'POST',
      body: JSON.stringify(movie),
    }),
  history: () => request<{ list: WatchHistoryItem[] }>('/api/user/history'),
  saveHistory: (body: Partial<WatchHistoryItem>) =>
    request<{ ok: boolean }>('/api/user/history', { method: 'POST', body: JSON.stringify(body) }),
  deleteHistory: (id: string) => request(`/api/user/history/${id}`, { method: 'DELETE' }),
};

/** 图片统一走服务端透传（后端 row_to_item 已把外链改写为 /api/img 相对路径，直链兜底）。 */
export function imgUrl(url: string | undefined | null): string {
  if (!url) return '';
  if (url.startsWith('/api/') || url.startsWith('data:')) return url;
  return `/api/img?url=${encodeURIComponent(url)}`;
}
