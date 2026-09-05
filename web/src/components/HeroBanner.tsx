import React, { useState, useEffect, useRef } from 'react';
import { useApp } from '../context/AppContext';
import { typeLabel } from '../data/mockMovies';
import { Play, Info, Bookmark, Star, Volume2, VolumeX, Sparkles, ChevronRight, ChevronLeft } from 'lucide-react';

export const HeroBanner: React.FC = () => {
  const { navigateTo, toggleFavorite, isFavorite, movies } = useApp();
  // 轮播位 = isFeatured 的 8 部（四类热门各 2 部，后端排好）；isTrending 仅在 featured 不足时按序补位
  const pool = movies.filter((m) => m.isFeatured || m.isTrending);
  const featuredMovies = [
    ...pool.filter((m) => m.isFeatured),
    ...pool.filter((m) => !m.isFeatured && m.isTrending),
  ].slice(0, 8);
  const [currentIndex, setCurrentIndex] = useState(0);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const suppressClickUntilRef = useRef(0);

  const activeMovie = featuredMovies[currentIndex] || featuredMovies[0];
  const favorited = activeMovie ? isFavorite(activeMovie.id) : false;

  useEffect(() => {
    if (featuredMovies.length < 2) return;
    const timer = window.setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % featuredMovies.length);
    }, 8000);
    return () => window.clearTimeout(timer);
  }, [currentIndex, featuredMovies.length]);

  const handleTouchStart = (event: React.TouchEvent<HTMLDivElement>) => {
    if (event.touches.length !== 1) {
      touchStartRef.current = null;
      return;
    }
    const touch = event.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
  };

  const handleTouchEnd = (event: React.TouchEvent<HTMLDivElement>) => {
    const start = touchStartRef.current;
    touchStartRef.current = null;
    if (!start || featuredMovies.length < 2 || event.changedTouches.length !== 1) return;
    const touch = event.changedTouches[0];
    const deltaX = touch.clientX - start.x;
    const deltaY = touch.clientY - start.y;
    if (Math.abs(deltaX) < 50 || Math.abs(deltaX) <= Math.abs(deltaY) * 1.2) return;

    suppressClickUntilRef.current = Date.now() + 500;
    setCurrentIndex((prev) => deltaX < 0
      ? (prev + 1) % featuredMovies.length
      : (prev - 1 + featuredMovies.length) % featuredMovies.length);
  };

  const handleClickCapture = (event: React.MouseEvent<HTMLDivElement>) => {
    if (Date.now() >= suppressClickUntilRef.current) return;
    event.preventDefault();
    event.stopPropagation();
  };

  if (!activeMovie) return null;

  return (
    <div
      id="hero-spotlight-banner"
      className="relative w-full min-h-[500px] lg:min-h-[580px] rounded-3xl overflow-hidden border border-zinc-800/60 shadow-2xl transition-all duration-700 group my-4 touch-pan-y"
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={() => { touchStartRef.current = null; }}
      onClickCapture={handleClickCapture}
      style={{
        boxShadow: 'rgba(0, 0, 0, 0.7) 0px 30px 60px -12px, rgba(16, 185, 129, 0.15) 0px 0px 0px 1px',
      }}
    >
      {/* Background Image with Cinematic Vignettes & Gradient overlays */}
      <div
        className="absolute inset-0 bg-cover bg-center brightness-110 transition-all duration-1000 transform group-hover:scale-103"
        style={{
          backgroundImage: `url(${activeMovie.backdrop || activeMovie.cover})`,
        }}
      />
      <div className="absolute inset-0 bg-gradient-to-t from-zinc-950/85 via-zinc-950/35 to-transparent" />
      <div className="absolute inset-0 bg-gradient-to-r from-zinc-950/80 via-zinc-950/45 to-transparent" />

      {/* 标签与片名始终固定在左上角，不随下方信息区改变位置 */}
      <div className="absolute z-10 top-5 left-5 right-5 sm:top-10 sm:left-10 sm:right-10 xl:top-14 xl:left-14 xl:right-14 text-left space-y-3.5 sm:space-y-5">
        <div className="flex flex-wrap items-center justify-start gap-2 sm:gap-2.5">
          <span className="flex items-center gap-1.5 text-xs px-3 py-1 sm:px-3.5 rounded-full bg-emerald-500/20 text-emerald-300 font-semibold border border-emerald-500/30 backdrop-blur-md">
            <Sparkles className="w-3.5 h-3.5 text-emerald-400" />
            今日推荐
          </span>
          <span className="text-xs px-3 py-1 rounded-full bg-white/10 text-zinc-200 font-medium border border-white/15 backdrop-blur-xl">
            {typeLabel(activeMovie)}
          </span>
          {activeMovie.rating > 0 && (
            <span className="flex items-center gap-1 text-xs px-3 py-1 rounded-full bg-amber-500/20 text-amber-300 font-bold border border-amber-500/30 backdrop-blur-md">
              <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
              {activeMovie.rating} 极高评分
            </span>
          )}
          <button
            onClick={() => toggleFavorite(activeMovie.id)}
            className={`flex items-center justify-center p-[5px] rounded-full border backdrop-blur-xl transition-colors shrink-0 ${
              favorited
                ? 'bg-amber-400/15 text-amber-300 border-amber-300/30'
                : 'bg-white/10 text-zinc-200 border-white/15 hover:bg-white/15 hover:text-white'
            }`}
            title={favorited ? '取消收藏' : '添加收藏'}
            aria-label={favorited ? '取消收藏' : '添加收藏'}
          >
            <Bookmark className={`w-3.5 h-3.5 ${favorited ? 'fill-amber-300' : ''}`} />
          </button>
        </div>

        <div className="space-y-1">
          <h1 className="text-3xl sm:text-6xl lg:text-7xl font-instrument-serif font-normal tracking-tight text-white drop-shadow-xl">
            {activeMovie.title}
          </h1>
          {activeMovie.originalTitle && activeMovie.originalTitle !== activeMovie.title && (
            <p className="text-lg sm:text-2xl font-instrument-serif italic text-emerald-300/90 font-normal">
              {activeMovie.originalTitle}
            </p>
          )}
        </div>

        <div className="space-y-1.5 max-w-3xl text-xs sm:text-sm text-zinc-300 font-sans-modern">
          <div className="flex flex-wrap items-center gap-x-3 sm:gap-x-4 gap-y-1">
            <span>{activeMovie.year}</span>
            <span>•</span>
            <span>{activeMovie.duration}</span>
            <span>•</span>
            <span className="text-emerald-400">{activeMovie.genres.join(' / ')}</span>
          </div>
          <p className="text-zinc-400">
            <span className="text-zinc-300">导演：</span>
            {activeMovie.director}
          </p>
          {activeMovie.cast.length > 0 && (
            <p className="text-zinc-400 line-clamp-2">
              <span className="text-zinc-300">主演：</span>
              {activeMovie.cast.slice(0, 8).map((item) => item.name).join(' / ')}
            </p>
          )}
        </div>
      </div>

      {/* 简介与操作区：宽屏对齐切换器底边，空间不足时居中并让出切换器位置 */}
      <div className="absolute inset-0 z-10 flex items-end justify-center px-5 pt-5 pb-16 sm:px-10 sm:pt-10 sm:pb-20 xl:justify-start xl:px-14 xl:pt-14 xl:pb-6">
        <div className="w-full max-w-4xl space-y-3.5 sm:space-y-5 text-center xl:text-left">
        {/* Tagline & Synopsis */}
        {activeMovie.description ? (
          <p className="text-zinc-300 text-xs sm:text-base leading-relaxed max-w-2xl mx-auto xl:mx-0 font-light font-sans-modern line-clamp-2 sm:line-clamp-3">
            {activeMovie.description}
          </p>
        ) : activeMovie.tagline ? (
          <p className="text-zinc-300 text-xs sm:text-base leading-relaxed max-w-2xl mx-auto xl:mx-0 font-light font-sans-modern line-clamp-2 sm:line-clamp-3">
            {activeMovie.tagline}
          </p>
        ) : null}

        {/* Action Buttons */}
        <div className="flex flex-wrap items-center justify-center xl:justify-start gap-2 sm:gap-3 pt-1">
          <button
            onClick={() => navigateTo('watch', { movieId: activeMovie.id, episodeId: activeMovie.episodes[0]?.id })}
            className="flex items-center gap-2 px-4 py-2.5 sm:px-6 sm:py-3.5 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black font-bold text-xs sm:text-sm tracking-wide transition-all duration-300 shadow-xl shadow-emerald-500/30 hover:scale-105 shrink-0"
          >
            <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4 fill-black" />
            <span>立即播放正片</span>
          </button>

          <button
            onClick={() => navigateTo('detail', { movieId: activeMovie.id })}
            className="flex items-center gap-1.5 px-3.5 py-2.5 sm:px-5 sm:py-3.5 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-zinc-100 font-medium text-xs sm:text-sm border border-zinc-700/60 backdrop-blur-md transition-all hover:scale-105 shrink-0"
          >
            <Info className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-zinc-400" />
            <span>作品详情</span>
          </button>

        </div>
        </div>
      </div>

      {/* 窄屏底部居中；宽屏右下角并与左侧信息区底边对齐 */}
      <div className="absolute bottom-3 left-1/2 -translate-x-1/2 xl:left-auto xl:right-6 xl:translate-x-0 xl:bottom-6 z-20 flex items-center gap-1 sm:gap-2 bg-zinc-950/75 backdrop-blur-md px-2.5 py-1 sm:p-1.5 rounded-full border border-zinc-800 shadow-xl shadow-black/50">
        <button
          onClick={() =>
            setCurrentIndex((prev) => (prev - 1 + featuredMovies.length) % featuredMovies.length)
          }
          className="p-1 sm:p-2 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          aria-label="Previous featured"
        >
          <ChevronLeft className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>

        <div className="flex items-center gap-1 sm:gap-1.5 px-1 sm:px-2">
          {featuredMovies.map((_, i) => (
            <button
              key={i}
              onClick={() => setCurrentIndex(i)}
              className={`h-1 sm:h-1.5 rounded-full transition-all duration-300 ${
                i === currentIndex ? 'w-4 sm:w-6 bg-emerald-400' : 'w-1 sm:w-1.5 bg-zinc-700 hover:bg-zinc-500'
              }`}
              aria-label={`Slide ${i + 1}`}
            />
          ))}
        </div>

        <button
          onClick={() => setCurrentIndex((prev) => (prev + 1) % featuredMovies.length)}
          className="p-1 sm:p-2 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
          aria-label="Next featured"
        >
          <ChevronRight className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
        </button>
      </div>
    </div>
  );
};
