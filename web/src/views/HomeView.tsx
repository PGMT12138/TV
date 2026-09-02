import React, { useState } from 'react';
import { useApp } from '../context/AppContext';
import { GENRE_LIST } from '../data/mockMovies';
import { MovieItem } from '../types';
import { HeroBanner } from '../components/HeroBanner';
import { MovieCard } from '../components/MovieCard';
import {
  Sparkles,
  TrendingUp,
  Compass,
  Play,
  History,
  Clock,
  ArrowRight,
  Flame,
  Award,
  Film
} from 'lucide-react';

export const HomeView: React.FC = () => {
  const { navigateTo, watchHistory, movies, sections } = useApp();
  const [selectedGenreTab, setSelectedGenreTab] = useState('全部');
  const [activeSectionKey, setActiveSectionKey] = useState('hot_tv');

  // 策展专栏：豆瓣榜单板块 Tab，每板块展示前 6 部
  const movieById = React.useMemo(() => new Map(movies.map((m) => [m.id, m])), [movies]);
  const activeSection = sections.find((s) => s.key === activeSectionKey) || sections[0];
  const editorialMovies = (activeSection?.ids || [])
    .map((id) => movieById.get(id))
    .filter((m): m is MovieItem => !!m)
    .slice(0, 6);

  // Filtered movies by active quick tab
  const filteredByTab = selectedGenreTab === '全部'
    ? movies.slice(0, 20)
    : movies.filter((m) => m.genres.includes(selectedGenreTab));

  const sciFiMovies = movies.filter((m) => m.genres.includes('科幻')).slice(0, 10);
  const animeMovies = movies.filter((m) => m.type === 'anime');
  const docMovies = movies.filter((m) => m.type === 'doc');
  const topRatedMovies = [...movies].sort((a, b) => b.rating - a.rating);

  return (
    <div id="home-view" className="space-y-12 pb-16 animate-fade-blur">
      {/* 1. Hero Spotlight Carousel Banner */}
      <HeroBanner />

      {/* 2. Continue Watching (最近在看) - Only shown when history has items */}
      {watchHistory.length > 0 && (
        <section id="continue-watching-section" className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2.5">
              <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
                <History className="w-4 h-4" />
              </div>
              <h2 className="text-xl sm:text-2xl font-bold tracking-tight text-white font-sans-modern">
                继续观看
              </h2>
              <span className="text-xs text-zinc-400 font-medium">上次停留在第 {watchHistory[0].episodeNumber} 集</span>
            </div>
            <button
              onClick={() => navigateTo('history')}
              className="text-xs font-semibold text-emerald-400 hover:text-emerald-300 flex items-center gap-1 transition-colors"
            >
              查看全部历史 <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {watchHistory.slice(0, 3).map((item) => (
              <div
                key={item.id}
                onClick={() => navigateTo('watch', { movieId: item.movieId, episodeId: item.episodeId })}
                className="group flex gap-3.5 p-3 rounded-2xl bg-zinc-900/80 hover:bg-zinc-800/90 border border-zinc-800 hover:border-zinc-700 cursor-pointer transition-all duration-300 hover:shadow-xl"
              >
                <div className="relative w-28 sm:w-32 aspect-video rounded-xl overflow-hidden shrink-0 bg-zinc-950">
                  <img
                    src={item.backdrop || item.cover}
                    alt={item.movieTitle}
                    className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                  />
                  <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <div className="w-8 h-8 rounded-full bg-emerald-500 text-black flex items-center justify-center shadow-lg">
                      <Play className="w-4 h-4 fill-black ml-0.5" />
                    </div>
                  </div>
                  {/* Progress bar at bottom of thumbnail */}
                  <div className="absolute bottom-0 left-0 right-0 h-1 bg-zinc-800">
                    <div
                      className="h-full bg-emerald-400"
                      style={{ width: `${item.progressPercent}%` }}
                    />
                  </div>
                </div>

                <div className="min-w-0 flex-1 flex flex-col justify-between py-0.5">
                  <div>
                    <h4 className="font-bold text-sm text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
                      {item.movieTitle}
                    </h4>
                    <p className="text-xs text-zinc-400 truncate mt-0.5 font-sans-modern">
                      {item.episodeTitle}
                    </p>
                  </div>

                  <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-2">
                    <span className="text-emerald-400 font-medium">已看 {item.progressPercent}%</span>
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-zinc-400" />
                      {Math.floor(item.watchedSeconds / 60)} 分钟
                    </span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* 3. Reference-Style Editorial Showcase: 豆瓣榜单板块 Tab 切换 */}
      <section id="editorial-curations-section" className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-2 border-b border-zinc-800 pb-4">
          <div>
            <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-widest mb-1 font-sans-modern">
              <Sparkles className="w-3.5 h-3.5" />
              CINEMA INTELLIGENCE SELECTION
            </div>
            <h2 className="text-3xl sm:text-4xl font-instrument-serif font-normal text-white">
              策展专栏 • {activeSection?.title || '热门精选'}
            </h2>
          </div>
          <p className="text-xs sm:text-sm text-zinc-400 font-light max-w-md font-sans-modern">
            豆瓣实时榜单轮换，切换板块探索当季热门与新片
          </p>
        </div>

        {/* 板块切换 Tab */}
        {sections.length > 0 && (
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 scrollbar-none">
            {sections.map((sec) => (
              <button
                key={sec.key}
                onClick={() => setActiveSectionKey(sec.key)}
                className={`px-4 py-2 rounded-full text-xs font-semibold shrink-0 transition-all ${
                  activeSectionKey === sec.key
                    ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/20'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                {sec.title}
              </button>
            ))}
          </div>
        )}

        {/* 6 Grid Cards directly reproducing the reference layout and vibe */}
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
          {editorialMovies.map((movie, idx) => (
            <MovieCard
              key={movie.id}
              movie={movie}
              variant="editorial-3x5"
              delayIndex={idx}
            />
          ))}
        </div>
      </section>

      {/* 4. Quick Category Switcher & Row */}
      <section id="quick-category-section" className="space-y-6">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
              <Flame className="w-4 h-4" />
            </div>
            <h2 className="text-2xl sm:text-3xl font-instrument-serif font-normal text-white">
              热播分类探索
            </h2>
          </div>

          {/* Category Tabs */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-2 sm:pb-0 scrollbar-none">
            {GENRE_LIST.slice(0, 7).map((genre) => (
              <button
                key={genre}
                onClick={() => setSelectedGenreTab(genre)}
                className={`px-4 py-2 rounded-full text-xs font-semibold shrink-0 transition-all ${
                  selectedGenreTab === genre
                    ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/20'
                    : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200 border border-zinc-800'
                }`}
              >
                {genre}
              </button>
            ))}
          </div>
        </div>

        {/* Filtered Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {filteredByTab.map((movie) => (
            <MovieCard key={movie.id} movie={movie} variant="poster" />
          ))}
        </div>
      </section>

      {/* 5. Sci-Fi & Cyberpunk Row */}
      {sciFiMovies.length > 0 && (
      <section id="sci-fi-section" className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[11px] font-mono text-cyan-400 uppercase tracking-widest">CYBERPUNK & HARD SCI-FI</span>
            <h3 className="text-2xl sm:text-3xl font-instrument-serif font-normal text-white">
              硬核科幻与赛博朋克
            </h3>
          </div>
          <button
            onClick={() => navigateTo('search', { genre: '科幻' })}
            className="text-xs font-semibold text-cyan-400 hover:text-cyan-300 flex items-center gap-1"
          >
            探索全部科幻 <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {sciFiMovies.map((movie) => (
            <MovieCard key={movie.id} movie={movie} variant="poster" />
          ))}
        </div>
      </section>
      )}

      {/* 6. Top Rated Masterpieces Section */}
      <section id="top-rated-section" className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-[11px] font-mono text-amber-400 uppercase tracking-widest">MASTERPIECE LEADERBOARD</span>
            <h3 className="text-2xl sm:text-3xl font-instrument-serif font-normal text-white">
              高分神作榜单 (IMDB / 豆瓣 9.0+)
            </h3>
          </div>
          <button
            onClick={() => navigateTo('search', { query: '' })}
            className="text-xs font-semibold text-amber-400 hover:text-amber-300 flex items-center gap-1"
          >
            查看完整榜单 <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {topRatedMovies.slice(0, 4).map((movie) => (
            <MovieCard key={movie.id} movie={movie} variant="horizontal" />
          ))}
        </div>
      </section>

      {/* 7. Anime & Documentaries Dual Row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8 pt-4">
        {/* Anime */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
            <h3 className="text-xl sm:text-2xl font-instrument-serif font-normal text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-rose-500" />
              吉卜力与动画殿堂
            </h3>
            <button
              onClick={() => navigateTo('search', { genre: '动画' })}
              className="text-xs text-rose-400 hover:underline"
            >
              更多动画
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {animeMovies.slice(0, 3).map((movie) => (
              <MovieCard key={movie.id} movie={movie} variant="poster" />
            ))}
          </div>
        </section>

        {/* Nature & Docs */}
        <section className="space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
            <h3 className="text-xl sm:text-2xl font-instrument-serif font-normal text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              4K 原生自然探索纪实
            </h3>
            <button
              onClick={() => navigateTo('search', { genre: '纪录片' })}
              className="text-xs text-emerald-400 hover:underline"
            >
              更多纪录片
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {docMovies.slice(0, 3).map((movie) => (
              <MovieCard key={movie.id} movie={movie} variant="poster" />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
