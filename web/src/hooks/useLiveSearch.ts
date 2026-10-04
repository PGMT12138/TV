import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { MovieItem, ResourceMatch } from '../types';
import { useApp } from '../context/AppContext';

// 一次双端搜索的进度：idle 未搜过 / searching 豆瓣请求在途 / done 豆瓣已结束
// app 端（设备站点聚合）走 SSE 渐进回传，结束时只置 appSearching=false，无结果不做任何提示。
export type LiveSearchPhase = 'idle' | 'searching' | 'done';

// app 端命中累积上限，与播放页选源列表同口径
const APP_MATCH_CAP = 60;

/**
 * 双端手动搜索：仅在调用 search()（搜索按钮/回车/热词）时发起
 * - 豆瓣 catalogSearch：命中合入片库（mergeMovies），由调用方本地过滤展示；失败视作无结果
 * - app 端 resourceSearchStream（SSE 逐站渐进，先查缓存后实时聚合）：仅在豆瓣无结果时由调用方兜底展示
 * 输入过程不发起任何远程请求，只做本地过滤；当前词与最近一次已搜索词不同时 stale 为真，组件据此隐藏过期结果。
 */
export function useLiveSearch(query: string) {
  const { mergeMovies } = useApp();
  const [phase, setPhase] = useState<LiveSearchPhase>('idle');
  const [searchedWd, setSearchedWd] = useState('');
  const [appMatches, setAppMatches] = useState<ResourceMatch[]>([]);
  const [appSearching, setAppSearching] = useState(false);
  const seqRef = useRef(0);
  const esRef = useRef<EventSource | null>(null);

  // 当前结果所属的搜索词与输入框不一致：结果已过期，不应展示
  const stale = query.trim() !== searchedWd;

  // 发起一轮双端搜索（同时作废在途轮次）
  const search = useCallback((wdRaw: string) => {
    const wd = wdRaw.trim();
    if (!wd) return;
    const seq = ++seqRef.current;
    esRef.current?.close();
    esRef.current = null;
    setSearchedWd(wd);
    setPhase('searching');
    setAppMatches([]);
    setAppSearching(true);
    api.catalogSearch(wd)
      .then(({ list }) => {
        if (seq === seqRef.current && list.length) mergeMovies(list);
      })
      .catch(() => { /* 豆瓣不可达：视作无结果，由 app 端兜底 */ })
      .finally(() => {
        if (seq === seqRef.current) setPhase('done');
      });
    const seen = new Set<string>();
    const acc: ResourceMatch[] = [];
    esRef.current = api.resourceSearchStream(wd, (ev) => {
      if (seq !== seqRef.current) return;
      if (ev.type === 'site' && ev.matched?.length) {
        for (const m of ev.matched) {
          const uid = `${m.siteKey}:${m.vodId}`;
          if (seen.has(uid)) continue;
          seen.add(uid);
          acc.push(m);
        }
        acc.sort((a, b) => b.score - a.score);
        setAppMatches(acc.slice(0, APP_MATCH_CAP));
      } else if (ev.type === 'done' || ev.type === 'error') {
        // 设备离线/连接中断等静默收场，不向上层透出任何「app 无结果」信号
        setAppSearching(false);
      }
    });
  }, [mergeMovies]);

  // 清空输入时作废在途轮次并复位状态
  useEffect(() => {
    if (!query.trim()) {
      ++seqRef.current;
      esRef.current?.close();
      esRef.current = null;
      setPhase('idle');
      setSearchedWd('');
      setAppMatches([]);
      setAppSearching(false);
    }
  }, [query]);

  useEffect(() => () => { esRef.current?.close(); }, []);

  return { phase, appMatches, appSearching, stale, search };
}

/** 点击 app 端结果：注册为资源影片（带 raw 站点信息）并返回；调用方 mergeMovies 后跳播放页即可精确锁定该来源播放。 */
export async function adoptResourceMatch(match: ResourceMatch): Promise<MovieItem | null> {
  try {
    const res = await api.resourceAdopt(match.siteKey, match.vodId);
    return res.movie?.id ? res.movie : null;
  } catch {
    return null;
  }
}
