// 线路指标徽章：速度 / 清晰度 / 广告 / 时长异常 药丸（带图标与说明），
// WatchView 当前线路与推荐线路共用；live 模式只出速度/清晰度（直播无广告/时长维度，LiveView 用），
// compact 为下拉按钮/列表行内的小号变体；title 提供指标含义与探测证据说明
import React from 'react';
import { Gauge, MonitorPlay, ShieldCheck, ShieldAlert, ShieldX, Clock } from 'lucide-react';
import type { ScanMetrics } from '../types';
import { fmtSpeed, fmtRes } from '../utils/scanFormat';

type BadgeMetrics = Partial<ScanMetrics>;

const AD_META: Record<string, { label: string; icon: typeof ShieldCheck; tip: string; cls: string }> = {
  clean: { label: '无广告', icon: ShieldCheck, tip: '广告探测：未发现片头/中段广告与水印角标', cls: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40' },
  suspect: { label: '疑有广告', icon: ShieldAlert, tip: '广告探测：存在可疑信号', cls: 'bg-amber-500/15 text-amber-300 border-amber-500/40' },
  dirty: { label: '有广告', icon: ShieldX, tip: '广告探测：确认存在广告', cls: 'bg-rose-500/15 text-rose-300 border-rose-500/40' },
};

export const MetricBadges: React.FC<{
  metrics: BadgeMetrics;
  live?: boolean;      // 直播模式：只渲染速度+清晰度
  compact?: boolean;   // 行内小号（下拉按钮/列表行）
  className?: string;
}> = ({ metrics, live = false, compact = false, className = '' }) => {
  const pill = compact
    ? 'flex items-center gap-0.5 px-1.5 py-0.5 rounded-md border text-[10px] font-bold leading-none whitespace-nowrap'
    : 'flex items-center gap-1 px-2 py-1 rounded-lg border text-[11px] font-bold leading-none whitespace-nowrap';
  const ic = compact ? 'w-3 h-3 shrink-0' : 'w-3.5 h-3.5 shrink-0';
  const ad = AD_META[metrics.adLevel || ''] || AD_META.clean;
  const AdIcon = ad.icon;
  const durMin = Math.round((metrics.durationS || 0) / 60);
  const deltaMin = Math.round((metrics.durationDeltaS || 0) / 60);
  const evidences = (metrics.adSignals || []).join('；');
  return (
    <span className={`flex flex-wrap items-center gap-1.5 ${className}`}>
      <span className={`${pill} bg-emerald-500/15 text-emerald-300 border-emerald-500/40`} title={`加载速度：${fmtSpeed(metrics.throughputMbps || 0)}bps（首分片实测吞吐）`}>
        <Gauge className={ic} />
        速度 {fmtSpeed(metrics.throughputMbps || 0)}
      </span>
      <span className={`${pill} bg-sky-500/15 text-sky-300 border-sky-500/40`} title={`清晰度：${fmtRes(metrics.height || 0)}${metrics.codec ? ` · ${metrics.codec}` : ''}`}>
        <MonitorPlay className={ic} />
        {fmtRes(metrics.height || 0)}
      </span>
      {!live && (
        <>
          <span className={`${pill} ${ad.cls}`} title={evidences ? `广告探测：${evidences}` : ad.tip}>
            <AdIcon className={ic} />
            {ad.label}
          </span>
          {metrics.durationMatch === 'short' && (
            <span
              className={`${pill} bg-rose-500/15 text-rose-300 border-rose-500/40`}
              title={`时长异常：该片源仅 ${durMin} 分钟，远短于片库片长，疑似预告片或假资源`}
            >
              <Clock className={ic} />
              仅{durMin}分钟
            </span>
          )}
          {metrics.durationMatch === 'long' && (
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
