import { ScanCandidateResult, scanResultKey } from '../types';
import { compareRecommended, isMobileDevice, isUnsupportedCodec, isUnderTenMinutes, SLOW_LINE_MBPS } from './scanFormat';
import { hasReferenceDuration } from './referenceDuration';

export const INITIAL_SELECTION_WAIT_MS = 12_000;

function confirmedCompatibleCodec(codec?: string): boolean {
  if (!codec) return false;
  if (/^(h264|avc1|avc)(\.|$)/i.test(codec)) return true;
  if (/^(hevc|h265|hev1|hvc1)(\.|$)/i.test(codec)) return !isUnsupportedCodec('hevc');
  const mime = /^(av1|av01)(\.|$)/i.test(codec) ? 'video/mp4; codecs="av01.0.08M.08"'
    : /^(vp9|vp09)(\.|$)/i.test(codec) ? 'video/webm; codecs="vp9"' : '';
  return !!mime && typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mime);
}

function compareSelection(a: ScanCandidateResult, b: ScanCandidateResult, refDurationS?: number): number {
  if (hasReferenceDuration(refDurationS)) return compareRecommended(a, b);
  // 没有基准时，排序也不使用片长比对标记；保留原始探测数据用于展示。
  return compareRecommended(
    { metrics: a.metrics && { ...a.metrics, durationMatch: undefined } },
    { metrics: b.metrics && { ...b.metrics, durationMatch: undefined } },
  );
}

/** 不足十分钟属于绝对异常；只有全部可用线路都明确不足十分钟时才放开兜底。 */
function recommendationPool(results: ScanCandidateResult[]): ScanCandidateResult[] {
  const unique = new Map<string, ScanCandidateResult>();
  for (const result of results) unique.set(scanResultKey(result), result);
  const available = [...unique.values()].filter((r) => r.status === 'ok' && r.flag && r.metrics);
  return available.every((r) => isUnderTenMinutes(r.metrics?.durationS)) ? available
    : available.filter((r) => !isUnderTenMinutes(r.metrics?.durationS));
}

function meetsPlaybackRequirements(r: ScanCandidateResult, refDurationS?: number, allowSlow = false): boolean {
    const m = r.metrics;
    if (r.status !== 'ok' || !r.flag || !m) return false;
    if (isUnderTenMinutes(m.durationS)) return false;
    if (hasReferenceDuration(refDurationS) && m.durationMatch !== 'ok') return false;
    if (!confirmedCompatibleCodec(m.codec) || (isMobileDevice() && m.moovEnd)) return false;
    const requiredMbps = Math.max(SLOW_LINE_MBPS, (m.bitrateKbps || 0) / 1000 * 1.5);
    return Number.isFinite(m.throughputMbps) && (allowSlow ? m.throughputMbps > 0 : m.throughputMbps >= requiredMbps);
}

/** 自动升级仍须通过速度门槛；慢速高画质仅保留展示位置供用户手选。 */
export function qualifiedRecommendations(results: ScanCandidateResult[], refDurationS?: number): ScanCandidateResult[] {
  return recommendationPool(results).filter((r) => meetsPlaybackRequirements(r, refDurationS))
    .sort((a, b) => compareSelection(a, b, refDurationS));
}

/** 展示推荐先列出已满足升级条件的线路，再用其它探测成功的线路补足。
 *  缺少片库基准片长/编码信息并不代表不可播放，不能因此把整个推荐区域隐藏。
 *  保持已确认推荐在前，也让自动选线、升级提示与推荐卡片中的第一条一致。
 */
export function displayRecommendations(results: ScanCandidateResult[], refDurationS?: number): ScanCandidateResult[] {
  const available = recommendationPool(results)
    .sort((a, b) => compareSelection(a, b, refDurationS));
  const qualified = qualifiedRecommendations(available, refDurationS);
  const qualifiedKeys = new Set(qualified.map(scanResultKey));
  const ranked = [...qualified, ...available.filter((r) => !qualifiedKeys.has(scanResultKey(r)))];
  if (ranked.length > 3) {
    const maxHeight = Math.max(...ranked.slice(0, 3).map((r) => r.metrics?.height || 0));
    const sharper = ranked.slice(3).filter((r) => (r.metrics?.height || 0) > maxHeight
      && meetsPlaybackRequirements(r, refDurationS, true) && !meetsPlaybackRequirements(r, refDurationS))
      .sort((a, b) => (b.metrics?.height || 0) - (a.metrics?.height || 0) || compareSelection(a, b, refDurationS))[0];
    if (sharper) {
      ranked.splice(ranked.indexOf(sharper), 1);
      ranked.splice(2, 0, sharper);
    }
  }
  return ranked;
}

/** 不为同清晰度的微小分数变动换线；明确异常/不可播/过慢时允许同清晰度修复。 */
export function isMeaningfulUpgrade(target: ScanCandidateResult, current?: ScanCandidateResult, stalled = false, refDurationS?: number): boolean {
  if (!target.metrics || (current && scanResultKey(target) === scanResultKey(current))) return false;
  if (stalled || current?.status === 'fail') return true;
  if (!current?.metrics || current.status !== 'ok') return false;
  const old = current.metrics;
  const durationBad = isUnderTenMinutes(old.durationS)
    || (hasReferenceDuration(refDurationS) && (old.durationMatch === 'short' || old.durationMatch === 'long'));
  if (durationBad || isUnsupportedCodec(old.codec)
      || (isMobileDevice() && old.moovEnd) || old.throughputMbps < SLOW_LINE_MBPS) return true;
  // 当前分辨率未知时不宣称升级；先等待当前线路的实测信息。
  return !!old.height && (target.metrics.height || 0) > old.height;
}

export function initialCandidate(results: ScanCandidateResult[], elapsedMs: number, refDurationS?: number): ScanCandidateResult | undefined {
  if (elapsedMs < INITIAL_SELECTION_WAIT_MS) return undefined;
  return displayRecommendations(results, refDurationS)[0];
}
