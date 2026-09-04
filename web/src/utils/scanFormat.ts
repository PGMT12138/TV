// 智能选源徽章文案/样式（WatchView 线路徽章与 DetailView 站点徽章共用）
export const fmtSpeed = (mbps: number) => `${mbps >= 10 ? mbps.toFixed(0) : mbps.toFixed(1)}M`;

export const fmtRes = (h?: number) => (!h ? '未知' : h >= 2160 ? '4K' : `${h}P`);

export const AD_LABEL: Record<string, string> = { clean: '无广告', suspect: '疑广告', dirty: '有广告' };

export const AD_CLASS: Record<string, string> = {
  clean: 'text-emerald-400/90',
  suspect: 'text-amber-300/90',
  dirty: 'text-rose-400/90',
};

export const fmtOpen = (openMs: number) => (openMs >= 1000 ? `${(openMs / 1000).toFixed(1)}s` : `${Math.round(openMs)}ms`);

// ---------------- 推荐线路排序：清晰度优先，加载很慢的线路靠后 ----------------
// 阈值与后端 probe.GOOD_MIN_MBPS 对齐（首分片吞吐低于此值视为"很慢"，高清晰度也不值得排前）
export const SLOW_LINE_MBPS = 3;

export interface RankableMetrics {
  throughputMbps: number;
  height?: number;
  scores: { total: number };
}

/** 推荐线路比较器：慢线靠后 → 清晰度降序 → 同清晰度按综合评分（入参为探测结果行，缺 metrics 排最后） */
export function compareRecommended<T extends { metrics?: RankableMetrics }>(a: T, b: T): number {
  const m = a.metrics, n = b.metrics;
  if (!m || !n) return m ? -1 : n ? 1 : 0;
  const aSlow = (m.throughputMbps ?? 0) < SLOW_LINE_MBPS;
  const bSlow = (n.throughputMbps ?? 0) < SLOW_LINE_MBPS;
  if (aSlow !== bSlow) return aSlow ? 1 : -1;
  const dh = (n.height ?? 0) - (m.height ?? 0);
  if (dh !== 0) return dh;
  return n.scores.total - m.scores.total;
}
