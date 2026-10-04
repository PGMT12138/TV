import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { imgUrl } from '../api';
import { HOT_SEARCH_TERMS, typeLabel } from '../data/mockMovies';
import { useLiveSearch, adoptResourceMatch } from '../hooks/useLiveSearch';
import type { ResourceMatch } from '../types';
import { Search, X, Film, Play, Star, Sparkles, Clock, ArrowRight, Loader2, Zap } from 'lucide-react';

export const QuickSearchModal: React.FC = () => {
  const { searchModalOpen, setSearchModalOpen, navigateTo, movies, mergeMovies, showToast } = useApp();
  const [query, setQuery] = useState('');
  const [adoptingKey, setAdoptingKey] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  // 手动双端搜索：仅点「搜索」按钮才查豆瓣片库与 app 端站点（缓存+实时）。输入过程完全静止——
  // 不发请求、默认内容（热搜推荐/热映精选）原样保留，点搜索后才切换为结果视图；
  // 豆瓣有结果只展示豆瓣；豆瓣无结果且 app 端有命中才兜底展示 app 结果；app 端无论何时无结果都不做任何提示。
  const live = useLiveSearch(query);

  useEffect(() => {
    if (searchModalOpen) {
      setTimeout(() => inputRef.current?.focus(), 50);
    } else {
      setQuery('');
    }
  }, [searchModalOpen]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setSearchModalOpen(true);
      }
      if (e.key === 'Escape' && searchModalOpen) {
        setSearchModalOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [searchModalOpen, setSearchModalOpen]);

  if (!searchModalOpen) return null;

  const filteredMovies = query.trim()
    ? movies.filter((m) =>
        m.title.toLowerCase().includes(query.toLowerCase()) ||
        m.originalTitle.toLowerCase().includes(query.toLowerCase()) ||
        m.director.toLowerCase().includes(query.toLowerCase()) ||
        m.genres.some((g) => g.toLowerCase().includes(query.toLowerCase())) ||
        m.cast.some((c) => c.name.toLowerCase().includes(query.toLowerCase()))
      ).slice(0, 8)
    : [];

  // 当前输入词对应一轮已点「搜索」发起的检索；输入过程不发请求、不展示任何检索中间态与过期结果
  const searched = !live.stale && live.phase !== 'idle';
  // 豆瓣无可见结果且 app 端有命中时才兜底展示 app 结果；app 端无论何时无结果都不做任何提示
  const showAppResults = searched && live.phase === 'done' && filteredMovies.length === 0 && live.appMatches.length > 0;
  const showSearching = searched && filteredMovies.length === 0 && (live.phase === 'searching' || live.appSearching);

  const handleSelectMovie = (movieId: string) => {
    setSearchModalOpen(false);
    navigateTo('detail', { movieId });
  };

  // app 端结果点击：注册为资源影片后直达播放页（播放页按 raw 站点信息精确锁定来源）
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
      setSearchModalOpen(false);
      navigateTo('watch', { movieId: movie.id });
    } finally {
      setAdoptingKey('');
    }
  };

  const handleGoToFullSearch = (term?: string) => {
    const q = term !== undefined ? term : query;
    setSearchModalOpen(false);
    navigateTo('search', { query: q });
  };

  return (
    <div
      id="quick-search-backdrop"
      className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-start justify-center pt-16 md:pt-24 px-4 p-4 animate-fade-blur"
      onClick={() => setSearchModalOpen(false)}
    >
      <div
        id="quick-search-dialog"
        className="w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl overflow-hidden text-zinc-100"
        style={{
          boxShadow: 'rgba(0, 0, 0, 0.7) 0px 30px 60px -12px, rgba(16, 185, 129, 0.15) 0px 0px 0px 1px',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input header */}
        <div className="flex items-center gap-3 border-b border-zinc-800 pb-4">
          <Search className="w-5 h-5 text-emerald-400 shrink-0" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleGoToFullSearch();
            }}
            placeholder="搜索影片、导演、主演、流派（如：沙丘、诺兰、赛博朋克）..."
            className="w-full bg-transparent text-lg text-zinc-100 placeholder-zinc-500 focus:outline-none font-sans-modern"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="p-1 text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          )}
          <button
            onClick={() => live.search(query)}
            disabled={!query.trim()}
            className="shrink-0 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-emerald-500 text-black text-xs font-bold hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {live.phase === 'searching' ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Search className="w-3.5 h-3.5" />
            )}
            搜索
          </button>
          <button
            onClick={() => setSearchModalOpen(false)}
            className="px-2.5 py-1 text-xs text-zinc-400 bg-zinc-800/80 rounded-lg hover:text-zinc-200 border border-zinc-700/50"
          >
            ESC
          </button>
        </div>

        {/* Dynamic results or Hot tags */}
        <div className="mt-4 max-h-[60vh] overflow-y-auto space-y-4">
          {/* 未点搜索（含输入过程中）：默认内容原样展示，输入不触发任何变化 */}
          {!searched ? (
            <div>
              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
                热门搜索推荐
              </div>
              <div className="flex flex-wrap gap-2 mb-6">
                {HOT_SEARCH_TERMS.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleGoToFullSearch(term)}
                    className="px-3.5 py-1.5 text-xs rounded-full bg-zinc-800/90 hover:bg-emerald-500/20 hover:text-emerald-300 hover:border-emerald-500/40 border border-zinc-700/60 transition-all text-zinc-300 font-sans-modern"
                  >
                    {term}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2 text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
                <Film className="w-3.5 h-3.5 text-indigo-400" />
                热映精选
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {movies.filter((m) => m.rating > 0).sort((a, b) => b.rating - a.rating).slice(0, 4).map((movie) => (
                  <div
                    key={movie.id}
                    onClick={() => handleSelectMovie(movie.id)}
                    className="flex items-center gap-3 p-2.5 rounded-2xl bg-zinc-800/40 hover:bg-zinc-800 border border-zinc-800 hover:border-zinc-700 cursor-pointer transition-all group"
                  >
                    <img
                      src={movie.cover}
                      alt={movie.title}
                      className="w-12 h-16 object-cover rounded-xl shrink-0 group-hover:scale-105 transition-transform"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-zinc-100 truncate group-hover:text-emerald-300 transition-colors">
                        {movie.title}
                      </p>
                      <p className="text-xs text-zinc-400 font-instrument-serif text-sm truncate">{movie.originalTitle}</p>
                      <div className="flex items-center gap-2 mt-1 text-[11px] text-zinc-400">
                        <span className="text-amber-400 font-bold flex items-center gap-0.5">
                          <Star className="w-3 h-3 fill-amber-400 inline" /> {movie.rating}
                        </span>
                        <span>•</span>
                        <span>{movie.year}</span>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : searched && filteredMovies.length > 0 ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400 px-1 mb-2">
                <span className="flex items-center gap-1.5">
                  找到 {filteredMovies.length} 部相关作品
                  {live.phase === 'searching' && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <Loader2 className="w-3 h-3 animate-spin" /> 在线检索中...
                    </span>
                  )}
                </span>
                <button
                  onClick={() => handleGoToFullSearch()}
                  className="text-emerald-400 hover:underline flex items-center gap-1 font-medium"
                >
                  前往高级搜索筛选 <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {filteredMovies.map((movie) => (
                <div
                  key={movie.id}
                  onClick={() => handleSelectMovie(movie.id)}
                  className="flex items-center justify-between p-3 rounded-2xl bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-800 hover:border-emerald-500/30 cursor-pointer transition-all group"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <img
                      src={movie.cover}
                      alt={movie.title}
                      className="w-12 h-16 object-cover rounded-xl shrink-0 group-hover:scale-105 transition-transform"
                    />
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
                          {movie.title}
                        </h4>
                        <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700/60 text-zinc-300 shrink-0">
                          {typeLabel(movie)}
                        </span>
                      </div>
                      <p className="text-xs text-zinc-400 font-instrument-serif text-sm mt-0.5 truncate">{movie.originalTitle}</p>
                      <p className="text-xs text-zinc-400 mt-1 line-clamp-1">
                        {movie.genres.join(' / ')} • 导演：{movie.director}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0 pl-3">
                    <span className="text-sm font-bold text-amber-400 flex items-center gap-1">
                      <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                      {movie.rating}
                    </span>
                    <span className="p-2 rounded-xl bg-zinc-700/50 group-hover:bg-emerald-500 group-hover:text-black text-zinc-300 transition-colors">
                      <Play className="w-3.5 h-3.5 fill-current" />
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : showAppResults ? (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-zinc-400 px-1 mb-2">
                <span className="flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5 text-emerald-400" />
                  片源站点直搜到 {live.appMatches.length} 条结果，点击直接播放
                  {live.appSearching && (
                    <span className="flex items-center gap-1 text-emerald-400">
                      <Loader2 className="w-3 h-3 animate-spin" />
                    </span>
                  )}
                </span>
                <button
                  onClick={() => handleGoToFullSearch()}
                  className="text-emerald-400 hover:underline flex items-center gap-1 font-medium"
                >
                  前往高级搜索筛选 <ArrowRight className="w-3 h-3" />
                </button>
              </div>
              {live.appMatches.slice(0, 10).map((m) => {
                const uid = `${m.siteKey}:${m.vodId}`;
                return (
                  <div
                    key={uid}
                    onClick={() => handleAdopt(m)}
                    className="flex items-center justify-between p-3 rounded-2xl bg-zinc-800/50 hover:bg-zinc-800 border border-zinc-800 hover:border-emerald-500/30 cursor-pointer transition-all group"
                  >
                    <div className="flex items-center gap-3.5 min-w-0">
                      <img
                        src={imgUrl(m.pic)}
                        alt={m.title}
                        className="w-12 h-16 object-cover rounded-xl shrink-0 group-hover:scale-105 transition-transform bg-zinc-800"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <h4 className="text-sm font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
                            {m.title}
                          </h4>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 shrink-0 truncate max-w-28">
                            {m.siteName}
                          </span>
                        </div>
                        <p className="text-xs text-zinc-400 mt-1 line-clamp-1">
                          {[m.typeName, m.remarks].filter(Boolean).join(' · ')}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center shrink-0 pl-3">
                      {adoptingKey === uid ? (
                        <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
                      ) : (
                        <span className="p-2 rounded-xl bg-zinc-700/50 group-hover:bg-emerald-500 group-hover:text-black text-zinc-300 transition-colors">
                          <Play className="w-3.5 h-3.5 fill-current" />
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : showSearching ? (
            <div className="py-12 flex flex-col items-center gap-3">
              <Loader2 className="w-7 h-7 text-emerald-400 animate-spin" />
              <p className="text-sm text-zinc-500">正在检索「{query}」...</p>
            </div>
          ) : searched ? (
            <div className="py-12 text-center space-y-3">
              <Film className="w-10 h-10 text-zinc-600 mx-auto" />
              <p className="text-zinc-300 font-medium">未找到与 “{query}” 匹配的影片</p>
              <p className="text-xs text-zinc-500">可以尝试搜索电影流派、导演姓名或探索其他热门作品</p>
              <button
                onClick={() => {
                  setQuery('');
                  handleGoToFullSearch('');
                }}
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-zinc-800 text-zinc-200 hover:bg-zinc-700 transition-colors"
              >
                浏览全部片库
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
};
