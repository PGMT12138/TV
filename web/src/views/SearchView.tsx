import React, { useState, useMemo, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { GENRE_LIST, REGION_LIST, YEAR_LIST, HOT_SEARCH_TERMS } from '../data/mockMovies';
import { MovieCard } from '../components/MovieCard';
import { api, imgUrl } from '../api';
import { MovieItem, ResourceMatch } from '../types';
import { useLiveSearch, adoptResourceMatch } from '../hooks/useLiveSearch';
import {
  Search,
  SlidersHorizontal,
  X,
  RotateCcw,
  LayoutGrid,
  List,
  Sparkles,
  Film,
  Star,
  Flame,
  Clock,
  Play,
  Zap,
  Loader2
} from 'lucide-react';

const MEDIA_TYPES = [
  { id: 'all', label: '全部作品' },
  { id: 'movie', label: '电影' },
  { id: 'series', label: '剧集' },
  { id: 'variety', label: '综艺' },
  { id: 'anime', label: '动漫' },
  { id: 'doc', label: '纪录片' },
];

const SORT_OPTIONS = [
  { id: 'trending', label: '最热门' },
  { id: 'rating', label: '最高分' },
  { id: 'newest', label: '最新上线' },
];

export const SearchView: React.FC = () => {
  const { filterState, updateFilter, resetFilter, movies, mergeMovies, saveBrowse, restoreBrowse, navigateTo, showToast } = useApp();
  const [viewMode, setViewMode] = useState<'grid' | 'list'>('grid');
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  const [adoptingKey, setAdoptingKey] = useState('');

  const query = filterState.query.trim();

  // 手动双端搜索：仅点「搜索」按钮/回车/热词才查豆瓣片库与 app 端站点（缓存+实时）。输入过程完全静止——
  // 不发请求、默认影片网格原样展示，点搜索后才切到结果视图。豆瓣有结果只展示豆瓣，无结果才兜底展示 app 端。
  const live = useLiveSearch(filterState.query);

  // 带词进入（弹窗跳转/首页热词点击）视为一次明确的搜索意图，落地立即检索一次
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    if (query) live.search(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const clearSearch = () => {
    updateFilter({ query: '' });
  };

  const handleResetFilter = () => {
    resetFilter();
  };

  // Computed filtered results
  const filteredMovies = useMemo(() => {
    return movies.filter((movie) => {
      // Query search
      if (query) {
        const q = query.toLowerCase();
        const matchTitle = movie.title.toLowerCase().includes(q);
        const matchOriginal = movie.originalTitle.toLowerCase().includes(q);
        const matchDirector = movie.director.toLowerCase().includes(q);
        const matchGenre = movie.genres.some((g) => g.toLowerCase().includes(q));
        const matchCast = movie.cast.some((c) => c.name.toLowerCase().includes(q));
        if (!matchTitle && !matchOriginal && !matchDirector && !matchGenre && !matchCast) {
          return false;
        }
      }

      // Media Type（综艺=series 的题材细分，与 typeLabel 口径一致）
      if (filterState.type === 'variety') {
        const isVariety = movie.type === 'series' &&
          movie.genres.some((g) => ['真人秀', '脱口秀', '综艺'].some((k) => g.includes(k)));
        if (!isVariety) return false;
      } else if (filterState.type && filterState.type !== 'all' && movie.type !== filterState.type) {
        return false;
      }

      // Genre
      if (filterState.genre && filterState.genre !== '全部' && !movie.genres.includes(filterState.genre)) {
        return false;
      }

      // Region
      if (filterState.region && filterState.region !== '全部' && movie.region !== filterState.region) {
        return false;
      }

      // Year
      if (filterState.year && filterState.year !== '全部') {
        const y = movie.year || 0;
        if (filterState.year === '2026' && y !== 2026) return false;
        if (filterState.year === '2025' && y !== 2025) return false;
        if (filterState.year === '2024' && y !== 2024) return false;
        if (filterState.year === '2023' && y !== 2023) return false;
        if (filterState.year === '2020-2022' && (y < 2020 || y > 2022)) return false;
        if (filterState.year === '2010-2019' && (y < 2010 || y > 2019)) return false;
        if (filterState.year === '经典老片' && y >= 2010) return false;
      }

      return true;
    }).sort((a, b) => {
      if (filterState.sort === 'rating') return b.rating - a.rating;
      if (filterState.sort === 'newest') return (b.year || 0) - (a.year || 0);
      return (a.ranking || 99) - (b.ranking || 99);
    });
  }, [movies, filterState]);

  // ---- 浏览模式（无关键词）：豆瓣全库直连，筛选映射服务端、翻页加载 ----
  const browseKey = `${filterState.type}|${filterState.genre}|${filterState.region}|${filterState.year}|${filterState.sort}`;
  const [browse, setBrowse] = useState<{ items: MovieItem[]; cursor: string; done: boolean }>(
    () => restoreBrowse(browseKey) || { items: [], cursor: '', done: false }
  );
  const [browseLoading, setBrowseLoading] = useState(false);
  const restoredRef = useRef(false);

  // 浏览态写入全局缓存：跳详情/播放页再返回时保留已加载的分页
  useEffect(() => {
    if (browse.items.length) saveBrowse({ key: browseKey, ...browse });
  }, [browse, browseKey, saveBrowse]);

  const exploreParams = () => ({
    type: filterState.type || 'all',
    genre: filterState.genre || '',
    region: filterState.region || '',
    year: filterState.year || '',
    sort: filterState.sort || 'trending',
  });

  // 筛选/排序变化或清空关键词时拉第一页；有关键词时冻结浏览态走本地搜索
  useEffect(() => {
    if (query) return;
    if (!restoredRef.current) {
      restoredRef.current = true;
      if (browse.items.length > 0) return; // 恢复的浏览态直接沿用，不重拉
    }
    let cancelled = false;
    setBrowse({ items: [], cursor: '', done: false });
    setBrowseLoading(true);
    api.explore(exploreParams())
      .then((res) => {
        if (cancelled) return;
        setBrowse({ items: res.list, cursor: res.cursor, done: res.done });
        if (res.list.length) mergeMovies(res.list);
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setBrowseLoading(false);
      });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browseKey, query]);

  const loadMoreExplore = async () => {
    if (!browse.cursor || browse.done || browseLoading) return;
    setBrowseLoading(true);
    try {
      const res = await api.explore({ ...exploreParams(), cursor: browse.cursor });
      setBrowse((prev) => {
        const seen = new Set(prev.items.map((m) => m.id));
        const append = res.list.filter((m) => !seen.has(m.id));
        return { items: [...prev.items, ...append], cursor: res.cursor, done: res.done };
      });
      if (res.list.length) mergeMovies(res.list);
    } catch { /* 翻页失败静默，可重点 */ }
    finally { setBrowseLoading(false); }
  };

  // 当前输入词对应一轮已发起的检索（点过搜索/回车/热词/带词进入）
  const searched = !live.stale && live.phase !== 'idle';
  // 输入未搜索期间维持浏览态：默认影片网格原样展示，点搜索后才切到结果视图
  const browseMode = !query || !searched;
  const displayMovies = browseMode ? browse.items : filteredMovies;

  // 豆瓣无可见结果且 app 端有命中时才兜底展示 app 结果；app 端无论何时无结果都不做任何提示
  const showAppResults = !browseMode && live.phase === 'done' && displayMovies.length === 0 && live.appMatches.length > 0;
  const showSearching = !browseMode && displayMovies.length === 0
    && (live.phase === 'searching' || live.appSearching);

  // app 端结果点击：注册为资源影片后直达播放页（播放页按 raw 站点信息精确锁定来源播放）
  const handleAdopt = async (m: ResourceMatch) => {
    const uid = `${m.siteKey}:${m.vodId}`;
    if (adoptingKey) return;
    setAdoptingKey(uid);
    try {
      const movie = await adoptResourceMatch(m);
      if (!movie) {
        showToast('获取片源详情失败，请确认设备在线', 'warning');
        return;
      }
      mergeMovies([movie]);
      navigateTo('watch', { movieId: movie.id });
    } finally {
      setAdoptingKey('');
    }
  };

  const hasActiveFilters =
    !browseMode ||
    filterState.type !== 'all' ||
    filterState.genre !== '全部' ||
    filterState.region !== '全部' ||
    filterState.year !== '全部';

  return (
    <div id="search-view" className="space-y-8 pb-16 animate-fade-blur">
      {/* Header Title */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-widest font-sans-modern">
          <Search className="w-3.5 h-3.5" />
          EXPLORE & ADVANCED SEARCH
        </div>
        <h1 className="text-3xl sm:text-4xl lg:text-5xl font-instrument-serif font-normal text-white">
          片库探索与多维检索
        </h1>
      </div>

      {/* Main Search Input Bar */}
      <div className="relative">
        <div
          className="flex items-center gap-3 px-5 py-4 rounded-3xl bg-zinc-900/90 border border-zinc-800 focus-within:border-emerald-500/50 shadow-xl text-zinc-100 transition-all"
          style={{
            boxShadow: 'rgba(0, 0, 0, 0.5) 0px 20px 40px -15px',
          }}
        >
          <Search className="w-5 h-5 text-emerald-400 shrink-0" />
          <input
            type="text"
            value={filterState.query}
            onChange={(e) => updateFilter({ query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Enter') live.search(filterState.query);
            }}
            placeholder="输入影片名、导演、演员、流派（例如：沙丘、维伦纽瓦、科幻、宫崎骏）..."
            className="w-full bg-transparent text-base sm:text-lg text-white placeholder-zinc-500 focus:outline-none font-sans-modern"
          />
          {filterState.query && (
            <button
              onClick={clearSearch}
              className="p-1 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => live.search(filterState.query)}
            disabled={!filterState.query.trim()}
            className="shrink-0 flex items-center gap-1.5 px-4 py-1.5 rounded-full bg-emerald-500 text-black text-sm font-bold hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {live.phase === 'searching' ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Search className="w-4 h-4" />
            )}
            搜索
          </button>
        </div>
      </div>

      {/* Popular Hot Tags */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-400 flex items-center gap-1 font-medium mr-1">
          <Sparkles className="w-3 h-3 text-emerald-400" /> 大家都在搜:
        </span>
        {HOT_SEARCH_TERMS.map((term) => (
            <button
              key={term}
              onClick={() => {
                updateFilter({ query: term });
                live.search(term);
              }}
              className={`px-3 py-1 text-xs rounded-full border transition-all ${
                filterState.query === term
                  ? 'bg-emerald-500 text-black border-emerald-400 font-bold'
                  : 'bg-zinc-900/80 text-zinc-300 border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700'
              }`}
            >
            {term}
          </button>
        ))}
      </div>

      {/* Filter Matrix Card */}
      <div
        className="rounded-3xl bg-zinc-900/70 border border-zinc-800 p-5 sm:p-7 space-y-4 shadow-xl"
        style={{
          boxShadow: 'rgba(0, 0, 0, 0.4) 0px 20px 40px -15px',
        }}
      >
        {/* Row 1: Type */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <span className="text-xs font-semibold text-zinc-400 w-16 shrink-0">分类类型</span>
          <div className="flex flex-wrap gap-1.5">
            {MEDIA_TYPES.map((item) => (
              <button
                key={item.id}
                onClick={() => updateFilter({ type: item.id })}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${
                  (filterState.type || 'all') === item.id
                    ? 'bg-emerald-500 text-black font-bold shadow-sm'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>

        {/* Row 2: Genre */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <span className="text-xs font-semibold text-zinc-400 w-16 shrink-0">题材流派</span>
          <div className="flex flex-wrap gap-1.5">
            {GENRE_LIST.map((genre) => (
              <button
                key={genre}
                onClick={() => updateFilter({ genre })}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${
                  (filterState.genre || '全部') === genre
                    ? 'bg-emerald-500 text-black font-bold shadow-sm'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {genre}
              </button>
            ))}
          </div>
        </div>

        {/* Row 3: Region */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <span className="text-xs font-semibold text-zinc-400 w-16 shrink-0">制作地区</span>
          <div className="flex flex-wrap gap-1.5">
            {REGION_LIST.map((region) => (
              <button
                key={region}
                onClick={() => updateFilter({ region })}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${
                  (filterState.region || '全部') === region
                    ? 'bg-emerald-500 text-black font-bold shadow-sm'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {region}
              </button>
            ))}
          </div>
        </div>

        {/* Row 4: Year */}
        <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
          <span className="text-xs font-semibold text-zinc-400 w-16 shrink-0">年代发行</span>
          <div className="flex flex-wrap gap-1.5">
            {YEAR_LIST.map((year) => (
              <button
                key={year}
                onClick={() => updateFilter({ year })}
                className={`px-3.5 py-1.5 rounded-full text-xs font-medium transition-all ${
                  (filterState.year || '全部') === year
                    ? 'bg-emerald-500 text-black font-bold shadow-sm'
                    : 'bg-zinc-800/60 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800'
                }`}
              >
                {year}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Result Status Bar & Sort / View Switchers */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-zinc-800 pb-4">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-zinc-200 font-sans-modern">
            {browseMode ? (
              <>探索片库: <span className="text-emerald-400 font-bold">{displayMovies.length}</span> 部
                <span className="text-xs text-zinc-500 font-normal ml-1.5">豆瓣全库 · 按筛选实时加载</span></>
            ) : showAppResults ? (
              <>片源直搜: <span className="text-emerald-400 font-bold">{live.appMatches.length}</span> 条结果
                <span className="text-xs text-zinc-500 font-normal ml-1.5">豆瓣片库未收录 · 来自 app 端站点</span></>
            ) : (
              <>检索结果: <span className="text-emerald-400 font-bold">{displayMovies.length}</span> 部影视作品</>
            )}
          </span>
          {hasActiveFilters && (
            <button
              onClick={handleResetFilter}
              className="flex items-center gap-1 text-xs text-zinc-400 hover:text-emerald-400 transition-colors px-2 py-1 rounded-md bg-zinc-800/50"
            >
              <RotateCcw className="w-3 h-3" /> 重置筛选
            </button>
          )}
        </div>

        <div className="flex items-center gap-3 self-end sm:self-auto">
          {/* Sort tabs */}
          <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
            {SORT_OPTIONS.map((opt) => (
              <button
                key={opt.id}
                onClick={() => updateFilter({ sort: opt.id as any })}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
                  (filterState.sort || 'trending') === opt.id
                    ? 'bg-zinc-800 text-emerald-400 shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          {/* View mode toggle */}
          <div className="flex items-center gap-1 bg-zinc-900 p-1 rounded-xl border border-zinc-800">
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded-lg transition-colors ${
                viewMode === 'grid' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="网格海报视图"
            >
              <LayoutGrid className="w-4 h-4" />
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`p-1.5 rounded-lg transition-colors ${
                viewMode === 'list' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
              }`}
              title="图文横版列表"
            >
              <List className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Movie Results Display */}
      {browseMode && browseLoading && browse.items.length === 0 ? (
        <div className="py-24 flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-500">正在从豆瓣全库加载影片...</p>
        </div>
      ) : displayMovies.length > 0 ? (
        <>
          {viewMode === 'grid' ? (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
              {displayMovies.map((movie) => (
                <MovieCard key={movie.id} movie={movie} variant="poster" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {displayMovies.map((movie) => (
                <MovieCard key={movie.id} movie={movie} variant="horizontal" />
              ))}
            </div>
          )}
          {browseMode && !browse.done && (
            <div className="flex justify-center pt-6">
              <button
                onClick={loadMoreExplore}
                disabled={browseLoading}
                className="flex items-center gap-2 px-6 py-2.5 rounded-full bg-zinc-800/80 hover:bg-zinc-800 text-zinc-200 border border-zinc-700 text-sm font-medium disabled:opacity-50 transition-colors"
              >
                {browseLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                {browseLoading ? '加载中...' : '加载更多'}
              </button>
            </div>
          )}
        </>
      ) : showAppResults ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
            <span className="flex items-center gap-2 text-sm font-semibold text-zinc-200 font-sans-modern">
              <Zap className="w-4 h-4 text-emerald-400" />
              片源站点直搜
              <span className="text-emerald-400 font-bold">{live.appMatches.length}</span> 条结果
              {live.appSearching && <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />}
            </span>
            <span className="text-xs text-zinc-500">点击卡片直接进入播放</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {live.appMatches.map((m) => {
              const uid = `${m.siteKey}:${m.vodId}`;
              return (
                <div
                  key={uid}
                  onClick={() => handleAdopt(m)}
                  className="group flex items-center justify-between gap-3 p-3.5 rounded-2xl bg-zinc-900/60 border border-zinc-800 hover:border-emerald-500/30 hover:bg-zinc-900 cursor-pointer transition-all"
                >
                  <div className="flex items-center gap-4 min-w-0">
                    <img
                      src={imgUrl(m.pic)}
                      alt={m.title}
                      className="w-14 h-20 object-cover rounded-xl shrink-0 group-hover:scale-105 transition-transform bg-zinc-800"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
                          {m.title}
                        </h4>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 shrink-0 truncate max-w-32">
                          {m.siteName}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 mt-1.5 line-clamp-1">
                        {[m.typeName, m.remarks].filter(Boolean).join(' · ')}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center shrink-0 pl-1">
                    {adoptingKey === uid ? (
                      <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
                    ) : (
                      <span className="p-2.5 rounded-xl bg-zinc-800 group-hover:bg-emerald-500 group-hover:text-black text-zinc-300 transition-colors">
                        <Play className="w-4 h-4 fill-current" />
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : showSearching ? (
        <div className="py-20 flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-500">正在检索「{query}」...</p>
        </div>
      ) : (
        <div className="py-20 text-center space-y-4 rounded-3xl bg-zinc-900/30 border border-zinc-800/80 p-8">
          <Film className="w-12 h-12 text-zinc-600 mx-auto" />
          <h3 className="text-xl font-instrument-serif font-normal text-zinc-200">
            未检索到符合条件的影片
          </h3>
          <p className="text-sm text-zinc-500 max-w-md mx-auto">
            您可以尝试更换搜索关键词，或者点击下方按钮重置全部筛选条件重新浏览。
          </p>
          <button
            onClick={handleResetFilter}
            className="px-5 py-2.5 rounded-full bg-emerald-500 text-black font-semibold text-sm hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20"
          >
            重置所有筛选参数
          </button>
        </div>
      )}
    </div>
  );
};
