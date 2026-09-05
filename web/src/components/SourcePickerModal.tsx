// 选源弹窗：按智能选源探测结果分组展示全部站点线路，点击换源。
// 分区面板化：每个分组一块独立色带面板（标题栏 + 站点行），组间距拉开，泾渭分明；
// 未探测组带单站懒补测（探测此站），结果渐进并入当前分组。
// 经 portal 挂到 body——页面容器的入场动画会产生层叠上下文，直接渲染会被导航栏盖住。
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Loader2, Radar, RefreshCw, X, ListVideo } from 'lucide-react';
import { ResourceMatch, ScanState } from '../types';
import { fmtSpeed, fmtRes, AD_LABEL, AD_CLASS, isUnsupportedCodec } from '../utils/scanFormat';
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
  probingSites?: Set<string>;                    // 懒补测进行中的站点
  onProbeSite?: (siteKey: string) => void;       // 发起单站懒补测
  onReprobeAll?: () => void;                     // 全量重探全部已探测站点
  onReprobeSite?: (siteKey: string) => void;     // 全量重探单站
}

// 各分区的视觉身份：面板描边/底色 + 标题圆点 + 标题色（与 hint 文案呼应）
const GROUP_STYLE: Record<string, { panel: string; dot: string; label: string }> = {
  recommended: { panel: 'border-emerald-500/25 bg-emerald-500/[0.04]', dot: 'bg-emerald-400', label: 'text-emerald-300' },
  ads: { panel: 'border-amber-500/25 bg-amber-500/[0.04]', dot: 'bg-amber-400', label: 'text-amber-300' },
  duration: { panel: 'border-orange-500/25 bg-orange-500/[0.04]', dot: 'bg-orange-400', label: 'text-orange-300' },
  netdisk: { panel: 'border-sky-500/25 bg-sky-500/[0.04]', dot: 'bg-sky-400', label: 'text-sky-300' },
  failed: { panel: 'border-rose-500/20 bg-rose-500/[0.03]', dot: 'bg-rose-400/80', label: 'text-rose-300/90' },
  unprobed: { panel: 'border-zinc-700/60 bg-zinc-800/30', dot: 'bg-zinc-500', label: 'text-zinc-300' },
};

