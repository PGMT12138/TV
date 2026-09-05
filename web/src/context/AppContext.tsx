import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { MovieItem, WatchHistoryItem, PageView, FilterState, UserProfile, ResourceState, ResourceMatch, ResourceFlag, Episode, CatalogSection, ScanState, ScanCandidateResult } from '../types';
import { api } from '../api';

interface ToastState {
  id: string;
  message: string;
  type?: 'success' | 'info' | 'warning';
}

const EMPTY_RESOURCE: ResourceState = {
  status: 'idle',
  matches: [],
  flags: [],
  activeFlagIndex: 0,
};

interface AppContextType {
  currentPage: PageView;
  appReady: boolean;                // 启动会话检查完成前为 false（避免登录页闪现）
  catalogReady: boolean;
  selectedMovieId: string | null;
  selectedEpisodeId: string | null;
  filterState: FilterState;
  watchHistory: WatchHistoryItem[];
  favorites: string[];
  favoriteMovies: MovieItem[];
  toasts: ToastState[];
  searchModalOpen: boolean;
  currentUser: UserProfile | null;
  movies: MovieItem[];
  sections: CatalogSection[];
  movieResources: Record<string, ResourceState>;
  deviceOnline: boolean;
  deviceName: string;
  navigateTo: (page: PageView, params?: { movieId?: string; episodeId?: string; query?: string; genre?: string }) => void;
  goBack: () => void;
  saveBrowse: (state: { key: string; items: MovieItem[]; cursor: string; done: boolean }) => void;
  restoreBrowse: (key: string) => { items: MovieItem[]; cursor: string; done: boolean } | null;
  updateFilter: (partial: Partial<FilterState>) => void;
  resetFilter: () => void;
  toggleFavorite: (movieId: string) => void;
  isFavorite: (movieId: string) => boolean;
  recordWatchProgress: (movieId: string, episodeId: string, watchedSeconds: number, totalSeconds: number) => void;
  deleteHistoryItem: (id: string) => void;
  clearAllHistory: () => void;
  showToast: (message: string, type?: 'success' | 'info' | 'warning') => void;
  getMovieById: (id: string) => MovieItem | undefined;
  setSearchModalOpen: (open: boolean) => void;
  login: (account: string, pass: string) => Promise<void>;
  logout: () => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  mergeMovies: (items: MovieItem[]) => void;
  loadMovieDetail: (id: string) => Promise<MovieItem | undefined>;
  resolveResources: (movieId: string) => Promise<void>;
  selectMatch: (movieId: string, match: ResourceMatch, manual?: boolean) => Promise<ResourceFlag[] | undefined>;
  selectFlag: (movieId: string, index: number, manual?: boolean) => void;
  currentEpisodes: (movieId: string) => { flag: string; episodes: Episode[] } | null;
  startScan: (movieId: string) => void;
  probeSite: (movieId: string, siteKey: string) => void;  // 选源弹窗懒补测：单站重扫，结果并入现有扫描
  reprobeSites: (movieId: string, siteKeys: string[]) => void; // 强制重探：全量实测不早停（全部/单站共用）
  probingSites: Set<string>;                              // 懒补测进行中的站点
  patchScan: (movieId: string, patch: Partial<ScanState>) => void;
  patchResource: (movieId: string, patch: Partial<ResourceState>) => void;
  refreshDeviceStatus: () => void;
}

const DEFAULT_FILTER: FilterState = {
  type: 'all',
  genre: '全部',
  region: '全部',
  year: '全部',
  sort: 'trending',
  query: '',
};

