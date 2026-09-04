// 站点分组分类（按智能选源探测结果），播放页选源弹窗使用
import { ResourceMatch, ScanCandidateResult } from '../types';
import { compareRecommended } from './scanFormat';

// 分组定义（顺序即展示顺序）
export const SITE_GROUP_DEFS = [
  { key: 'recommended', label: '推荐', hint: '探测可用，质量最优在前', cls: 'text-emerald-300' },
  { key: 'ads', label: '有广告', hint: '可用线路均含前置广告', cls: 'text-amber-300' },
  { key: 'duration', label: '时长异常', hint: '片长与主流版本差异大，疑似预告或内容不符', cls: 'text-orange-300' },
  { key: 'netdisk', label: '网盘', hint: '需扫码登录网盘后播放', cls: 'text-sky-300' },
  { key: 'failed', label: '探测失败', hint: '线路解析失败或源站不可用', cls: 'text-rose-300/80' },
  { key: 'unprobed', label: '未探测', hint: '', cls: 'text-zinc-400' },
] as const;

// 网盘特征：失败原因 / 线路名 / 站点名
const NETDISK_ERR = /扫码|登录|网盘/;
const NETDISK_NAME = /盘|夸父|夸克|阿里云|迅雷|天翼/;

export interface SiteEntry {
  match: ResourceMatch;
  best?: ScanCandidateResult;      // 最优可用线路
  lines: ScanCandidateResult[];    // 有线路名的探测结果（成功+失败）
  detailFail?: string;             // 详情获取失败（站点级，flag 为空）
  okAds: string[];
}

export function classifySites(
  results: ScanCandidateResult[],
  matches: ResourceMatch[],
  isFeature: boolean
): { groups: Record<string, SiteEntry[]>; medianDur: number } {
  const info = new Map<string, SiteEntry>();
  for (const r of results || []) {
    if (!r.siteKey) continue;
    const e = info.get(r.siteKey) || { match: matches.find((m) => m.siteKey === r.siteKey)!, lines: [], okAds: [] };
    if (!e.match) continue;
    if (r.status === 'ok' && r.flag && r.metrics) {
      e.okAds.push(r.metrics.adLevel);
      if (!e.best || r.metrics.scores.total > (e.best.metrics?.scores.total ?? 0)) e.best = r;
      e.lines.push(r);
    } else if (r.flag) {
      e.lines.push(r);
    } else {
      e.detailFail = r.error || '详情获取失败';
    }
    info.set(r.siteKey, e);
  }
  for (const m of matches) {
    if (!info.has(m.siteKey)) info.set(m.siteKey, { match: m, lines: [], okAds: [] });
  }

  // 时长中位数（≥3 个站点才可信）：最优线路片长偏离 0.45~2.2 倍判为时长异常；
  // 电影/纪录片另设绝对下限（正片 <40 分钟基本是预告或片段），中位数不足时兜底
  const durs = [...info.values()]
    .map((e) => e.best?.metrics?.durationS)
    .filter((d): d is number => !!d && d > 0)
    .sort((a, b) => a - b);
  const medianDur = durs.length >= 3 ? durs[Math.floor(durs.length / 2)] : 0;
  const durationSuspect = (d: number): boolean => {
    if (d <= 0) return false;
    if (isFeature && d < 2400) return true;
    return medianDur > 0 && (d < medianDur * 0.45 || d > medianDur * 2.2);
  };

  const groups: Record<string, SiteEntry[]> = {};
  for (const g of SITE_GROUP_DEFS) groups[g.key] = [];
  for (const e of info.values()) {
    let group: string;
    if (!e.best) {
      const probed = e.lines.length > 0 || !!e.detailFail;
      const netdisk = e.lines.some((f) => NETDISK_ERR.test(f.error || '') || NETDISK_NAME.test(f.flag || ''))
        || NETDISK_NAME.test(e.match.siteName);
      group = !probed ? 'unprobed' : netdisk ? 'netdisk' : 'failed';
    } else if (durationSuspect(e.best.metrics?.durationS || 0)) {
      group = 'duration';
    } else if (e.okAds.length > 0 && e.okAds.every((a) => a === 'dirty')) {
      group = 'ads';
    } else {
      group = 'recommended';
    }
    groups[group].push(e);
  }
  for (const key of Object.keys(groups)) {
    // 推荐组：清晰度优先（慢线靠后，同清晰度按综合分）——与播放页推荐线路条同规则
    if (key === 'recommended') {
      groups[key].sort((a, b) => compareRecommended(a.best!, b.best!));
    } else {
      groups[key].sort((a, b) => (b.best?.metrics?.scores.total ?? -1) - (a.best?.metrics?.scores.total ?? -1));
    }
  }
  return { groups, medianDur };
}
