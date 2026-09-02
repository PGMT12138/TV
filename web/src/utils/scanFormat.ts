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
