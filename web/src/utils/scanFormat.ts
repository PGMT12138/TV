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

// hls.js ≥1.6 支持 HEVC-in-MPEGTS，能否真播取决于浏览器 MSE 能力（hvc1/hev1）。
// 音频 EAC3/AC3 不参与判定：/stream 分片代理已做服务端兜底转码（EAC3/AC3→AAC，
// bridge.py 探测分片头部自动挂 ffmpeg），任何浏览器都能收到 AAC 音轨。
// 运行时动态检测（不缓存），浏览器环境变化或测试注入都能即时反映
export const hevcMseSupported = () =>
  typeof MediaSource !== 'undefined' &&
  (MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L153.B0"') ||
    MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L153.B0"'));

/** 探测视频 codec 在当前浏览器下播不了（如无 HEVC 硬解的 Firefox/老设备；第二参数已废弃保留兼容） */
export const isUnsupportedCodec = (codec?: string, _acodec?: string) =>
  !!codec && /hevc|hev1|hvc1/i.test(codec) && !hevcMseSupported();

/** 移动设备判定（运行时求值，方便测试注入）：moov-at-end 大 MP4 的起播问题只存在于
 * 手机内置浏览器（顺序下载、不做尾部 Range 跳读），桌面引擎能 suffix Range 秒起播，
 * 因此「起播慢」的降权与徽章只在移动端生效 */
import { isMobileDevice } from './orientation';
export { isMobileDevice };

export interface RankableMetrics {
  throughputMbps: number;
  height?: number;
  codec?: string;
  acodec?: string;
  moovEnd?: boolean;   // MP4 索引在文件尾（非 faststart）：仅移动端浏览器起播极慢
  durationMatch?: 'short' | 'ok' | 'long';  // short=疑似预告片/假资源：再高清也要沉底
  scores: { total: number };
}

/** 推荐线路比较器：不可播编码/慢线/预告片线靠后（移动端另把 moov 在尾的大 MP4 沉底）→ 清晰度降序 → 同清晰度按综合评分（缺 metrics 排最后）。
 *  时长短的线路后端已做 ×0.4 重罚，但清晰度优先排序下 4K 宣传片仍会压过 1080P 正片——
 *  必须显式沉底（玩具总动员5 推荐前二全是十几秒宣传片实例） */
export function compareRecommended<T extends { metrics?: RankableMetrics }>(a: T, b: T): number {
  const m = a.metrics, n = b.metrics;
  if (!m || !n) return m ? -1 : n ? 1 : 0;
  const mobile = isMobileDevice();
  const aBad = isUnsupportedCodec(m.codec) || (mobile && m.moovEnd) || (m.throughputMbps ?? 0) < SLOW_LINE_MBPS || m.durationMatch === 'short';
  const bBad = isUnsupportedCodec(n.codec) || (mobile && n.moovEnd) || (n.throughputMbps ?? 0) < SLOW_LINE_MBPS || n.durationMatch === 'short';
  if (aBad !== bBad) return aBad ? 1 : -1;
  const dh = (n.height ?? 0) - (m.height ?? 0);
  if (dh !== 0) return dh;
  return n.scores.total - m.scores.total;
}
