import React, { useState, useMemo, useEffect } from 'react';
import { useApp } from '../context/AppContext';
import {
  History,
  Trash2,
  Play,
  Clock,
  Search,
  CheckSquare,
  Square,
  AlertTriangle,
  X,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';

const DEFAULT_PAGE_SIZE = 20;
const PAGE_SIZE_OPTIONS = [20, 50, 100];

export const HistoryView: React.FC = () => {
  const { watchHistory, deleteHistoryItem, clearAllHistory, navigateTo } = useApp();

  const [searchQuery, setSearchQuery] = useState('');
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [showClearConfirmModal, setShowClearConfirmModal] = useState(false);

  // Reset to first page when search or page size changes
  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, pageSize]);

  // Time calculations
  const totalMinutesWatched = useMemo(() => {
    return Math.floor(
      watchHistory.reduce((acc, curr) => acc + (curr.watchedSeconds || 0), 0) / 60
    );
  }, [watchHistory]);

  const filteredHistory = useMemo(() => {
    return watchHistory.filter((item) => {
      if (
        searchQuery.trim() &&
        !item.movieTitle.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !item.episodeTitle.toLowerCase().includes(searchQuery.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }, [watchHistory, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filteredHistory.length / pageSize));
  const safeCurrentPage = Math.min(Math.max(1, currentPage), totalPages);

  const paginatedHistory = useMemo(() => {
    const startIndex = (safeCurrentPage - 1) * pageSize;
    return filteredHistory.slice(startIndex, startIndex + pageSize);
  }, [filteredHistory, safeCurrentPage, pageSize]);

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((i) => i !== id) : [...prev, id]
    );
  };

  const handleSelectAll = () => {
    if (selectedIds.length === filteredHistory.length) {
      setSelectedIds([]);
    } else {
      setSelectedIds(filteredHistory.map((item) => item.id));
    }
  };

  const handleDeleteBatch = () => {
    selectedIds.forEach((id) => deleteHistoryItem(id));
    setSelectedIds([]);
    setIsBatchMode(false);
  };

  const formatRelativeTime = (timestamp: number) => {
    const diffSecs = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSecs < 60) return '刚刚';
    const diffMins = Math.floor(diffSecs / 60);
    if (diffMins < 60) return `${diffMins} 分钟前`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} 小时前`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 30) return `${diffDays} 天前`;
    return new Date(timestamp).toLocaleDateString('zh-CN');
  };

  // Generate pagination page numbers
  const getPageNumbers = () => {
    const pages: (number | string)[] = [];
    if (totalPages <= 7) {
      for (let i = 1; i <= totalPages; i++) {
        pages.push(i);
      }
    } else {
      pages.push(1);
      if (safeCurrentPage > 3) {
        pages.push('...');
      }
      const start = Math.max(2, safeCurrentPage - 1);
      const end = Math.min(totalPages - 1, safeCurrentPage + 1);
      for (let i = start; i <= end; i++) {
        pages.push(i);
      }
      if (safeCurrentPage < totalPages - 2) {
        pages.push('...');
      }
      pages.push(totalPages);
    }
    return pages;
  };

  return (
    <div id="history-view" className="space-y-8 pb-16 animate-fade-blur">
      {/* Header with Title & Stats Overview */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b border-zinc-800 pb-6">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-400 uppercase tracking-widest font-sans-modern">
            <History className="w-3.5 h-3.5" />
            WATCH HISTORY & PROGRESS
          </div>
          <h1 className="text-3xl sm:text-4xl lg:text-5xl font-instrument-serif font-normal text-white mt-1">
            观影足迹与播放历史
          </h1>
        </div>

        {/* Stats Pills */}
        <div className="flex items-center gap-3">
          <div className="px-4 py-2.5 rounded-2xl bg-zinc-900 border border-zinc-800">
            <span className="text-xs text-zinc-500 block">观看影片</span>
            <span className="text-lg font-bold text-white font-mono">{watchHistory.length} 部</span>
          </div>
          <div className="px-4 py-2.5 rounded-2xl bg-zinc-900 border border-zinc-800">
            <span className="text-xs text-zinc-500 block">累计时长</span>
            <span className="text-lg font-bold text-emerald-400 font-mono">{totalMinutesWatched} 分钟</span>
          </div>
        </div>
      </div>

      {watchHistory.length > 0 ? (
        <>
          {/* Controls Bar: Search, Batch Actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            {/* Search within history */}
            <div className="flex items-center gap-2 px-4 py-2 rounded-2xl bg-zinc-900/90 border border-zinc-800 text-xs w-full sm:w-80">
              <Search className="w-4 h-4 text-zinc-400 shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索历史记录..."
                className="w-full bg-transparent text-zinc-100 placeholder-zinc-500 focus:outline-none"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery('')} className="text-zinc-500 hover:text-zinc-300">
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {/* Batch mode and clear buttons */}
            <div className="flex items-center gap-2 self-end sm:self-auto">
              {isBatchMode ? (
                <>
                  <button
                    onClick={handleSelectAll}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
                  >
                    {selectedIds.length === filteredHistory.length ? (
                      <CheckSquare className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <Square className="w-3.5 h-3.5" />
                    )}
                    <span>全选</span>
                  </button>
                  <button
                    onClick={handleDeleteBatch}
                    disabled={selectedIds.length === 0}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl bg-rose-500/20 hover:bg-rose-500/30 text-rose-300 border border-rose-500/40 text-xs font-semibold disabled:opacity-50"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>删除已选 ({selectedIds.length})</span>
                  </button>
                  <button
                    onClick={() => {
                      setIsBatchMode(false);
                      setSelectedIds([]);
                    }}
                    className="px-3 py-1.5 rounded-xl bg-zinc-800 text-xs text-zinc-400 hover:text-white"
                  >
                    取消
                  </button>
                </>
              ) : (
                <>
                  <button
                    onClick={() => setIsBatchMode(true)}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-zinc-300 border border-zinc-800 text-xs transition-colors"
                  >
                    <span>批量管理</span>
                  </button>
                  <button
                    onClick={() => setShowClearConfirmModal(true)}
                    className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl bg-zinc-900 hover:bg-rose-500/10 text-zinc-400 hover:text-rose-300 border border-zinc-800 hover:border-rose-500/30 text-xs transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>清空历史</span>
                  </button>
                </>
              )}
            </div>
          </div>

          {/* History Item Cards List */}
          {filteredHistory.length > 0 ? (
            <div className="space-y-3.5">
              {paginatedHistory.map((item) => {
                const isSelected = selectedIds.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className={`group relative flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-3xl border transition-all duration-300 ${
                      isSelected
                        ? 'bg-emerald-500/10 border-emerald-500/50'
                        : 'bg-zinc-900/70 hover:bg-zinc-800/80 border-zinc-800/80 hover:border-zinc-700'
                    }`}
                    style={{
                      boxShadow: 'rgba(0, 0, 0, 0.4) 0px 15px 30px -10px',
                    }}
                  >
                    <div className="flex items-center gap-4 min-w-0">
                      {/* Checkbox in batch mode */}
                      {isBatchMode && (
                        <button
                          onClick={() => toggleSelect(item.id)}
                          className="p-1 text-zinc-400 hover:text-emerald-400 transition-colors"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-5 h-5 text-emerald-400" />
                          ) : (
                            <Square className="w-5 h-5" />
                          )}
                        </button>
                      )}

                      {/* Thumbnail with progress bar */}
                      <div
                        onClick={() => navigateTo('watch', { movieId: item.movieId, episodeId: item.episodeId })}
                        className="relative w-32 sm:w-44 aspect-video rounded-2xl overflow-hidden shrink-0 bg-zinc-950 cursor-pointer"
                      >
                        <img
                          src={item.backdrop || item.cover}
                          alt={item.movieTitle}
                          className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                        />
                        <div className="absolute inset-0 bg-black/40 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="w-9 h-9 rounded-full bg-emerald-500 text-black flex items-center justify-center shadow-lg">
                            <Play className="w-4 h-4 fill-black ml-0.5" />
                          </div>
                        </div>
                        {/* Progress bar */}
                        <div className="absolute bottom-0 left-0 right-0 h-1.5 bg-zinc-800/90">
                          <div
                            className="h-full bg-emerald-400 transition-all"
                            style={{ width: `${item.progressPercent}%` }}
                          />
                        </div>
                      </div>

                      {/* Title & info */}
                      <div className="min-w-0">
                        <h3
                          onClick={() => navigateTo('watch', { movieId: item.movieId, episodeId: item.episodeId })}
                          className="text-base sm:text-lg font-bold text-zinc-100 group-hover:text-emerald-300 transition-colors truncate cursor-pointer font-sans-modern"
                        >
                          {item.movieTitle}
                        </h3>
                        <p className="text-xs text-zinc-400 font-sans-modern truncate mt-0.5">
                          {item.episodeTitle}
                        </p>
                        <div className="flex flex-wrap items-center gap-2 mt-2 text-xs text-zinc-400 font-mono">
                          <span className="text-emerald-400 font-bold">
                            观看进度: {item.progressPercent}%
                          </span>
                          <span>•</span>
                          <span>已看 {Math.floor(item.watchedSeconds / 60)} 分钟</span>
                          <span>•</span>
                          <span className="text-zinc-500 font-sans-modern">
                            {formatRelativeTime(item.lastWatchedAt)}
                          </span>
                        </div>
                      </div>
                    </div>

                    {/* Actions Right */}
                    <div className="flex items-center gap-2 sm:self-center shrink-0">
                      <button
                        onClick={() =>
                          navigateTo('watch', { movieId: item.movieId, episodeId: item.episodeId })
                        }
                        className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-emerald-500/20 hover:bg-emerald-500 text-emerald-300 hover:text-black font-semibold text-xs border border-emerald-500/40 transition-all cursor-pointer"
                      >
                        <Play className="w-3.5 h-3.5 fill-current" />
                        <span>继续播放</span>
                      </button>

                      <button
                        onClick={() => deleteHistoryItem(item.id)}
                        className="p-2 rounded-full bg-zinc-800 hover:bg-rose-500/20 text-zinc-400 hover:text-rose-300 border border-zinc-700 hover:border-rose-500/40 transition-colors cursor-pointer"
                        title="删除此条记录"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="py-12 text-center text-zinc-500 text-sm">
              未找到匹配 "{searchQuery}" 的观影记录
            </div>
          )}

          {/* Bottom Pagination Bar */}
          {filteredHistory.length > 0 && (
            <div
              id="history-pagination-bar"
              className="flex flex-col sm:flex-row items-center justify-between gap-4 pt-6 pb-2 border-t border-zinc-800/80"
            >
              {/* Left Total Info */}
              <div className="text-xs text-zinc-400 font-mono flex items-center gap-1.5">
                <span>
                  共 <span className="text-emerald-400 font-bold">{filteredHistory.length}</span> 条记录 · 每页
                </span>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  className="px-1.5 py-1 rounded-lg bg-zinc-900 border border-zinc-800 text-emerald-400 font-bold focus:outline-none focus:border-emerald-500/50 cursor-pointer hover:border-zinc-700 transition-colors [color-scheme:dark]"
                  title="选择每页显示条数"
                >
                  {PAGE_SIZE_OPTIONS.map((size) => (
                    <option key={size} value={size} className="bg-zinc-900 text-zinc-100">
                      {size}
                    </option>
                  ))}
                </select>
                <span>
                  条 · 第 <span className="text-white font-bold">{safeCurrentPage}</span> / {totalPages} 页
                </span>
              </div>

              {/* Right Page Controls */}
              <div className="flex items-center gap-1.5">
                {/* Previous Page */}
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={safeCurrentPage === 1}
                  className="flex items-center gap-1 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-300 transition-colors cursor-pointer disabled:cursor-not-allowed"
                  title="上一页"
                >
                  <ChevronLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">上一页</span>
                </button>

                {/* Page Number Buttons */}
                <div className="flex items-center gap-1">
                  {getPageNumbers().map((pageItem, idx) => {
                    if (typeof pageItem === 'string') {
                      return (
                        <span key={`ellipsis-${idx}`} className="px-2 py-1 text-xs text-zinc-600">
                          ...
                        </span>
                      );
                    }
                    const isCurrent = pageItem === safeCurrentPage;
                    return (
                      <button
                        key={`page-${pageItem}`}
                        type="button"
                        onClick={() => setCurrentPage(pageItem)}
                        className={`w-8 h-8 rounded-xl text-xs font-mono font-semibold transition-all cursor-pointer ${
                          isCurrent
                            ? 'bg-emerald-500 text-black shadow-md shadow-emerald-500/20'
                            : 'bg-zinc-900 hover:bg-zinc-800 text-zinc-400 hover:text-zinc-100 border border-zinc-800'
                        }`}
                      >
                        {pageItem}
                      </button>
                    );
                  })}
                </div>

                {/* Next Page */}
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={safeCurrentPage === totalPages}
                  className="flex items-center gap-1 px-3 py-2 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-medium text-zinc-300 hover:text-white hover:bg-zinc-800 disabled:opacity-40 disabled:hover:bg-zinc-900 disabled:hover:text-zinc-300 transition-colors cursor-pointer disabled:cursor-not-allowed"
                  title="下一页"
                >
                  <span className="hidden sm:inline">下一页</span>
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </>
      ) : (
        /* Empty State */
        <div className="py-24 text-center space-y-4 rounded-3xl bg-zinc-900/30 border border-zinc-800/80 p-8">
          <History className="w-16 h-16 text-zinc-700 mx-auto" />
          <h3 className="text-2xl font-instrument-serif font-normal text-zinc-200">
            暂无观影历史记录
          </h3>
          <p className="text-sm text-zinc-500 max-w-sm mx-auto font-sans-modern">
            您观看的所有电影与剧集进度都会自动同步保存在这里，方便您随时一键续播。
          </p>
          <button
            onClick={() => navigateTo('home')}
            className="flex items-center gap-2 mx-auto px-6 py-3 rounded-full bg-emerald-500 text-black font-bold text-xs hover:bg-emerald-400 transition-colors shadow-lg shadow-emerald-500/20 cursor-pointer"
          >
            <span>去探索热门影视</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Clear Confirmation Modal */}
      {showClearConfirmModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4"
          onClick={() => setShowClearConfirmModal(false)}
        >
          <div
            className="w-full max-w-sm bg-zinc-900 border border-zinc-800 rounded-3xl p-6 shadow-2xl space-y-4 text-zinc-100"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="w-12 h-12 rounded-2xl bg-rose-500/20 text-rose-400 flex items-center justify-center border border-rose-500/30">
              <AlertTriangle className="w-6 h-6" />
            </div>

            <div>
              <h3 className="text-lg font-bold text-white">确认清空全部播放历史？</h3>
              <p className="text-xs text-zinc-400 mt-1">
                此操作将永久清除全部 {watchHistory.length} 条播放进度，无法撤销。
              </p>
            </div>

            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setShowClearConfirmModal(false)}
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition-colors"
              >
                取消
              </button>
              <button
                onClick={() => {
                  clearAllHistory();
                  setShowClearConfirmModal(false);
                }}
                className="px-4 py-2 text-xs font-semibold rounded-xl bg-rose-500 hover:bg-rose-600 text-white transition-colors"
              >
                确认清空
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
