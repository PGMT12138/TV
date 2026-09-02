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
    const movie = moviesRef.current.find((m) => m.id === movieId);
    if (!movie || resolvingRef.current.has(movieId)) return;
    // 已解析完成或正在解析的影片直接复用，避免每次进入播放页都重搜一轮
    const existing = movieResourcesRef.current[movieId];
    if (existing && ['searching', 'selecting', 'ready'].includes(existing.status)) return;
    resolvingRef.current.add(movieId);
    setResource(movieId, { status: 'searching', matches: [], flags: [], selected: undefined, error: undefined });
    try {
      const res = await api.resourceSearch(movie.title);
      if (!res.deviceOnline) {
        setResource(movieId, { status: 'offline', error: res.error || '设备未连接' });
        return;
      }
      // 资源型影片（从资源卡进入）优先精确锁定自身来源
      const raw = (movie as any).raw as { key?: string; id?: string } | undefined;
      const preset = raw?.key && raw?.id
        ? res.results.find((m) => m.siteKey === raw.key && m.vodId === raw.id)
        : undefined;
      // 观看历史里存了上次选择的站点/线路，优先恢复
      const saved = historyRef.current.find((h) => h.movieId === movieId && h.siteKey);
      const savedMatch = saved ? res.results.find((m) => m.siteKey === saved.siteKey) : undefined;
      const fallback = preset || res.results[0];
      const best = preset || savedMatch || res.results[0];
      if (!best) {
        setResource(movieId, { status: 'noresult', matches: res.results });
        return;
      }
      // 默认路径（无资源卡预设、无历史偏好）：不急起播，等扫描完成选最优线路
      setResource(movieId, { matches: res.results, awaitScan: !preset && !savedMatch });
      if (saved && !savedMatch && !preset) {
        showToast('上次的观看来源已不可用，已为你更换来源', 'info');
      }
      let flags = await fetchMatchFlags(movieId, best);
      let restored = best === savedMatch && !!flags;
      // 上次线路获取失败（站点失效/无线路）→ 自动换默认来源再试一次
      if (!flags && best !== fallback && fallback) {
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
  }, [fetchMatchFlags]);

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
  useEffect(() => () => scanEsRef.current?.close(), []);

  const patchScan = useCallback((movieId: string, patch: Partial<ScanState>) => {
    setMovieResources((prev) => {
      const res = prev[movieId];
      if (!res?.scan) return prev;
      return { ...prev, [movieId]: { ...res, scan: { ...res.scan, ...patch } } };
    });
  }, []);

  const startScan = useCallback((movieId: string) => {
    const res = movieResourcesRef.current[movieId];
    if (!res || res.status !== 'ready' || !res.matches?.length) return;
    if (res.scan) return; // 已扫描过（running/done）不重扫，后端另有 6h 缓存兜底
    const seen = new Set<string>();
    const candidates = res.matches
      .filter((m) => (seen.has(m.siteKey) ? false : (seen.add(m.siteKey), true)))
      .map((m) => ({ key: m.siteKey, id: m.vodId, name: m.siteName }));
    // 片库片长（如"118分钟"）解析成秒传给后端，做时长交叉比对（识别预告片/拼接广告）
    const movie = moviesRef.current.find((m) => m.id === movieId);
    const dm = movie?.duration?.match(/(\d+)\s*分钟/);
    const refDurationS = dm ? parseInt(dm[1], 10) * 60 : undefined;
    const startedAt = Date.now();
    api.resourceScan(candidates, refDurationS).then((r) => {
      if (r.error || !r.scanId) {
        showToast(`智能选源启动失败：${r.error || '未知错误'}`, 'warning');
        setResource(movieId, { awaitScan: false }); // 扫描起不来就放行起播，别卡住
        return;
      }
      setMovieResources((prev) => {
        const cur = prev[movieId];
        if (!cur) return prev;
        return { ...prev, [movieId]: { ...cur, scan: { scanId: r.scanId, status: 'running', total: 0, finished: 0, results: [],
          // 从历史恢复的线路等价于用户手动选过：扫描完成后不自动切换
          userPicked: cur.restoredPick ? true : undefined } } };
      });
      scanEsRef.current?.close();
      const es = new EventSource(`/api/resource/scan/${r.scanId}`);
      scanEsRef.current = es;
      es.onmessage = (evt) => {
        let msg: any;
        try {
          msg = JSON.parse(evt.data);
        } catch {
          return;
        }
        if (msg.type === 'meta') {
          patchScan(movieId, { total: msg.total || 0 });
        } else if (msg.type === 'result' && msg.result) {
          const item = msg.result as ScanCandidateResult;
          setMovieResources((prev) => {
            const cur = prev[movieId];
            if (!cur?.scan) return prev;
            const results = cur.scan.results.filter((x) => !(x.siteKey === item.siteKey && x.flag === item.flag));
            results.push(item);
            return { ...prev, [movieId]: { ...cur, scan: { ...cur.scan, results, finished: results.length } } };
          });
        } else if (msg.type === 'done') {
          patchScan(movieId, {
            status: 'done',
            recommendedKey: msg.recommended || undefined,
            fastestKey: msg.fastest || undefined,
            highestKey: msg.highest || undefined,
          });
          es.close();
          if (scanEsRef.current === es) scanEsRef.current = null;
        }
      };
      es.onerror = () => {
        // 服务端结束流后若一直等不到 done（异常断开），超过 3 分钟放弃等待
        if (Date.now() - startedAt > 180_000) {
          es.close();
          if (scanEsRef.current === es) scanEsRef.current = null;
          patchScan(movieId, { status: 'done' });
        }
      };
    }).catch(() => {
      setResource(movieId, { awaitScan: false });
    });
  }, [patchScan, showToast]);

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