const AppContext = createContext<AppContextType | null>(null);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [currentPage, setCurrentPage] = useState<PageView>('home');
  const [selectedMovieId, setSelectedMovieId] = useState<string | null>(null);
  const [selectedEpisodeId, setSelectedEpisodeId] = useState<string | null>(null);
  const [filterState, setFilterState] = useState<FilterState>(DEFAULT_FILTER);
  const [toasts, setToasts] = useState<ToastState[]>([]);
  const [searchModalOpen, setSearchModalOpen] = useState(false);

  const [appReady, setAppReady] = useState(false);
  const [catalogReady, setCatalogReady] = useState(false);
  const [currentUser, setCurrentUser] = useState<UserProfile | null>(null);
  const [movies, setMovies] = useState<MovieItem[]>([]);
  const [sections, setSections] = useState<CatalogSection[]>([]);
  const [watchHistory, setWatchHistory] = useState<WatchHistoryItem[]>([]);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [favoriteMovies, setFavoriteMovies] = useState<MovieItem[]>([]);
  const [movieResources, setMovieResources] = useState<Record<string, ResourceState>>({});
  const [deviceOnline, setDeviceOnline] = useState(false);
  const [deviceName, setDeviceName] = useState('');

  const moviesRef = useRef(movies);
  const historyRef = useRef(watchHistory);
  moviesRef.current = movies;
  historyRef.current = watchHistory;
  const movieResourcesRef = useRef(movieResources);
  movieResourcesRef.current = movieResources;
  const resolvingRef = useRef<Set<string>>(new Set());

  const showToast = (message: string, type: 'success' | 'info' | 'warning' = 'info') => {
    const id = Math.random().toString(36).substring(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 2800);
  };

  const forceLogout = (message?: string) => {
    setCurrentUser(null);
    setWatchHistory([]);
    setFavorites([]);
    setFavoriteMovies([]);
    if (message) showToast(message, 'warning');
  };

  // ---- 启动：会话检查 + 片库/用户数据加载 ----
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { user } = await api.me();
        if (cancelled) return;
        setCurrentUser(user);
        if (user) {
          const [fav, hist] = await Promise.all([api.favorites(), api.history()]);
          if (cancelled) return;
          setFavorites(fav.list.map((m) => m.id));
          setFavoriteMovies(fav.list);
          setWatchHistory(hist.list);
        }
      } catch {
        // 后端未启动等情况：保持未登录态
      } finally {
        if (!cancelled) setAppReady(true);
      }
      try {
        const { list, sections: secs } = await api.catalogAll();
        if (!cancelled) {
          setMovies(list);
          if (secs?.length) setSections(secs);
        }
      } catch {
        if (!cancelled) showToast('片库加载失败，请确认服务端已启动', 'warning');
      } finally {
        if (!cancelled) setCatalogReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ---- 设备在线状态轮询 ----
  const refreshDeviceStatus = useCallback(() => {
    api.deviceStatus()
      .then((d) => { setDeviceOnline(!!d.online); setDeviceName(d.name || ''); })
      .catch(() => setDeviceOnline(false));
  }, []);

  useEffect(() => {
    refreshDeviceStatus();
    const timer = setInterval(refreshDeviceStatus, 30000);
    return () => clearInterval(timer);
  }, [refreshDeviceStatus]);

  // ---- 片库工具 ----
  const mergeMovies = useCallback((items: MovieItem[]) => {
    setMovies((prev) => {
      const map = new Map<string, MovieItem>(prev.map((m) => [m.id, m] as [string, MovieItem]));
      let changed = false;
      for (const item of items) {
        const old = map.get(item.id);
        if (!old) {
          map.set(item.id, item);
          changed = true;
        } else {
          // 用更完整的字段覆盖（详情补全后 cast/description 更全）
          const merged: MovieItem = { ...old, ...item, cast: item.cast?.length ? item.cast : old.cast, episodes: old.episodes };
          map.set(item.id, merged);
          if (merged !== old) changed = true;
        }
      }
      return changed ? Array.from(map.values()) : prev;
    });
  }, []);

  const getMovieById = useCallback((id: string) => moviesRef.current.find((m) => m.id === id), []);

  const loadMovieDetail = useCallback(async (id: string) => {
    const local = moviesRef.current.find((m) => m.id === id);
    try {
      const detail = await api.catalogDetail(id);
      if (detail?.error || !detail?.id) return local;
      const item = detail as MovieItem;
      mergeMovies([item]);
      return item;
    } catch {
      return local;
    }
  }, [mergeMovies]);

  // ---- 播放资源解析（设备站点搜索 → 选来源 → 拿线路/选集） ----
  const setResource = (movieId: string, patch: Partial<ResourceState>) => {
    setMovieResources((prev) => ({
      ...prev,
      [movieId]: { ...(prev[movieId] || EMPTY_RESOURCE), ...patch },
    }));
  };

  // 设备桥高负载下会闪断并自动重连（退避最长 60s），等它回来
  const waitDeviceOnline = useCallback(async (timeoutMs = 90_000): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const d = await api.deviceStatus();
        if (d.online) return true;
      } catch { /* manage 不可达时继续等 */ }
      await new Promise((r) => setTimeout(r, 5000));
    }
    return false;
  }, []);

  const fetchMatchFlags = useCallback(async (movieId: string, match: ResourceMatch): Promise<ResourceFlag[] | undefined> => {
    setResource(movieId, { status: 'selecting', selected: match });
    const load = async () => {
      try {
        return await api.siteDetail(match.siteKey, match.vodId);
      } catch (e: any) {
        return { error: e?.message || '获取选集失败' } as any;
      }
    };
    let data = await load();
    // 设备桥闪断（错误含"设备未连接"或 device offline）：等重连后重试一次
    if (data?.error && /设备未连接|device offline/i.test(data.error)) {
      showToast('设备连接中断，正在等待重连…', 'warning');
      if (await waitDeviceOnline()) data = await load();
    }
    if (data?.error) {
      setResource(movieId, { status: 'error', error: data.error });
      return undefined;
    }
    const flags = (data.flags || []).map((f) => ({
      flag: f.flag,
      episodes: (f.episodes || []).map((ep, idx) => ({
        id: ep.url,
        number: idx + 1,
        title: ep.name || `第${String(idx + 1).padStart(2, '0')}集`,
        duration: data.remarks || '',
        previewUrl: '',
        videoUrl: '',
      })),
    })).filter((f) => f.episodes.length > 0);
    setResource(movieId, { status: 'ready', flags, activeFlagIndex: 0 });
    return flags;
  }, [showToast, waitDeviceOnline]);

  const resolveResources = useCallback(async (movieId: string) => {
    // 从历史/继续观看直达播放页时 movies 里还没有该片：loadMovieDetail 的 setMovies 要到
    // 下一次渲染才同步进 moviesRef，同一微任务链里查 ref 会落空，静默 return 导致资源搜索
    // 根本不发（播放页卡「正在搜索」假象）——这里兜底拉一次详情拿到 movie 再继续
    let movie = moviesRef.current.find((m) => m.id === movieId);
    if (!movie && !resolvingRef.current.has(movieId)) movie = await loadMovieDetail(movieId);
    if (!movie) {
      setResource(movieId, { status: 'error', error: '影片信息加载失败' });
      return;
    }
    if (resolvingRef.current.has(movieId)) return;
    // 已解析完成或正在解析的影片直接复用，避免每次进入播放页都重搜一轮
    const existing = movieResourcesRef.current[movieId];
    if (existing && ['searching', 'selecting', 'ready'].includes(existing.status)) return;
    resolvingRef.current.add(movieId);
    setResource(movieId, { status: 'searching', matches: [], flags: [], selected: undefined, error: undefined });
    // 资源型影片（从资源卡进入）优先精确锁定自身来源；观看历史里存了上次选择的站点/线路，优先恢复
    const raw = (movie as any).raw as { key?: string; id?: string } | undefined;
    const saved = historyRef.current.find((h) => h.movieId === movieId && h.siteKey);

    // SSE 流式聚合：站点结果到一个合并一个（选源弹窗渐进可见）。选定来源的时机 =
    // 预设/历史站点命中、或出现片名精确匹配（score=100）、或超过 8s 宽限取当前最优、或流结束——
    // 不再等全部 126 个站点聚齐（冷词原 JSON 实现要 ~100s）。选定后继续合并剩余站点供手动换源。
    const all: ResourceMatch[] = [];
    const seen = new Set<string>();
    const startedAt = Date.now();
    let decided = false;
    let streamEnded = false;
    let failed = false;
    let onDecide: (() => void) | null = null;
    const decision = new Promise<void>((resolve) => { onDecide = resolve; });

    const publish = () => {
      if (!all.length) return;
      setResource(movieId, { matches: [...all].sort((a, b) => b.score - a.score).slice(0, 60) });
    };
    const tryDecide = () => {
      if (decided) return;
      const presetHit = !!(raw?.key && raw?.id && all.find((m) => m.siteKey === raw.key && m.vodId === raw.id));
      const savedHit = !!(saved && all.find((m) => m.siteKey === saved.siteKey));
      const exact = !saved && !raw?.key ? all.some((m) => m.score >= 100) : false;
      // 有历史/预设时只认目标站点或超时兜底，避免「恢复上次来源」被其它站的精确匹配抢跑
      if (presetHit || savedHit || exact || ((streamEnded || Date.now() - startedAt >= 8000) && all.length)) {
        decided = true;
        onDecide?.();
      }
    };
    const timer = setTimeout(tryDecide, 8000);

    api.resourceSearchStream(movie.title, (ev) => {
      if (ev.type === 'site') {
        if (ev.matched?.length) {
          for (const m of ev.matched) {
            const uid = `${m.siteKey}:${m.vodId}`;
            if (seen.has(uid)) continue;
            seen.add(uid);
            all.push(m);
          }
          publish();
        }
        tryDecide();
      } else if (ev.type === 'done') {
        streamEnded = true;
        tryDecide();
        if (!decided) {
          decided = true;
          setResource(movieId, { status: 'noresult', matches: [] });
        }
        onDecide?.();
        // matches 至此已齐：若扫描已用早期快照跑完（只覆盖了部分站点），发起补充扫描。
        // searchEnded 落 state 供"扫描结束"触发路径稍后从 ref 读到；本轮事实由参数传入
        setResource(movieId, { searchEnded: true });
        maybeExtendScanRef.current?.(movieId, 'search');
      } else if (ev.type === 'error') {
        streamEnded = true;
        if (!decided && !all.length) {
          decided = true;
          failed = true;
          setResource(movieId, { status: ev.deviceOnline === false ? 'offline' : 'error', error: ev.error || '设备未连接' });
        }
        tryDecide();
        onDecide?.();
        setResource(movieId, { searchEnded: true });
        maybeExtendScanRef.current?.(movieId, 'search');
      }
    });

    await decision;
    clearTimeout(timer);
    if (failed || !all.length) {
      resolvingRef.current.delete(movieId);
      return;
    }

    const ranked = [...all].sort((a, b) => b.score - a.score);
    const preset = raw?.key && raw?.id ? ranked.find((m) => m.siteKey === raw.key && m.vodId === raw.id) : undefined;
    const savedMatch = saved ? ranked.find((m) => m.siteKey === saved.siteKey) : undefined;
    const fallback = preset || ranked[0];
    const best = preset || savedMatch || ranked[0];
    // 默认路径（无资源卡预设、无历史偏好）：不急起播，等扫描完成选最优线路
    setResource(movieId, { awaitScan: !preset && !savedMatch });
    if (saved && !savedMatch && !preset) {
      showToast('上次的观看来源已不可用，已为你更换来源', 'info');
    }
    try {
      let flags = await fetchMatchFlags(movieId, best);
      let restored = best === savedMatch && !!flags?.length;
      // 上次线路获取失败（站点失效/无线路，含 flags 为空数组）→ 自动换默认来源再试一次；
      // 空数组是 truthy，必须显式判 length，否则死在"没有可用选集"
      if ((!flags || !flags.length) && best !== fallback && fallback) {
        showToast('上次线路暂时不可用，已为你更换来源', 'info');
        flags = await fetchMatchFlags(movieId, fallback);
      }
      // 恢复上次的线路；线路名对不上时静默用第一条
      if (savedMatch && saved?.flag && flags?.length) {
        const idx = flags.findIndex((f) => f.flag === saved.flag);
        if (idx > 0) setResource(movieId, { activeFlagIndex: idx });
      }
      // 恢复成功视为用户偏好：本次扫描不再自动切源，并给出提示
      if (restored) {
        setResource(movieId, { restoredPick: true });
        showToast('已恢复上次观看的来源和线路', 'info');
      }
    } catch (e: any) {
      setResource(movieId, { status: 'error', error: e?.message || '资源搜索失败' });
    } finally {
      resolvingRef.current.delete(movieId);
    }
  }, [fetchMatchFlags, loadMovieDetail, showToast]);

  // 用户手动换源/换线路后，本影片不再执行自动切源
  const markScanUserPicked = useCallback((movieId: string) => {
    setMovieResources((prev) => {
      const res = prev[movieId];
      if (!res?.scan || res.scan.userPicked) return prev;
      return { ...prev, [movieId]: { ...res, scan: { ...res.scan, userPicked: true } } };
    });
  }, []);

  const patchResource = useCallback((movieId: string, patch: Partial<ResourceState>) => {
    setResource(movieId, patch);
  }, []);

  const selectMatch = useCallback(async (movieId: string, match: ResourceMatch, manual = true) => {
    if (manual) markScanUserPicked(movieId);
    return await fetchMatchFlags(movieId, match);
  }, [fetchMatchFlags, markScanUserPicked]);

  const selectFlag = useCallback((movieId: string, index: number, manual = true) => {
    if (manual) markScanUserPicked(movieId);
    setResource(movieId, { activeFlagIndex: index });
  }, [markScanUserPicked]);

  const currentEpisodes = useCallback((movieId: string) => {
    const res = movieResources[movieId];
    if (!res || res.status !== 'ready' || !res.flags.length) return null;
    return res.flags[res.activeFlagIndex] || res.flags[0];
  }, [movieResources]);

  // ---- 智能选源扫描（SSE 渐进消费，结果按 siteKey::flag 幂等合并） ----
  const scanEsRef = useRef<EventSource | null>(null);
  const lazyEsRef = useRef<EventSource | null>(null);  // 懒补测独立流，不打断主扫描
  // 搜索流结束后的补充扫描（冷搜渐进合并时首轮扫描只覆盖了部分站点）。
  // 触发时机有二：搜索流结束 / 首轮扫描结束——本轮刚发生的事实必须由参数传入：
  // setState 之后同步读 ref 拿不到刚写的状态（ moviesRef 时序坑同类），读 ref 必死
  const maybeExtendScanRef = useRef<((movieId: string, justEnded: 'search' | 'scan') => void) | null>(null);
  const extendingRef = useRef<Set<string>>(new Set());  // 已发起过补充扫描的影片，同步防重入
  useEffect(() => () => { scanEsRef.current?.close(); lazyEsRef.current?.close(); }, []);

  // 单条探测结果并入扫描状态（主扫描/懒补测共用）
  const mergeScanResult = useCallback((movieId: string, item: ScanCandidateResult) => {
    setMovieResources((prev) => {
      const cur = prev[movieId];
      if (!cur?.scan) return prev;
      const results = cur.scan.results.filter((x) => !(x.siteKey === item.siteKey && x.flag === item.flag));
      results.push(item);
      return { ...prev, [movieId]: { ...cur, scan: { ...cur.scan, results, finished: results.length } } };
    });
  }, []);

  const patchScan = useCallback((movieId: string, patch: Partial<ScanState>) => {
    setMovieResources((prev) => {
      const res = prev[movieId];
      if (!res?.scan) return prev;
      return { ...prev, [movieId]: { ...res, scan: { ...res.scan, ...patch } } };
    });
  }, []);

  // 消费一次扫描的 SSE 流。lazy=true 为选源弹窗的单站懒补测：只并入线路结果，
  // 不动扫描状态与推荐键——避免补测完成误触发"自动切最优线路"打断用户正在看的线路。
  // extend=true 为搜索结束后的补充扫描：正常并入状态与推荐键，total 以已测数为基数累加
  const openScanStream = useCallback((movieId: string, scanId: string, opts?: { lazy?: boolean; extend?: boolean; onDone?: () => void }) => {
    const lazy = !!opts?.lazy;
    const esRef = lazy ? lazyEsRef : scanEsRef;
    esRef.current?.close();
    const es = new EventSource(`/api/resource/scan/${scanId}`);
    esRef.current = es;
    const startedAt = Date.now();
    es.onmessage = (evt) => {
      let msg: any;
      try {
        msg = JSON.parse(evt.data);
      } catch {
        return;
      }
      if (msg.type === 'meta') {
        if (!lazy) {
          const base = opts?.extend ? (movieResourcesRef.current[movieId]?.scan?.finished || 0) : 0;
          patchScan(movieId, { total: base + (msg.total || 0) });
        }
      } else if (msg.type === 'result' && msg.result) {
        mergeScanResult(movieId, msg.result as ScanCandidateResult);
      } else if (msg.type === 'done') {
        if (!lazy) patchScan(movieId, {
          status: 'done',
          stoppedEarly: !!msg.stoppedEarly,
          recommendedKey: msg.recommended || undefined,
          fastestKey: msg.fastest || undefined,
          highestKey: msg.highest || undefined,
          extending: false,
        });
        es.close();
        if (esRef.current === es) esRef.current = null;
        opts?.onDone?.();
      }
    };
    es.onerror = () => {
      // 服务端结束流后若一直等不到 done（异常断开），超过 3 分钟放弃等待
      if (Date.now() - startedAt > 180_000) {
        es.close();
        if (esRef.current === es) esRef.current = null;
        if (!lazy) patchScan(movieId, { status: 'done', extending: false });
        opts?.onDone?.();
      }
    };
    return es;
  }, [patchScan, mergeScanResult]);

  const startScan = useCallback((movieId: string) => {
    const res = movieResourcesRef.current[movieId];
    if (!res || res.status !== 'ready' || !res.matches?.length) return;
    if (res.scan) return; // 已扫描过（running/done）不重扫
    const seen = new Set<string>();
    const candidates = res.matches
      .filter((m) => (seen.has(m.siteKey) ? false : (seen.add(m.siteKey), true)))
      .map((m) => ({ key: m.siteKey, id: m.vodId, name: m.siteName }));
    // 片库片长（如"118分钟"）解析成秒传给后端，做时长交叉比对（识别预告片/拼接广告）
    const movie = moviesRef.current.find((m) => m.id === movieId);
    const dm = movie?.duration?.match(/(\d+)\s*分钟/);
    const refDurationS = dm ? parseInt(dm[1], 10) * 60 : undefined;
    setMovieResources((prev) => {
      const cur = prev[movieId];
      if (!cur) return prev;
      return { ...prev, [movieId]: { ...cur, scan: { scanId: '', status: 'running', total: 0, finished: 0, results: [],
        // 从历史恢复的线路等价于用户手动选过：扫描完成后不自动切换
        userPicked: cur.restoredPick ? true : undefined } } };
    });
    api.resourceScan(candidates, refDurationS).then((r) => {
      if (r.error || !r.scanId) {
        showToast(`智能选源启动失败：${r.error || '未知错误'}`, 'warning');
        setMovieResources((prev) => {
          const cur = prev[movieId];
          if (!cur) return prev;
          return { ...prev, [movieId]: { ...cur, scan: undefined, awaitScan: false } }; // 清掉允许重试
        });
        return;
      }
      patchScan(movieId, { scanId: r.scanId });
      openScanStream(movieId, r.scanId, { onDone: () => maybeExtendScanRef.current?.(movieId, 'scan') });
    }).catch(() => {
      showToast('智能选源启动失败', 'warning');
      setMovieResources((prev) => {
        const cur = prev[movieId];
        if (!cur) return prev;
        return { ...prev, [movieId]: { ...cur, scan: undefined, awaitScan: false } };
      });
    });
  }, [patchScan, showToast, openScanStream]);

  // ---- 补充扫描：聚合搜索结束后，对首轮扫描未覆盖的站点再跑一轮完整流程 ----
  // 冷搜是 SSE 渐进合并，资源 ready 即触发 startScan 时往往只聚合了前一两个站点，
  // 首轮早停后其余站点的 4K/蓝光/超清线路永远不会被探。此处等搜索流结束（或首轮
  // 扫描结束、取两者较晚者）后，对 matches 里未探测的站点发起补充扫描：同样
  // "优先线路全量实测 → 普通线路达标即停"，结果并入同一扫描状态并重新参与自动选优。
  // justEnded 说明本轮刚结束的是哪件事——该事实刚 setState 完、同步读 ref 必为旧值，
  // 只能由触发方以参数告知；另一条件是更早写入的，ref 里已是新值，安全
  const maybeExtendScan = useCallback((movieId: string, justEnded: 'search' | 'scan') => {
    if (extendingRef.current.has(movieId)) return;
    const res = movieResourcesRef.current[movieId];
    const searchEnded = justEnded === 'search' || !!res?.searchEnded;
    const scanDone = justEnded === 'scan' || res?.scan?.status === 'done';
    if (!searchEnded || !scanDone || !res?.scan) return;
    const scanned = new Set(res.scan.results.map((r) => r.siteKey));
    const seen = new Set<string>();
    const cands = res.matches
      .filter((m) => !scanned.has(m.siteKey) && !seen.has(m.siteKey) && (seen.add(m.siteKey), true))
      .map((m) => ({ key: m.siteKey, id: m.vodId, name: m.siteName }));
    if (!cands.length) return;
    extendingRef.current.add(movieId);
    const movie = moviesRef.current.find((m) => m.id === movieId);
    const dm = movie?.duration?.match(/(\d+)\s*分钟/);
    const refDurationS = dm ? parseInt(dm[1], 10) * 60 : undefined;
    // 此前各轮已实测的线路结果随请求带给后端：优先额度跨扫描封顶 + 早停/推荐键全局评估
    const prior = res.scan.results;
    // 回到 running 态并重置已切标记：补充测完后按新推荐键重新自动选优；
    // 当前线路仍视为临时（provisional），全部测完即切全局最优
    patchScan(movieId, { status: 'running', switched: undefined, extending: true });
    patchResource(movieId, { provisional: true });
    showToast(`正在补充探测其余 ${cands.length} 个站点的线路…`, 'info');
    api.resourceScan(cands, refDurationS, false, prior).then((r) => {
      if (r.error || !r.scanId) {
        extendingRef.current.delete(movieId);
        patchScan(movieId, { status: 'done', extending: false });
        showToast(`补充探测启动失败：${r.error || '未知错误'}`, 'warning');
        return;
      }
      openScanStream(movieId, r.scanId, { extend: true });
    }).catch(() => {
      extendingRef.current.delete(movieId);
      patchScan(movieId, { status: 'done', extending: false });
      showToast('补充探测启动失败', 'warning');
    });
  }, [patchScan, patchResource, openScanStream, showToast]);
  maybeExtendScanRef.current = maybeExtendScan;

  // ---- 懒补测：选源弹窗对单个未探测站点发起补扫，结果渐进并入 ----
  const [probingSites, setProbingSites] = useState<Set<string>>(new Set());
  const probeSite = useCallback((movieId: string, siteKey: string) => {
    const res = movieResourcesRef.current[movieId];
    if (!res?.matches?.length) return;
    if (res.scan?.status === 'running') {
      showToast('智能测速进行中，稍后可再补测', 'info');
      return;
    }
    const match = res.matches.find((m) => m.siteKey === siteKey);
    if (!match) return;
    setProbingSites((prev) => new Set(prev).add(siteKey));
    const movie = moviesRef.current.find((m) => m.id === movieId);
    const dm = movie?.duration?.match(/(\d+)\s*分钟/);
    const refDurationS = dm ? parseInt(dm[1], 10) * 60 : undefined;
    const finish = () => setProbingSites((prev) => {
      const next = new Set(prev);
      next.delete(siteKey);
      return next;
    });
    // 手动补测不带 prior：独立探测该站，不受全局额度/达标短路影响
    api.resourceScan([{ key: match.siteKey, id: match.vodId, name: match.siteName }], refDurationS).then((r) => {
      if (r.error || !r.scanId) {
        finish();
        showToast(`补测启动失败：${r.error || '未知错误'}`, 'warning');
        return;
      }
      openScanStream(movieId, r.scanId, { lazy: true, onDone: finish });
    }).catch(() => {
      finish();
      showToast('补测启动失败', 'warning');
    });
  }, [showToast, openScanStream]);

  // ---- 强制重探：逐线全量实测、不做达标即停（选源弹窗"重新探测"按钮用）。
  // 与懒补测一样走 lazy 流渐进并入现有扫描，不动推荐键，不触发自动切源 ----
  const reprobeSites = useCallback((movieId: string, siteKeys: string[]) => {
    const res = movieResourcesRef.current[movieId];
    if (!res?.matches?.length || !siteKeys.length) return;
    if (res.scan?.status === 'running') {
      showToast('智能测速进行中，稍后可再重探', 'info');
      return;
    }
    if (probingSites.size > 0) {
      showToast('有探测正在进行中，请稍候', 'info');
      return;
    }
    const seen = new Set<string>();
    const cands = siteKeys
      .map((k) => res.matches!.find((m) => m.siteKey === k))
      .filter((m): m is ResourceMatch => !!m)
      .map((m) => ({ key: m.siteKey, id: m.vodId, name: m.siteName }))
      .filter((c) => (seen.has(c.key) ? false : (seen.add(c.key), true)));
    if (!cands.length) return;
    setProbingSites(new Set(cands.map((c) => c.key)));
    const movie = moviesRef.current.find((m) => m.id === movieId);
    const dm = movie?.duration?.match(/(\d+)\s*分钟/);
    const refDurationS = dm ? parseInt(dm[1], 10) * 60 : undefined;
    const finish = () => setProbingSites(new Set());
    api.resourceScan(cands, refDurationS, true).then((r) => {
      if (r.error || !r.scanId) {
        finish();
        showToast(`重新探测启动失败：${r.error || '未知错误'}`, 'warning');
        return;
      }
      openScanStream(movieId, r.scanId, { lazy: true, onDone: finish });
    }).catch(() => {
      finish();
      showToast('重新探测启动失败', 'warning');
    });
  }, [showToast, openScanStream, probingSites]);

  // ---- 路由 ----
  const navHistoryRef = useRef<PageView[]>([]);
  const currentPageRef = useRef(currentPage);
  useEffect(() => { currentPageRef.current = currentPage; }, [currentPage]);
  // 探索页浏览态缓存：跳详情/播放页再返回时不丢已加载的分页
  const browseCacheRef = useRef<{ key: string; items: MovieItem[]; cursor: string; done: boolean } | null>(null);

  const navigateTo = (page: PageView, params?: { movieId?: string; episodeId?: string; query?: string; genre?: string }) => {
    if (params?.movieId) {
      setSelectedMovieId(params.movieId);
      // 未指定集数时清空，由 WatchView 取资源解析后的第一集
      setSelectedEpisodeId(params.episodeId || null);
    }
    if (params?.query !== undefined) {
      setFilterState((prev) => ({ ...prev, query: params.query || '' }));
    }
    if (params?.genre) {
      setFilterState((prev) => ({ ...prev, genre: params.genre || '全部' }));
    }
    if (page !== currentPageRef.current) {
      navHistoryRef.current.push(currentPageRef.current);
      if (navHistoryRef.current.length > 30) navHistoryRef.current.shift();
    } else {
      // 同页重复导航视为"回到本页"，不产生新历史
      const top = navHistoryRef.current[navHistoryRef.current.length - 1];
      if (top === page) navHistoryRef.current.pop();
    }
    setCurrentPage(page);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  /** 返回上一个视图（探索/首页/详情等），无历史时回首页 */
  const goBack = () => {
    const prev = navHistoryRef.current.pop() || 'home';
    setCurrentPage(prev);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const saveBrowse = useCallback((state: { key: string; items: MovieItem[]; cursor: string; done: boolean }) => {
    browseCacheRef.current = state;
  }, []);

  const restoreBrowse = useCallback((key: string) =>
    browseCacheRef.current && browseCacheRef.current.key === key ? browseCacheRef.current : null, []);

  const updateFilter = (partial: Partial<FilterState>) => {
    setFilterState((prev) => ({ ...prev, ...partial }));
  };

  const resetFilter = () => {
    setFilterState(DEFAULT_FILTER);
  };

  // ---- 认证 ----
  const afterLogin = async (user: UserProfile) => {
    setCurrentUser(user);
    const [fav, hist] = await Promise.all([api.favorites(), api.history()]);
    setFavorites(fav.list.map((m) => m.id));
    setFavoriteMovies(fav.list);
    setWatchHistory(hist.list);
    mergeMovies(fav.list);
  };

  const login = async (account: string, pass: string) => {
    const res = await api.login(account.trim(), pass);
    if (res.error || !res.user) throw new Error(res.error || '登录失败');
    await afterLogin(res.user);
    showToast(`欢迎回来，${res.user.name}！`, 'success');
  };

  const register = async (username: string, password: string) => {
    const res = await api.register(username.trim(), password);
    if (res.error || !res.user) throw new Error(res.error || '注册失败');
    await afterLogin(res.user);
    showToast(`注册成功，欢迎加入 CINE！`, 'success');
  };

  const logout = async () => {
    try { await api.logout(); } catch { /* ignore */ }
    forceLogout();
    showToast('已退出当前账号', 'info');
  };

  // ---- 收藏 ----
  const toggleFavorite = (movieId: string) => {
    const movie = moviesRef.current.find((m) => m.id === movieId);
    if (!movie) return;
    const wasFav = favorites.includes(movieId);
    // 乐观更新
    setFavorites((prev) => (wasFav ? prev.filter((id) => id !== movieId) : [...prev, movieId]));
    setFavoriteMovies((prev) => (wasFav ? prev.filter((m) => m.id !== movieId) : [movie, ...prev]));
    showToast(wasFav ? `已从收藏夹移出《${movie.title}》` : `已将《${movie.title}》添加至收藏`, wasFav ? 'info' : 'success');
    api.toggleFavorite({ id: movie.id, title: movie.title, cover: movie.cover, rating: movie.rating, year: movie.year, type: movie.type })
      .then((res) => {
        if (typeof res.favorited === 'boolean' && res.favorited !== !wasFav) {
          // 与乐观结果不一致（比如多端同时操作），以服务端为准
          setFavorites((prev) => (res.favorited ? [...prev, movieId] : prev.filter((id) => id !== movieId)));
        }
      })
      .catch((e: any) => {
        if (e?.status === 401) { forceLogout('登录已过期，请重新登录'); return; }
        // 回滚
        setFavorites((prev) => (wasFav ? [...prev, movieId] : prev.filter((id) => id !== movieId)));
        setFavoriteMovies((prev) => (wasFav ? [movie, ...prev] : prev.filter((m) => m.id !== movieId)));
        showToast('收藏操作失败', 'warning');
      });
  };

  const isFavorite = (movieId: string) => favorites.includes(movieId);

  // ---- 观看进度 ----
  const recordWatchProgress = (
    movieId: string,
    episodeId: string,
    watchedSeconds: number,
    totalSeconds: number
  ) => {
    const movie = moviesRef.current.find((m) => m.id === movieId);
    if (!movie) return;
    const eps = currentEpisodes(movieId);
    const ep = eps?.episodes.find((e) => e.id === episodeId) || eps?.episodes[0];
    const progress = totalSeconds > 0 ? Math.min(100, Math.round((watchedSeconds / totalSeconds) * 100)) : 0;
    // 记住当前选择的站点/线路，重新进入时直接恢复
    const res = movieResourcesRef.current[movieId];
    const siteKey = res?.selected?.siteKey || '';
    const flag = res?.flags?.[res.activeFlagIndex]?.flag || '';
    const newItem: WatchHistoryItem = {
      id: `hist-${movieId}`,
      movieId,
      episodeId,
      episodeNumber: ep?.number || 1,
      episodeTitle: ep?.title || '正片',
      movieTitle: movie.title,
      cover: movie.cover,
      backdrop: movie.backdrop || movie.cover,
      watchedSeconds: Math.floor(watchedSeconds),
      totalSeconds: Math.floor(totalSeconds),
      progressPercent: progress,
      lastWatchedAt: Date.now(),
      siteKey,
      flag,
    };
    setWatchHistory((prev) => [newItem, ...prev.filter((item) => item.movieId !== movieId)]);
    api.saveHistory({
      movieId,
      movieTitle: movie.title,
      cover: movie.cover,
      backdrop: movie.backdrop || movie.cover,
      episodeId,
      episodeTitle: newItem.episodeTitle,
      episodeNumber: newItem.episodeNumber,
      watchedSeconds: newItem.watchedSeconds,
      totalSeconds: newItem.totalSeconds,
      siteKey,
      flag,
    }).catch((e: any) => {
      if (e?.status === 401) forceLogout('登录已过期，请重新登录');
    });
  };

  const deleteHistoryItem = (id: string) => {
    setWatchHistory((prev) => {
      const item = prev.find((h) => h.id === id);
      if (item) {
        api.deleteHistory(item.movieId).catch(() => {});
      }
      return prev.filter((item) => item.id !== id);
    });
    showToast('已删除观影记录', 'info');
  };

  const clearAllHistory = () => {
    api.deleteHistory('all').catch(() => {});
    setWatchHistory([]);
    showToast('已清空全部观影历史', 'info');
  };

  return (
    <AppContext.Provider
      value={{
        currentPage,
        appReady,
        catalogReady,
        selectedMovieId,
        selectedEpisodeId,
        filterState,
        watchHistory,
        favorites,
        favoriteMovies,
        toasts,
        searchModalOpen,
        currentUser,
        movies,
        sections,
        movieResources,
        deviceOnline,
        deviceName,
        navigateTo,
        goBack,
        saveBrowse,
        restoreBrowse,
        updateFilter,
        resetFilter,
        toggleFavorite,
        isFavorite,
        recordWatchProgress,
        deleteHistoryItem,
        clearAllHistory,
        showToast,
        getMovieById,
        setSearchModalOpen,
        login,
        logout,
        register,
        mergeMovies,
        loadMovieDetail,
        resolveResources,
        selectMatch,
        selectFlag,
        currentEpisodes,
        startScan,
        probeSite,
        reprobeSites,
        probingSites,
        patchScan,
        patchResource,
        refreshDeviceStatus,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