export const SourcePickerModal: React.FC<Props> = ({
  open, onClose, scan, matches, isFeature, selectedSiteKey, selectedFlag, onSelect,
  probingSites, onProbeSite, onReprobeAll, onReprobeSite,
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
        {/* 头部：标题 + 扫描进度 / 汇总（早停时说明原因） */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-zinc-800 bg-zinc-900/95 shrink-0">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <ListVideo className="w-4 h-4 text-emerald-400" />
                选择来源与线路
              </h3>
              {/* 重新探测全部已探测站点：逐线全量实测，不做达标即停 */}
              {onReprobeAll && (scan?.results?.length || 0) > 0 && (
                <button
                  onClick={onReprobeAll}
                  disabled={scan?.status === 'running' || (probingSites?.size || 0) > 0}
                  title="重新实测全部已探测的站点线路（全量不早停）"
                  className="flex items-center gap-1.5 px-3 py-1 rounded-xl bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[11px] font-bold hover:bg-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
                >
                  {(probingSites?.size || 0) > 0
                    ? <><Loader2 className="w-3.5 h-3.5 animate-spin" /> 重探中…</>
                    : <><RefreshCw className="w-3.5 h-3.5" /> 重新探测</>}
                </button>
              )}
            </div>
            <p className="text-[11px] text-zinc-500 truncate mt-0.5">
              {scan?.status === 'running'
                ? `智能测速中 ${scan.finished}/${scan.total || '…'} 条线路，结果实时更新`
                : grouped
                  ? <>{okCount}/{scan!.results.length} 条线路可用 · {matches.length} 个站点
                      {scan?.stoppedEarly && <span className="text-emerald-300/90"> · 已锁定高质量线路，提前完成</span>}</>
                  : '尚未完成探测'}
            </p>
          </div>
          <button onClick={onClose} className="p-2 rounded-full hover:bg-zinc-800 text-zinc-400 hover:text-white shrink-0">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 分组面板：组间 space-y-4 拉开距离；面板内 space-y-2 放站点行 */}
        <div className="overflow-y-auto p-4 space-y-4">
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
            const style = GROUP_STYLE[g.key] || GROUP_STYLE.unprobed;
            return (
              <section key={g.key} className={`rounded-2xl border ${style.panel} overflow-hidden`}>
                <button
                  onClick={() => setOpenGroups((prev) => ({ ...prev, [g.key]: !prev[g.key] }))}
                  className="w-full flex items-center gap-2.5 px-4 py-3 border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                >
                  <span className={`w-2 h-2 rounded-full shrink-0 ${style.dot}`} />
                  <span className={`text-xs font-bold shrink-0 ${style.label}`}>{g.label}</span>
                  {g.hint && <span className="text-[10px] text-zinc-500 truncate">{g.hint}</span>}
                  <span className="ml-auto flex items-center gap-1.5 shrink-0">
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-black/30 text-zinc-400 tabular-nums">
                      {entries.length} 站
                    </span>
                    <ChevronDown className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                  </span>
                </button>
                {isOpen && (
                  <div className="p-2.5 space-y-2">
                    {entries.map((e) => {
                      const probing = !!probingSites?.has(e.match.siteKey);
                      const hasLines = e.lines.length > 0 || !!e.detailFail;
                      return (
                        <div key={`${e.match.siteKey}:${e.match.vodId}`}
                          className="rounded-xl bg-black/25 border border-white/5 px-3 py-2">
                          {/* 站点行头：名称 + 备注 + 最优指标 / 未探测操作 */}
                          <div className="flex items-center gap-2 min-w-0">
                            <span className="text-xs font-bold text-zinc-200 truncate">{e.match.siteName}</span>
                            {e.match.remarks && (
                              <span className="text-[10px] text-zinc-500 truncate font-normal shrink-0">{e.match.remarks}</span>
                            )}
                            {e.best?.metrics && (
                              <span className="ml-auto flex items-center gap-1.5 text-[9px] shrink-0">
                                {isUnsupportedCodec(e.best.metrics.codec) && (
                                  <span className="text-amber-400/90" title="视频编码当前浏览器播不了">播不了✕</span>
                                )}
                                <span className="text-emerald-400/90">{fmtSpeed(e.best.metrics.throughputMbps)}</span>
                                <span className="text-zinc-400/90">{fmtRes(e.best.metrics.height)}</span>
                                <span className={AD_CLASS[e.best.metrics.adLevel]}>{AD_LABEL[e.best.metrics.adLevel]}</span>
                              </span>
                            )}
                            {hasLines && onReprobeSite && (
                              <button
                                disabled={probing}
                                onClick={() => onReprobeSite(e.match.siteKey)}
                                title="全量重新探测该站点（不早停）"
                                className={`flex items-center gap-1 px-1.5 py-1 rounded-lg border text-[10px] transition-colors shrink-0 ${
                                  e.best?.metrics ? '' : 'ml-auto'
                                } bg-zinc-800/80 border-zinc-700 text-zinc-400 hover:text-emerald-300 hover:border-emerald-500/40 disabled:opacity-50 disabled:cursor-not-allowed`}
                              >
                                {probing
                                  ? <><Loader2 className="w-3 h-3 animate-spin" /> 重探中</>
                                  : <><RefreshCw className="w-3 h-3" /> 重探</>}
                              </button>
                            )}
                            {!hasLines && onProbeSite && (
                              <span className="ml-auto flex items-center gap-1.5 shrink-0">
                                <button
                                  disabled={probing}
                                  onClick={() => onProbeSite(e.match.siteKey)}
                                  className="flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold hover:bg-emerald-500/25 disabled:opacity-60 transition-colors"
                                >
                                  {probing
                                    ? <><Loader2 className="w-3 h-3 animate-spin" /> 探测中…</>
                                    : <><Radar className="w-3 h-3" /> 探测此站</>}
                                </button>
                                <button
                                  onClick={() => onSelect(e.match.siteKey, undefined)}
                                  title="跳过测速，直接用该站默认线路起播（无速度/清晰度参考）"
                                  className="px-2 py-1 rounded-lg bg-zinc-800/80 border border-zinc-700 text-zinc-300 text-[10px] hover:border-zinc-500 transition-colors"
                                >
                                  直接播放
                                </button>
                              </span>
                            )}
                          </div>
                          {/* 线路 chips：成功带指标，失败带原因 tooltip，当前线路高亮 */}
                          {(hasLines) && (
                            <div className="flex flex-wrap gap-1.5 mt-1.5">
                              {e.lines.map((r) => {
                                const active = r.siteKey === selectedSiteKey && r.flag === selectedFlag;
                                const ok = r.status === 'ok' && r.metrics;
                                return (
                                  <button
                                    key={r.flag}
                                    onClick={() => onSelect(r.siteKey, r.flag)}
                                    title={ok ? undefined : r.error}
                                    className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11px] border transition-colors ${
                                      active
                                        ? 'bg-emerald-500/15 border-emerald-500/60 text-emerald-200'
                                        : ok
                                          ? 'bg-zinc-900/80 border-zinc-700/70 text-zinc-200 hover:border-zinc-500'
                                          : 'bg-zinc-900/40 border-zinc-800/70 text-zinc-400 hover:border-zinc-600'
                                    }`}
                                  >
                                    <span className="truncate max-w-[10rem]">{r.flag}</span>
                                    {ok ? (
                                      <span className="flex items-center gap-1 text-[9px] shrink-0 whitespace-nowrap">
                                        {isUnsupportedCodec(r.metrics!.codec) && (
                                          <span className="text-amber-400/90" title="视频编码当前浏览器播不了，选择后可能一直加载中">播不了✕</span>
                                        )}
                                        <span className="text-emerald-400/90">{fmtSpeed(r.metrics!.throughputMbps)}</span>
                                        <span className="text-zinc-400/90">{fmtRes(r.metrics!.height)}</span>
                                        <span className={AD_CLASS[r.metrics!.adLevel]}>{AD_LABEL[r.metrics!.adLevel]}</span>
                                      </span>
                                    ) : (
                                      <span className="text-rose-400/80 text-[9px] shrink-0">✕ 失败</span>
                                    )}
                                  </button>
                                );
                              })}
                              {!e.lines.length && e.detailFail && (
                                <span className="text-[10px] text-zinc-500 py-1">{e.detailFail}</span>
                              )}
                              {!e.lines.length && !e.detailFail && (
                                <span className="text-[10px] text-zinc-500 py-1">未探测（候选超出扫描范围）</span>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
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
