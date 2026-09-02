import React from 'react';
import { useApp } from '../context/AppContext';
import { MovieCard } from '../components/MovieCard';
import { Bookmark, Sparkles, Film, ArrowRight } from 'lucide-react';

export const FavoritesView: React.FC = () => {
  const { favoriteMovies, navigateTo } = useApp();

  return (
    <div id="favorites-view" className="space-y-8 pb-16 animate-fade-blur">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 border-b border-zinc-800 pb-6">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-indigo-400 uppercase tracking-widest font-sans-modern">
            <Bookmark className="w-3.5 h-3.5" />
            MY BOOKMARKS & FAVORITES
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-instrument-serif font-normal text-white mt-1">
            我的收藏与追剧清单
          </h1>
        </div>

        <div className="px-4 py-2 rounded-2xl bg-zinc-900 border border-zinc-800 self-start sm:self-auto">
          <span className="text-xs text-zinc-400">已收藏: </span>
          <span className="text-base font-bold text-indigo-300">{favoriteMovies.length} 部影片</span>
        </div>
      </div>

      {favoriteMovies.length > 0 ? (
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
          {favoriteMovies.map((movie) => (
            <MovieCard key={movie.id} movie={movie} variant="poster" />
          ))}
        </div>
      ) : (
        <div className="py-24 text-center space-y-4 rounded-3xl bg-zinc-900/30 border border-zinc-800/80 p-8">
          <Bookmark className="w-16 h-16 text-zinc-700 mx-auto" />
          <h3 className="text-2xl font-instrument-serif font-normal text-zinc-200">
            暂无收藏的影视作品
          </h3>
          <p className="text-sm text-zinc-500 max-w-sm mx-auto font-sans-modern">
            在浏览电影或详情页时，点击书签图标即可将喜爱的内容保存至这里。
          </p>
          <button
            onClick={() => navigateTo('home')}
            className="flex items-center gap-2 mx-auto px-6 py-3 rounded-full bg-emerald-500 text-black font-bold text-xs hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20"
          >
            <span>去探索热门影视</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
};
