import React, { useState, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import { MovieCard } from '../components/MovieCard';
import { typeLabel } from '../data/mockMovies';
import { imgUrl } from '../api';
import {
  Play,
  Bookmark,
  Star,
  Users,
  Film,
  ChevronLeft,
  Loader2
} from 'lucide-react';

export const DetailView: React.FC = () => {
  const {
    selectedMovieId,
    getMovieById,
    movies,
    loadMovieDetail,
    currentEpisodes,
    navigateTo,
    goBack,
    toggleFavorite,
    isFavorite,
  } = useApp();

  const movie = getMovieById(selectedMovieId || '');
  const movieId = movie?.id || selectedMovieId || '';
  const activeLine = currentEpisodes(movieId);
  const favorited = movie ? isFavorite(movie.id) : false;
  const [detailLoading, setDetailLoading] = useState(!movie);
  // 元数据补全中（搜索合并进来的片子无简介，进详情要现场回源豆瓣/TMDB 补全，需数秒）
  const [infoFetching, setInfoFetching] = useState(false);
  const infoIncomplete = !movie?.description;

  // 详情页只补全影片资料，站点搜索和线路探测由播放页启动。
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const local = getMovieById(movieId);
      setDetailLoading(!local);
      setInfoFetching(!local?.description);
      await loadMovieDetail(movieId);
      if (cancelled) return;
      setInfoFetching(false);
      setDetailLoading(false);
    })();
    return () => { cancelled = true; };
  }, [movieId]);

  if (!movie) {
    return (
      <div className="py-40 flex flex-col items-center justify-center space-y-4">
        {detailLoading ? (
          <>
            <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
            <p className="text-sm text-zinc-400">正在加载影片详情...</p>
          </>
        ) : (
          <div className="text-center space-y-3">
            <Film className="w-12 h-12 text-zinc-600 mx-auto" />
            <p className="text-zinc-400">影片不存在或已下架</p>
            <button onClick={goBack} className="px-5 py-2 rounded-full bg-emerald-500 text-black text-xs font-bold">
              返回
            </button>
          </div>
        )}
      </div>
    );
  }

  // Related movies in same genre or random
  const relatedMovies = movies.filter(
    (m) => m.id !== movie.id && (m.genres.some((g) => movie.genres.includes(g)) || m.type === movie.type)
  ).slice(0, 8);

  const handlePlay = () => {
    navigateTo('watch', { movieId: movie.id, episodeId: activeLine?.episodes[0]?.id });
  };


  return (
    <div id="detail-view" className="space-y-12 pb-20 animate-fade-blur">
      {/* Back button on top */}
      <div className="flex items-center gap-2">
        <button
          onClick={goBack}
          className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-300 hover:text-white border border-zinc-800 transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>返回</span>
        </button>
        <span className="text-xs text-zinc-500">/</span>
        <span className="text-xs text-zinc-400 font-sans-modern">{movie.title}</span>
      </div>

      {/* 1. Backdrop Showcase Header */}
      <div
        id="detail-backdrop-hero"
        className="relative rounded-3xl overflow-hidden border border-zinc-800/80 shadow-2xl p-6 sm:p-10 lg:p-14"
        style={{
          backgroundImage: `linear-gradient(to top, #09090b 10%, rgba(9,9,11,0.7) 60%, rgba(9,9,11,0.4) 100%), url(${movie.backdrop || movie.cover})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          boxShadow: 'rgba(0, 0, 0, 0.7) 0px 30px 60px -12px, rgba(16, 185, 129, 0.15) 0px 0px 0px 1px',
        }}
      >
        <div className="relative z-10 flex flex-col lg:flex-row gap-8 lg:gap-12 items-start">
          {/* Left Poster (3:5 Reference style) */}
          <div
            className="w-48 sm:w-64 lg:w-72 aspect-[3/5] rounded-3xl overflow-hidden shadow-2xl shrink-0 border border-zinc-700/60 relative group"
            style={{
              boxShadow: 'rgba(0, 0, 0, 0.7) 0px 25px 50px -12px, rgba(16, 185, 129, 0.2) 0px 0px 0px 1px',
            }}
          >
            <img
              src={movie.cover}
              alt={movie.title}
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
            />
            <div className="absolute top-3 left-3">
              <span className="text-xs px-2.5 py-1 rounded-full bg-black/60 backdrop-blur-md text-emerald-300 font-bold border border-emerald-500/30">
                {typeLabel(movie)}
              </span>
            </div>
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <button
                onClick={handlePlay}
                className="w-14 h-14 rounded-full bg-emerald-500 text-black flex items-center justify-center shadow-2xl hover:scale-110 transition-transform"
              >
                <Play className="w-6 h-6 fill-black ml-0.5" />
              </button>
            </div>
          </div>

          {/* Right Details Info */}
          <div className="flex-1 space-y-5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs px-3 py-1 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30">
                {movie.region} {movie.year ? `• ${movie.year}` : ''}
              </span>
              {movie.duration && (
                <span className="text-xs px-3 py-1 rounded-full bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {movie.duration}
                </span>
              )}
              {movie.rating > 0 && (
                <div className="flex items-center gap-1 text-xs px-3 py-1 bg-amber-500/20 text-amber-300 rounded-full font-bold border border-amber-500/30">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  {movie.rating} 豆瓣评分
                </div>
              )}
            </div>

            <div>
              <h1 className="text-4xl sm:text-6xl font-instrument-serif font-normal tracking-tight text-white">
                {movie.title}
              </h1>
              {movie.originalTitle && movie.originalTitle !== movie.title && (
                <p className="text-xl sm:text-2xl font-instrument-serif italic text-emerald-300/90 mt-1">
                  {movie.originalTitle}
                </p>
              )}
            </div>

            {/* Genres & Director */}
            <div className="flex flex-wrap gap-2 pt-1">
              {movie.genres.filter(Boolean).map((g) => (
                <span
                  key={g}
                  className="text-xs px-3 py-1 rounded-lg bg-zinc-800/80 text-zinc-200 border border-zinc-700/60"
                >
                  {g}
                </span>
              ))}
            </div>

            {infoFetching && infoIncomplete ? (
              <div className="flex items-center gap-2 text-xs text-zinc-300 bg-zinc-900/70 border border-zinc-800 rounded-full px-3.5 py-1.5 w-fit">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
                正在加载影片详细信息…
              </div>
            ) : (
              <div className="text-xs sm:text-sm text-zinc-400 space-y-1 font-sans-modern">
                <p><span className="text-zinc-500">导演：</span> {movie.director}</p>
                {movie.cast.length > 0 && (
                  <p className="leading-relaxed break-all"><span className="text-zinc-500">主演：</span> {movie.cast.map((c) => c.name).join(' / ')}</p>
                )}
              </div>
            )}

            {/* Action CTAs */}
            <div className="flex flex-wrap items-center gap-3 pt-3">
              <button
                onClick={handlePlay}
                className="flex items-center gap-2 px-7 py-3.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-sm tracking-wide transition-all shadow-xl shadow-emerald-500/30 hover:scale-105 whitespace-nowrap shrink-0"
              >
                <Play className="w-4 h-4 fill-black" />
                <span>立即观影</span>
              </button>

              <button
                onClick={() => toggleFavorite(movie.id)}
                className={`flex items-center gap-2 px-5 py-3.5 rounded-full border backdrop-blur-md transition-all hover:scale-105 text-sm font-medium whitespace-nowrap shrink-0 ${
                  favorited
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-zinc-900/80 text-zinc-200 border-zinc-700 hover:bg-zinc-800'
                }`}
              >
                <Bookmark className={`w-4 h-4 ${favorited ? 'fill-amber-300' : ''}`} />
                <span>{favorited ? '已在收藏夹' : '收藏作品'}</span>
              </button>




            </div>

          </div>
        </div>
      </div>

      {/* 2. Storyline Synopsis & Cast */}
      <div className="space-y-6">
        {/* Synopsis */}
        <div className="rounded-3xl bg-zinc-900/60 border border-zinc-800 p-6 sm:p-8 space-y-4">
          <h3 className="text-2xl font-instrument-serif font-normal text-white flex items-center gap-2">
            <Film className="w-5 h-5 text-indigo-400" />
            剧情脉络与简介
          </h3>
          {infoFetching && infoIncomplete ? (
            <div className="flex items-center gap-2.5 text-sm text-zinc-400 py-1">
              <Loader2 className="w-4 h-4 animate-spin text-emerald-400" />
              影片简介正在加载，请稍候…
            </div>
          ) : (
            <p className="text-zinc-300 text-sm sm:text-base leading-relaxed font-light font-sans-modern">
              {movie.description || movie.tagline || '暂无简介，正片内容以实际播放为准。'}
            </p>
          )}
        </div>

        {/* Cast & Director：横向排列 */}
        <div className="rounded-3xl bg-zinc-900/60 border border-zinc-800 p-6 sm:p-8 space-y-5">
          <h3 className="text-2xl font-instrument-serif font-normal text-white flex items-center gap-2">
            <Users className="w-5 h-5 text-amber-400" />
            演职人员阵容
          </h3>

          {(movie.director && movie.director !== '未知') || movie.cast.length > 0 ? (
            <div className="flex gap-4 overflow-x-auto pb-2 scrollbar-none">
              {/* Director card */}
              {movie.director && movie.director !== '未知' && (
                <div className="w-20 shrink-0 flex flex-col items-center gap-2 p-2.5 rounded-2xl bg-zinc-800/40 border border-zinc-800">
                  <div className="w-14 h-14 rounded-full bg-emerald-500/20 text-emerald-300 font-bold flex items-center justify-center border border-emerald-500/30">
                    导
                  </div>
                  <div className="w-full text-center min-w-0">
                    <p className="text-xs font-semibold text-zinc-100 truncate" title={movie.director}>
                      {movie.director.split(' / ')[0]}
                    </p>
                    <p className="text-[10px] text-zinc-500">总导演</p>
                  </div>
                </div>
              )}

              {/* Cast member cards */}
              {movie.cast.map((actor, idx) => (
                <div
                  key={idx}
                  className="w-20 shrink-0 flex flex-col items-center gap-2 p-2.5 rounded-2xl bg-zinc-800/40 border border-zinc-800 hover:border-zinc-700 transition-colors"
                >
                  {actor.avatar ? (
                    <img
                      src={imgUrl(actor.avatar)}
                      alt={actor.name}
                      className="w-14 h-14 rounded-full object-cover border border-zinc-700"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-14 h-14 rounded-full bg-zinc-700/40 text-zinc-200 font-bold flex items-center justify-center border border-zinc-700">
                      {actor.name?.[0] || '演'}
                    </div>
                  )}
                  <div className="w-full text-center min-w-0">
                    <p className="text-xs font-semibold text-zinc-200 truncate" title={actor.name}>
                      {actor.name}
                    </p>
                    <p className="text-[10px] text-zinc-500 truncate">{actor.role || '主演'}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : infoFetching && infoIncomplete ? (
            <div className="flex items-center gap-2.5 text-xs text-zinc-400 py-4">
              <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400" />
              演职人员信息正在加载，请稍候…
            </div>
          ) : (
            <p className="text-xs text-zinc-500 text-center py-4">演职员信息待补充</p>
          )}
        </div>
      </div>

      {/* 4. Related Movies Recommendations */}
      {relatedMovies.length > 0 && (
        <section id="related-movies-section" className="space-y-4">
          <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
            <h3 className="text-2xl font-instrument-serif font-normal text-white">
              同类热门推荐
            </h3>
            <button
              onClick={() => navigateTo('search', { genre: movie.genres[0] || '全部' })}
              className="text-xs text-emerald-400 hover:underline"
            >
              探索更多 {movie.genres[0] || '影片'}
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4">
            {relatedMovies.map((relMovie) => (
              <MovieCard key={relMovie.id} movie={relMovie} variant="poster" />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
