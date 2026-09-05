import React from 'react';
import { MovieItem } from '../types';
import { useApp } from '../context/AppContext';
import { typeLabel } from '../data/mockMovies';
import { Play, Star, Bookmark } from 'lucide-react';

interface MovieCardProps {
  movie: MovieItem;
  variant?: 'editorial-3x5' | 'poster' | 'horizontal';
  className?: string;
  delayIndex?: number;
}

export const MovieCard: React.FC<MovieCardProps> = ({
  movie,
  variant = 'poster',
  className = '',
  delayIndex = 0,
}) => {
  const { navigateTo, toggleFavorite, isFavorite } = useApp();
  const favorited = isFavorite(movie.id);

  // Color mapping based on accentColor
  const colorMap = {
    emerald: {
      shadow: 'rgba(16, 185, 129, 0.2) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 25px 50px -12px',
      badgeBg: 'bg-emerald-400/20 text-emerald-300 border-emerald-500/30',
      textAccent: 'text-emerald-300',
      borderAccent: 'border-emerald-700/50',
      btnHover: 'hover:bg-emerald-500 hover:text-black',
    },
    indigo: {
      shadow: 'rgba(99, 102, 241, 0.2) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 25px 50px -12px',
      badgeBg: 'bg-indigo-400/20 text-indigo-300 border-indigo-500/30',
      textAccent: 'text-indigo-300',
      borderAccent: 'border-indigo-700/50',
      btnHover: 'hover:bg-indigo-500 hover:text-white',
    },
    purple: {
      shadow: 'rgba(168, 85, 247, 0.2) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 25px 50px -12px',
      badgeBg: 'bg-purple-400/20 text-purple-300 border-purple-500/30',
      textAccent: 'text-purple-300',
      borderAccent: 'border-purple-700/50',
      btnHover: 'hover:bg-purple-500 hover:text-white',
    },
    cyan: {
      shadow: 'rgba(34, 211, 238, 0.2) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 25px 50px -12px',
      badgeBg: 'bg-cyan-400/20 text-cyan-300 border-cyan-500/30',
      textAccent: 'text-cyan-300',
      borderAccent: 'border-cyan-700/50',
      btnHover: 'hover:bg-cyan-400 hover:text-black',
    },
    amber: {
      shadow: 'rgba(245, 158, 11, 0.2) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 25px 50px -12px',
      badgeBg: 'bg-amber-400/20 text-amber-300 border-amber-500/30',
      textAccent: 'text-amber-300',
      borderAccent: 'border-amber-700/50',
      btnHover: 'hover:bg-amber-400 hover:text-black',
    },
    rose: {
      shadow: 'rgba(244, 63, 94, 0.2) 0px 0px 0px 1px, rgba(0, 0, 0, 0.6) 0px 25px 50px -12px',
      badgeBg: 'bg-rose-400/20 text-rose-300 border-rose-500/30',
      textAccent: 'text-rose-300',
      borderAccent: 'border-rose-700/50',
      btnHover: 'hover:bg-rose-500 hover:text-white',
    },
  }[movie.accentColor || 'emerald'];

  const handleCardClick = () => {
    navigateTo('detail', { movieId: movie.id });
  };

  const handlePlayNow = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigateTo('watch', { movieId: movie.id, episodeId: movie.episodes[0]?.id });
  };

  const handleToggleFavorite = (e: React.MouseEvent) => {
    e.stopPropagation();
    toggleFavorite(movie.id);
  };

  // 1. Editorial 3:5 Card Variant (Direct reference reproduction)
  if (variant === 'editorial-3x5') {
    return (
      <div
        onClick={handleCardClick}
        className={`card-animate group relative flex flex-col justify-between aspect-[3/5] w-full rounded-3xl p-6 sm:p-8 bg-cover bg-center overflow-hidden cursor-pointer transition-all duration-500 hover:scale-[1.03] hover:-translate-y-1 ${className}`}
        style={{
          backgroundImage: `linear-gradient(to bottom, rgba(0,0,0,0.3) 0%, rgba(0,0,0,0.85) 100%), url(${movie.cover})`,
          boxShadow: colorMap.shadow,
          animationDelay: `${Math.min(delayIndex * 0.1, 0.8)}s`,
        }}
      >
        {/* Top bar */}
        <div className="space-y-4 relative z-10">
          <div className="flex items-center justify-between">
            <span className={`text-xs px-3 py-1.5 rounded-full font-medium border backdrop-blur-md ${colorMap.badgeBg}`}>
              {typeLabel(movie)}
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={handleToggleFavorite}
                className={`p-2 rounded-full backdrop-blur-md border transition-all ${
                  favorited
                    ? 'bg-amber-500/30 text-amber-300 border-amber-500/50'
                    : 'bg-black/40 text-zinc-300 border-white/10 hover:text-white'
                }`}
                title={favorited ? '已收藏' : '加入收藏'}
              >
                <Bookmark className={`w-4 h-4 ${favorited ? 'fill-amber-300' : ''}`} />
              </button>
              {movie.rating > 0 && (
                <span className="flex items-center gap-1 text-xs px-2.5 py-1.5 bg-black/50 backdrop-blur-md text-amber-300 rounded-full font-bold border border-amber-500/20">
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />
                  {movie.rating}
                </span>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-2xl sm:text-3xl tracking-tight font-instrument-serif font-normal text-white group-hover:text-emerald-300 transition-colors drop-shadow-md">
              {movie.title}
            </h3>
            <p className={`text-sm sm:text-base mt-1 font-instrument-serif font-normal ${colorMap.textAccent}`}>
              {movie.originalTitle}
            </p>
          </div>

          <div className="flex flex-wrap gap-1.5 pt-1">
            {movie.genres.slice(0, 3).filter(Boolean).map((genre) => (
              <span
                key={genre}
                className="text-[11px] px-2 py-0.5 rounded-md bg-white/10 text-zinc-200 backdrop-blur-sm"
              >
                {genre}
              </span>
            ))}
            {movie.year > 0 && (
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-white/10 text-zinc-300">
                {movie.year}
              </span>
            )}
            {movie.type !== 'movie' && movie.duration && movie.duration.includes('集') && (
              <span className="text-[11px] px-2 py-0.5 rounded-md bg-emerald-500/15 text-emerald-200 backdrop-blur-sm">
                {movie.duration}
              </span>
            )}
          </div>

          {movie.cast.length > 0 && (
            <p className="text-xs sm:text-sm leading-relaxed text-zinc-300 font-sans-modern line-clamp-2">
              <span className="text-zinc-400">主演：</span>
              {movie.cast.slice(0, 6).map((item) => item.name).join(' / ')}
            </p>
          )}
        </div>

        {/* Bottom Section with Synopsis */}
        {movie.description && (
          <div className={`border-t ${colorMap.borderAccent} pt-4 relative z-10`}>
            <p className="text-zinc-300 text-xs sm:text-sm leading-relaxed font-light line-clamp-2 italic font-sans-modern">
              {movie.description}
            </p>
          </div>
        )}

        {/* Ambient subtle glow overlay on hover */}
        <div className="absolute inset-0 bg-gradient-to-t from-emerald-500/10 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
      </div>
    );
  }

  // 2. Standard Poster Card (for grids & rows)
  if (variant === 'poster') {
    return (
      <div
        onClick={handleCardClick}
        className={`group relative flex flex-col rounded-2xl bg-zinc-900/70 border border-zinc-800/80 overflow-hidden cursor-pointer transition-all duration-300 hover:scale-[1.03] hover:border-zinc-700 hover:shadow-2xl ${className}`}
        style={{
          boxShadow: 'rgba(0, 0, 0, 0.4) 0px 15px 30px -10px',
        }}
      >
        {/* Poster Image */}
        <div className="relative aspect-[2/3] w-full overflow-hidden bg-zinc-950">
          <img
            src={movie.cover}
            alt={movie.title}
            className="w-full h-full object-cover group-hover:scale-108 transition-transform duration-500"
            loading="lazy"
          />
          <div className="absolute inset-0 bg-gradient-to-t from-zinc-950 via-zinc-950/20 to-transparent opacity-80 group-hover:opacity-60 transition-opacity" />

          {/* Top badges */}
          <div className="absolute top-2.5 left-2.5 right-2.5 flex items-center justify-between pointer-events-none">
            <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold bg-black/60 backdrop-blur-md text-emerald-300 border border-emerald-500/20">
              {typeLabel(movie)}
            </span>
            {movie.rating > 0 && (
              <span className="flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full font-bold bg-black/60 backdrop-blur-md text-amber-300 border border-amber-500/20">
                <Star className="w-3 h-3 fill-amber-400 text-amber-400" />
                {movie.rating}
              </span>
            )}
          </div>

          {/* Play hover button */}
          <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 bg-black/40">
            <button
              onClick={handlePlayNow}
              className="w-12 h-12 rounded-full bg-emerald-500 text-black flex items-center justify-center shadow-lg shadow-emerald-500/40 hover:scale-110 transition-transform"
            >
              <Play className="w-5 h-5 fill-black ml-0.5" />
            </button>
          </div>
        </div>

        {/* Card info */}
        <div className="p-3.5 flex flex-col justify-between flex-1">
          <div>
            <h4 className="font-bold text-sm text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
              {movie.title}
            </h4>
            {movie.originalTitle && movie.originalTitle !== movie.title && (
              <p className="text-xs text-zinc-400 font-instrument-serif text-sm truncate mt-0.5">
                {movie.originalTitle}
              </p>
            )}
          </div>

          <div className="flex items-center justify-between mt-2 pt-2 border-t border-zinc-800/60 text-[11px] text-zinc-400">
            <span className="truncate">{movie.genres.slice(0, 2).filter(Boolean).join(' / ')}</span>
            <span className="flex items-center gap-1 shrink-0">
              {movie.year > 0 && <span>{movie.year}</span>}
              {movie.type !== 'movie' && movie.duration && movie.duration.includes('集') && (
                <span className="text-emerald-400/90">{movie.duration}</span>
              )}
            </span>
          </div>
        </div>
      </div>
    );
  }

  // 3. Horizontal Landscape Card (for episode lists & continue watching)
  return (
    <div
      onClick={handleCardClick}
      className={`group flex items-center gap-4 p-3 rounded-2xl bg-zinc-900/60 hover:bg-zinc-800/80 border border-zinc-800/80 hover:border-zinc-700 cursor-pointer transition-all duration-300 hover:shadow-xl ${className}`}
    >
      <div className="relative w-32 sm:w-40 aspect-video rounded-xl overflow-hidden shrink-0 bg-zinc-950">
        <img
          src={movie.backdrop || movie.cover}
          alt={movie.title}
          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
          loading="lazy"
        />
        <div className="absolute inset-0 bg-black/30 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
          <div className="w-8 h-8 rounded-full bg-emerald-500 text-black flex items-center justify-center">
            <Play className="w-4 h-4 fill-black ml-0.5" />
          </div>
        </div>
        <span className="absolute bottom-1.5 right-1.5 text-[10px] px-1.5 py-0.5 rounded bg-black/70 text-zinc-200">
          {movie.duration}
        </span>
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h4 className="font-bold text-sm text-zinc-100 group-hover:text-emerald-300 transition-colors truncate">
            {movie.title}
          </h4>
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-300 shrink-0">
            {typeLabel(movie)}
          </span>
        </div>
        {movie.originalTitle && movie.originalTitle !== movie.title && (
          <p className="text-xs text-zinc-400 font-instrument-serif text-sm truncate mt-0.5">
            {movie.originalTitle}
          </p>
        )}
        <p className="text-xs text-zinc-400 line-clamp-1 mt-1 font-sans-modern">
          {movie.description}
        </p>
        <div className="flex items-center gap-3 mt-2 text-xs text-zinc-400">
          {movie.rating > 0 && (
            <>
              <span className="text-amber-400 font-bold flex items-center gap-0.5">
                <Star className="w-3 h-3 fill-amber-400 inline" /> {movie.rating}
              </span>
              <span>•</span>
            </>
          )}
          <span>{movie.genres.join(' / ')}</span>
          {movie.year > 0 && (
            <>
              <span>•</span>
              <span>{movie.year}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
