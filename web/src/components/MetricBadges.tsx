// 线路指标徽章：速度/清晰度/广告 三标签只显档位（极速/快速/慢速 · 4K/2K/高清/标清 ·
// 无广/疑广/有广），点击弹出实测明细（吞吐/分辨率/编码/广告证据），档位规则见弹层尾行；
// live 模式只出速度/清晰度（直播无广告/时长维度，LiveView 用），compact 为下拉按钮/
// 列表行内的小号变体；其余徽章（播不了/起播慢/时长异常/花絮）保持悬停 title 说明。
// 注意：徽章常嵌在换线 chip、频道行等 <button> 内——交互元素必须用 span+stopPropagation
// （button 嵌 button 是非法 HTML，且 IAB 的事件派发会把点击路由给外层按钮）。
import React, { useEffect, useRef, useState } from 'react';
import { Gauge, MonitorPlay, ShieldCheck, ShieldAlert, ShieldX, Clock, AlertTriangle, Clapperboard } from 'lucide-react';
import type { ScanMetrics } from '../types';
import { fmtSpeed, fmtRes, fmtOpen, speedTier, resTier, isUnsupportedCodec, isMobileDevice, isUnderTenMinutes } from '../utils/scanFormat';

type BadgeMetrics = Partial<ScanMetrics>;

const AD_META: Record<string, { label: string; icon: typeof ShieldCheck; tip: string; cls: string }> = {
  clean: { label: '无广', icon: ShieldCheck, tip: '广告探测：未发现片头/中段广告与水印角标', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  suspect: { label: '疑广', icon: ShieldAlert, tip: '广告探测：存在可疑信号（单一证据，未确认）', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  dirty: { label: '有广', icon: ShieldX, tip: '广告探测：确认存在贴片或中段广告', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
};

export const MetricBadges: React.FC<{
  metrics: BadgeMetrics;
  live?: boolean;      // 直播模式：只渲染速度+清晰度
  compact?: boolean;   // 行内小号（下拉按钮/列表行）
  className?: string;
}> = ({ metrics, live = false, compact = false, className = '' }) => {
  const [open, setOpen] = useState<string | null>(null);
  const rootRef = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);

  const pill = compact
    ? 'flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-bold leading-none whitespace-nowrap'
    : 'flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-bold leading-none whitespace-nowrap';
  const ic = compact ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0';
  const ad = AD_META[metrics.adLevel || ''] || AD_META.clean;
  const AdIcon = ad.icon;
  const durMin = Math.round((metrics.durationS || 0) / 60);
  const deltaMin = Math.round((metrics.durationDeltaS || 0) / 60);
  const evidences = (metrics.adSignals || []).join('；');

  /** 档位徽章 + 点击弹层明细。lines 里的 undefined 行自动省略。 */
  const tierBadge = (key: string, cls: string, icon: React.ReactNode, label: string, lines: (string | undefined)[]) => (
    <span className="relative inline-flex">
      <span
        role="button"
        tabIndex={0}
        className={`${pill} ${cls} cursor-pointer select-none hover:brightness-125`}
        onClick={(e) => { e.stopPropagation(); e.preventDefault(); setOpen(open === key ? null : key); }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); e.preventDefault(); setOpen(open === key ? null : key); }
        }}
      >
        {icon}
        {label}
      </span>
      {open === key && (
        <span className="absolute left-0 top-full z-50 mt-1.5 w-max max-w-[280px] rounded-lg border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-left shadow-2xl">
          {lines.filter((l): l is string => !!l).map((line, idx) => (
            <span key={idx} className="block text-[11px] leading-relaxed text-zinc-300 first:mt-0 mt-0.5">{line}</span>
          ))}
        </span>
      )}
    </span>
  );

  const spd = speedTier(metrics.throughputMbps);
  const res = resTier(metrics.height);
  return (
    <span ref={rootRef} className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      {tierBadge('speed', spd.cls, <Gauge className={ic} />, spd.label, [
        `实测速度：${fmtSpeed(metrics.throughputMbps || 0)} Mbps（首分片吞吐）`,
        typeof metrics.firstFrameS === 'number' ? `首帧估计：${metrics.firstFrameS}s` : undefined,
        typeof metrics.openMs === 'number' && typeof metrics.ttfbS === 'number'
          ? `解析 ${fmtOpen(metrics.openMs)} · 首字节 ${metrics.ttfbS}s` : undefined,
        spd.hint,
      ])}
      {tierBadge('res', res.cls, <MonitorPlay className={ic} />, res.label, [
        `实测分辨率：${metrics.width && metrics.height ? `${metrics.width}×${metrics.height}` : fmtRes(metrics.height)}`,
        metrics.codec ? `编码：${metrics.codec}${metrics.acodec ? ` + ${metrics.acodec}` : ''}` : undefined,
        metrics.bitrateKbps ? `码率：约 ${metrics.bitrateKbps} kbps` : undefined,
        res.hint,
      ])}
      {isUnsupportedCodec(metrics.codec) && (
        <span
          className={`${pill} bg-amber-500/15 text-amber-300 border-amber-500/40`}
          title={`${metrics.codec} 视频：当前浏览器不支持解码，选择后可能一直显示加载中（EAC3 音频已由服务端转码兜底，不影响）`}
        >
          <AlertTriangle className={ic} />
          播不了
        </span>
      )}
      {metrics.moovEnd && isMobileDevice() && (
        <span
          className={`${pill} bg-amber-500/15 text-amber-300 border-amber-500/40`}
          title="整文件式 MP4 且索引在文件尾：手机浏览器起播很慢（需顺序下载整个文件），建议换其他线路"
        >
          <AlertTriangle className={ic} />
          起播慢
        </span>
      )}
      {!live && (
        <>
          {tierBadge('ad', ad.cls, <AdIcon className={ic} />, ad.label, [
            ad.tip,
            evidences ? `证据：${evidences}` : undefined,
          ])}
          {metrics.trailer && (
            <span
              className={`${pill} bg-violet-500/15 text-violet-300 border-violet-500/40`}
              title={`内容识别：整线选集多为「${metrics.trailer}」类内容，非正片；如需观看可手动选择此线路`}
            >
              <Clapperboard className={ic} />
              {metrics.trailer}
            </span>
          )}
          {(isUnderTenMinutes(metrics.durationS) || metrics.durationMatch === 'short') && (
            <span
              className={`${pill} bg-rose-500/15 text-rose-300 border-rose-500/40`}
              title={isUnderTenMinutes(metrics.durationS) ? '时长异常：该线路不足十分钟' : `时长异常：该片源仅 ${durMin} 分钟，远短于片库片长，疑似预告片或假资源`}
            >
              <Clock className={ic} />
              {isUnderTenMinutes(metrics.durationS) ? '不足10分钟' : `仅${durMin}分钟`}
            </span>
          )}
          {!isUnderTenMinutes(metrics.durationS) && metrics.durationMatch === 'long' && (
            <span
              className={`${pill} bg-amber-500/15 text-amber-300 border-amber-500/40`}
              title={`时长异常：比片库片长约多 ${deltaMin} 分钟，疑似拼接了广告内容`}
            >
              <Clock className={ic} />
              多{deltaMin}分钟
            </span>
          )}
        </>
      )}
    </span>
  );
};
