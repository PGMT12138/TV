// 选源弹窗：按智能选源探测结果分组展示全部站点线路，点击换源。
// 经 portal 挂到 body——页面容器的入场动画会产生层叠上下文，直接渲染会被导航栏盖住。
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, X, ListVideo } from 'lucide-react';
import { ResourceMatch, ScanState } from '../types';
import { fmtSpeed, fmtRes, AD_LABEL, AD_CLASS } from '../utils/scanFormat';
import { SITE_GROUP_DEFS, classifySites } from '../utils/siteGroups';

interface Props {
  open: boolean;
  onClose: () => void;
  scan?: ScanState;
  matches: ResourceMatch[];
  isFeature: boolean;
  selectedSiteKey?: string;
  selectedFlag?: string;
  onSelect: (siteKey: string, flag?: string) => void;
}

export const SourcePickerModal: React.FC<Props> = ({
  open, onClose, scan, matches, isFeature, selectedSiteKey, selectedFlag, onSelect,
}) => {
  // 分组折叠：推荐默认展开，其余默认收起
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({ recommended: true });

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  // 有部分结果即分组展示（扫描中渐进出现），完全无结果才显示占位
  const grouped = (scan?.results?.length || 0) > 0;
  const { groups } = grouped
    ? classifySites(scan!.results, matches, isFeature)
    : { groups: null as Record<string, ReturnType<typeof classifySites>['groups']['recommended']> | null };
  const okCount = (scan?.results || []).filter((r) => r.status === 'ok' && r.flag).length;

  return createPortal(
    <div
      className="fixed inset-0 z-[70] bg-black/80 backdrop-blur-md flex items-center justify-center p-4 pt-16 sm:pt-20"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] flex flex-col bg-zinc-900 border border-zinc-700/80 rounded-3xl shadow-2xl overflow-hidden animate-fade-blur"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头部：标题 + 扫描进度 */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-zinc-800 bg-zinc-900/95 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-white flex items-center gap-2">
              <ListVideo className="w-4 h-4 text-emerald-400" />
              选择来源与线路
            </h3>
            <p className="text-[11px] text-zinc-500 truncate mt-0.5">
              {scan?.status === 'running'
                ? `智能测速中 ${scan.finished}/${scan.total || '…'} 条线路，结果实时更新`
                : grouped
                  ? `${okCount}/${scan!.results.length} 条线路可用 · ${matches.length} 个站点`
                  : '尚未完成探测'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-white shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 分组列表（各组可折叠，推荐默认展开） */}
        <div className="overflow-y-auto p-4 space-y-2.5">
          {!groups && (
            <div className="py-14 flex flex-col items-center gap-3 text-zinc-400">
              <Loader2 className="w-8 h-8 animate-spin text-emerald-400" />
              <p className="text-sm">正在扫描站点线路…</p>
            </div>
          )}
          {groups && SITE_GROUP_DEFS.map((g) => {
            const entries = groups[g.key] || [];
            if (!entries.length) return null;
            const isOpen = !!openGroups[g.key];
            return (
              <section key={g.key}>
                <button
                  onClick={() => setOpenGroups((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                  className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-xl bg-zinc-800/80 border border-zinc-700/60 hover:bg-zinc-800 hover:border-zinc-600 transition-colors"
                >
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className={`text-xs font-bold shrink-0 ${g.cls}`}>{g.label}</span>
                    <span className="text-[10px] text-zinc-500 truncate">{g.hint}</span>
                  </span>
                  <span className="flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-zinc-900/80 text-zinc-400">
                      {entries.length} 站点
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {isOpen && (
                  <div className="mt-1.5 space-y-1.5">
                    {entries.map((e) => (
                      <div key={`${e.match.siteKey}:${e.match.vodId}`} className="rounded-2xl bg-zinc-800/40 border border-zinc-800/80 overflow-hidden">
                        <div className="px-3 py-1.5 flex items-center gap-1.5 border-b border-zinc-800/60 bg-zinc-900/60">
                          <span className="text-[11px] font-bold text-zinc-300 truncate">{e.match.siteName}</span>
                          {e.match.remarks && <span className="text-[10px] text-zinc-500 truncate font-normal">{e.match.remarks}</span>}
                          {e.best?.metrics && (
                            <span className="ml-auto flex items-center gap-1 text-[9px] shrink-0">
                              <span className="text-emerald-400/90">{fmtSpeed(e.best.metrics.throughputMbps)}</span>
                              <span className="text-zinc-400/90">{fmtRes(e.best.metrics.height)}</span>
                              <span className={AD_CLASS[e.best.metrics.adLevel]}>{AD_LABEL[e.best.metrics.adLevel]}</span>
                            </span>
                          )}
                        </div>
                        <div className="p-1.5 grid grid-cols-1 sm:grid-cols-2 gap-1">
                          {e.lines.map((r) => {
                            const active = r.siteKey === selectedSiteKey && r.flag === selectedFlag;
                            const ok = r.status === 'ok' && r.metrics;
                            return (
                              <button
                                key={r.flag}
                                onClick={() => onSelect(r.siteKey, r.flag)}
                                className={`flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl text-left border transition-colors ${
                                  active
                                    ? 'bg-emerald-500/15 border-emerald-500/50'
                                    : 'bg-zinc-900/60 border-zinc-800 hover:bg-zinc-700/60 hover:border-zinc-600'
                                }`}
                              >
                                <span className="text-xs text-zinc-200 truncate">{r.flag}</span>
                                {ok ? (
                                  <span className="flex items-center gap-1 text-[9px] shrink-0 whitespace-nowrap">
                                    <span className="text-emerald-400/90">{fmtSpeed(r.metrics!.throughputMbps)}</span>
                                    <span className="text-zinc-400/90">{fmtRes(r.metrics!.height)}</span>
                                    <span className={AD_CLASS[r.metrics!.adLevel]}>{AD_LABEL[r.metrics!.adLevel]}</span>
                                  </span>
                                ) : (
                                  <span className="text-[9px] text-rose-400/80 shrink-0" title={r.error}>✕ 失败</span>
                                )}
                              </button>
                            );
                          })}
                          {!e.lines.length && (
                            <div className="px-2.5 py-1.5 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                              <span className="truncate">{e.detailFail || '未探测（候选超出扫描范围）'}</span>
                              <button
                                onClick={() => onSelect(e.match.siteKey, undefined)}
                                className="text-emerald-400/90 hover:text-emerald-300 shrink-0"
                              >
                                仍要尝试
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
    </div>,
    document.body
  );
};
