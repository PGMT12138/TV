// 直播页：设备桥拉频道表（分组/频道/线路），播放直连优先、失败回退服务端代理再自动换线路。
// HLS 走 hls.js，FLV 走 mpegts.js；rtmp/rtsp 等浏览器不可播协议提示去 App 端看。
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  Tv, Star, RefreshCw, Volume2, VolumeX, Maximize, Play, Pause,
  ChevronDown, Signal, Radio, ListVideo, Activity, History, Trash2,
} from 'lucide-react';
import { api, imgUrl } from '../api';
import { useApp } from '../context/AppContext';
import { MetricBadges } from '../components/MetricBadges';
import type { LiveListData, LiveChannel, LivePlayData, LiveEpgData, LiveFavoriteItem, LiveHistoryItem, LiveProbeResult } from '../types';

type MpegtsPlayer = ReturnType<typeof mpegts.createPlayer>;

interface PlayingRef {
  live: string;
  group: string;
  channel: string;
}

const isFlvUrl = (s: string) => /\.flv(\?|$)/i.test(s);

export const LiveView: React.FC = () => {
  const { showToast } = useApp();

  // 频道表
  const [data, setData] = useState<LiveListData | null>(null);
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(true);
  const [activeLive, setActiveLive] = useState('');
  const [activeGroup, setActiveGroup] = useState('');
  const [menuOpen, setMenuOpen] = useState<'' | 'live' | 'group' | 'fav' | 'hist' | 'channel' | 'line'>(''); // 源/分组/收藏/历史在播放器上方，频道/线路在信息栏，同时只开一个

  // 播放状态（同步值放 ref，避免引擎回调闭包读到过期 state）
  const currentRef = useRef<PlayingRef | null>(null);
  const currentChannelRef = useRef<LiveChannel | null>(null);
  const lineRef = useRef(0);
  const [current, setCurrent] = useState<PlayingRef | null>(null);
  const [currentChannel, setCurrentChannel] = useState<LiveChannel | null>(null);
  const [line, setLine] = useState(0);
  const [playData, setPlayData] = useState<LivePlayData | null>(null);
  const [playError, setPlayError] = useState('');
  const [videoLoading, setVideoLoading] = useState(false);
  const [isPlaying, setIsPlaying] = useState(false);
  const [muted, setMuted] = useState(true); // 静音起播满足自动播放策略，用户手动开声
  const [viaProxy, setViaProxy] = useState(false);

  // EPG 与收藏
  const [epg, setEpg] = useState<LiveEpgData | null>(null);
  const [epgEmpty, setEpgEmpty] = useState(false); // 已请求但当日无节目单（区别于加载中）
  const [epgOpen, setEpgOpen] = useState(false);
  const [favs, setFavs] = useState<LiveFavoriteItem[]>([]);
  const [delFav, setDelFav] = useState<LiveFavoriteItem | null>(null); // 待二次确认删除的收藏
  // 直播观看历史（服务端每用户最多 10 条，播放成功即 upsert）
  const [liveHist, setLiveHist] = useState<LiveHistoryItem[]>([]);
  // 收藏涉及其它源的频道表（有效性判定用；null=该源已不可解析/被移除，undefined=尚未取回）
  const [favTables, setFavTables] = useState<Record<string, LiveListData | null>>({});
  const favTableFetchedRef = useRef<Set<string>>(new Set());

  // 线路探测（探测缓存 + 后台扫描进度）
  const [probes, setProbes] = useState<Record<string, LiveProbeResult>>({});
  const [scan, setScan] = useState<{ status: 'running' | 'cancelling'; total: number; finished: number; group?: string } | null>(null);
  const scanEsRef = useRef<EventSource | null>(null);
  const scanSeenRef = useRef<Set<string>>(new Set()); // SSE 重连重放时按 key 幂等，防进度重复计数
  const scanIdRef = useRef('');

  // 各直播源分组/频道数（进页后台探测，后端 live_tables 落库缓存后秒回）
  const [liveMeta, setLiveMeta] = useState<Record<string, { groups: number; channels: number }>>({});
  const sourceNameRef = useRef(''); // 异步回调比对当前源用：切源后旧回调不得污染新源状态/留僵尸扫描
  const loadSeqRef = useRef(0);     // loadList 请求序号：快速切源时丢弃过期响应，后到者不覆盖

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<MpegtsPlayer | null>(null);
  const playTokenRef = useRef(0);
  const triedLinesRef = useRef<Set<number>>(new Set());
  const autoRecoverAtRef = useRef(0); // 直播流异常自愈（自动重新拉流）上次触发时间，30s 冷却防死循环

  const destroyEngines = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    if (mpegtsRef.current) {
      try { mpegtsRef.current.destroy(); } catch { /* 已销毁 */ }
      mpegtsRef.current = null;
    }
    const video = videoRef.current;
    if (video) {
      video.onerror = null;
      video.onplaying = null;
      video.onpause = null;
      video.onended = null;
      video.removeAttribute('src');
      video.load();
    }
  }, []);

  useEffect(() => () => destroyEngines(), [destroyEngines]);

  // 外点收起：任一下拉打开时，点击所有下拉组件（触发按钮/面板）以外的区域自动收起。
  // 组件内部点击不在此处理，交给按钮/面板行自身 onClick（否则与开关按钮的切换冲突会闪开闪关）；
  // pointerdown 先于 click 触发，外点先收起、再命中的 onClick 照常开新面板，顺序天然正确
  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest?.('[data-live-dropdown]')) return;
      setMenuOpen('');
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [menuOpen]);

  // 停止播放：token 跳变作废在途 livePlay 回调与引擎失败分支，销毁引擎并清空播放态。切源/离页用
  const stopPlayback = useCallback(() => {
    playTokenRef.current++;
    destroyEngines();
    currentRef.current = null;
    currentChannelRef.current = null;
    lineRef.current = 0;
    setCurrent(null);
    setCurrentChannel(null);
    setLine(0);
    setPlayData(null);
    setPlayError('');
    setVideoLoading(false);
    setIsPlaying(false);
    setViaProxy(false);
    setEpg(null);
    setEpgEmpty(false);
    setEpgOpen(false);
  }, [destroyEngines]);

  // ---- 播放核心：直连 → 失败回退服务端代理 → 仍失败自动换线路 ----
  const attachStream = useCallback((pd: LivePlayData, useProxy: boolean) => {
    const video = videoRef.current;
    if (!video) return;
    const token = playTokenRef.current;
    const src = useProxy ? pd.proxy : pd.play;

    // 直连失败（CORS/混合内容等）：回退服务端代理重试一次；代理也失败则自动换线路
    const fail = (msg: string) => {
      if (playTokenRef.current !== token) return;
      destroyEngines();
      if (!useProxy && pd.direct) {
        setViaProxy(true);
        attachStream(pd, true);
        return;
      }
      const channel = currentChannelRef.current;
      const used = lineRef.current;
      const total = channel?.lines || 1;
      const next = total > 1 ? (used + 1) % total : -1;
      if (next !== -1 && !triedLinesRef.current.has(next)) {
        const ref = currentRef.current!;
        showToast(`当前线路不可用，自动切换到线路 ${next + 1}`, 'info');
        playChannelImpl(ref, channel!, next, true);
      } else {
        setVideoLoading(false);
        setPlayError(total > 1 ? `${msg}，所有线路均不可用` : msg);
      }
    };

    // 直播流异常自愈：CDN 偶发 200 空播放列表时 hls.js 会把直播判成"已结束"而静默停载
    // （不报致命错误，画面冻住），或视频意外 ended——重新拉流恢复；30s 冷却，冷却期内
    // 再次异常则转手动重试提示，避免对真死的源无限循环拉流
    const autoRecover = (reason: string) => {
      if (playTokenRef.current !== token) return;
      const ref = currentRef.current;
      const ch = currentChannelRef.current;
      if (!ref || !ch) return;
      if (Date.now() - autoRecoverAtRef.current < 30000) {
        setVideoLoading(false);
        setPlayError('直播流反复中断，请点击重试');
        return;
      }
      autoRecoverAtRef.current = Date.now();
      showToast(`${reason}，自动重新拉流`, 'info');
      playChannelImpl(ref, ch, lineRef.current, false);
    };

    setVideoLoading(true);
    setPlayError('');
    if (isFlvUrl(src)) {
      if (!mpegts.getFeatureList().mseLivePlayback) return fail('当前浏览器不支持 FLV 直播');
      try {
        const player = mpegts.createPlayer(
          { type: 'flv', isLive: true, url: src },
          { enableStashBuffer: false, stashInitialSize: 384, lazyLoad: false },
        );
        player.attachMediaElement(video);
        player.on(mpegts.Events.ERROR, () => fail('FLV 流加载失败'));
        player.load();
        mpegtsRef.current = player;
      } catch {
        return fail('FLV 播放器创建失败');
      }
    } else if (Hls.isSupported()) {
      // 直播源绝大多数是 HLS，且常见 php 入口 302 到 CDN m3u8（URL 无 .m3u8 后缀），
      // 统一交给 hls.js 解析（XHR 跟随重定向、按内容识别清单），不依赖后端 hls 标记
      const hls = new Hls({ maxBufferLength: 30, maxMaxBufferLength: 60, backBufferLength: 90 });
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.fatal) fail('直播流加载失败');
      });
      // 直播列表中途变"非直播"（CDN 空列表被 hls.js 当成流已结束）→ 自愈重拉；
      // 首个列表就是非直播的伪直播点源属正常播放，不触发
      let wasLive = false;
      hls.on(Hls.Events.LEVEL_LOADED, (_e, d: any) => {
        if (playTokenRef.current !== token) return;
        if (d.details.live) wasLive = true;
        else if (wasLive) autoRecover('直播流异常结束');
      });
      hlsRef.current = hls;
    } else {
      // 无 MSE 时回退原生 video（Safari 原生支持 HLS）
      video.onerror = () => fail('直播流加载失败');
      video.src = src;
    }
    video.play().then(() => {
      if (playTokenRef.current !== token) return;
      setIsPlaying(true);
      setVideoLoading(false);
    }).catch(() => { /* 自动播放被拦截时保持暂停，等用户点播放 */ });
    video.onplaying = () => { if (playTokenRef.current === token) { setIsPlaying(true); setVideoLoading(false); } };
    video.onpause = () => { if (playTokenRef.current === token) setIsPlaying(false); };
    // 直播不应自然播完：ended 一律视为异常断流，自愈重拉
    video.onended = () => { if (playTokenRef.current === token) autoRecover('直播播放结束'); };
  }, [destroyEngines, showToast]);

  // 真正的播放实现（非 useCallback：attachStream 需要后向引用它）
  function playChannelImpl(ref: PlayingRef, channel: LiveChannel, lineIndex: number, keepTried: boolean) {
    playTokenRef.current++;
    destroyEngines();
    if (!keepTried) triedLinesRef.current = new Set();
    triedLinesRef.current.add(lineIndex);
    currentRef.current = ref;
    currentChannelRef.current = channel;
    lineRef.current = lineIndex;
    setCurrent(ref);
    setCurrentChannel(channel);
    setLine(lineIndex);
    setViaProxy(false);
    setPlayData(null);
    setEpg(null);
    setEpgEmpty(false);
    setEpgOpen(false);
    setVideoLoading(true);
    const token = playTokenRef.current;

    (async () => {
      try {
        const res = await api.livePlay(ref.live, ref.group, ref.channel, lineIndex);
        if (playTokenRef.current !== token) return;
        if (res.error) throw new Error(res.error);
        if (!/^https?:/i.test(res.url)) {
          setVideoLoading(false);
          setPlayError(`该频道为 ${res.protocol.toUpperCase()} 协议，浏览器暂不支持，请在 App 端观看`);
          return;
        }
        setPlayData(res);
        // 记录观看历史（乐观置顶更新本地列表，服务端 upsert 并裁剪到 10 条）
        const histItem: LiveHistoryItem = {
          liveName: ref.live, groupName: ref.group, channelName: ref.channel,
          line: lineIndex, logo: channel.logo || '', updatedAt: new Date().toISOString(),
        };
        setLiveHist((prev) => [histItem, ...prev.filter((x) => histKey(x) !== histKey(histItem))].slice(0, 10));
        api.saveLiveHistory(histItem).catch(() => {});
        // https 页面里的 http 直连地址会被混合内容策略拦截，直接走代理
        const forceProxy = res.direct && window.location.protocol === 'https:' && res.url.startsWith('http:');
        setViaProxy(forceProxy);
        attachStream(res, forceProxy);
        if (channel.epg) {
          api.liveEpg(ref.live, ref.group, ref.channel)
            .then((d) => {
              if (playTokenRef.current !== token || d.error) return;
              if (d.list && d.list.length > 0) setEpg(d);
              else setEpgEmpty(true); // 当日无节目单（源未匹配到该频道）
            })
            .catch(() => {});
        }
      } catch (e: any) {
        if (playTokenRef.current !== token) return;
        setVideoLoading(false);
        const msg = String(e?.message || '播放失败');
        setPlayError(/设备未连接|device offline/i.test(msg) ? '设备不在线，打开 App 后重试' : msg);
      }
    })();
  }

  const playChannel = useCallback((ref: PlayingRef, channel: LiveChannel, lineIndex: number) => {
    playChannelImpl(ref, channel, lineIndex, false);
  }, []);

  // ---- 频道表加载 ----
  const loadList = useCallback(async (live: string): Promise<LiveListData | null> => {
    const seq = ++loadSeqRef.current;
    setLoading(true);
    setLoadError('');
    try {
      const res = await api.liveList(live);
      if (seq !== loadSeqRef.current) return null; // 快速切源：只认最后一次请求
      if (res.error) throw new Error(res.error);
      setData(res);
      setActiveLive(live);
      if (!res.groups.some((g) => g.name === activeGroup)) {
        setActiveGroup(res.groups.find((g) => g.channels.length)?.name || res.groups[0]?.name || '');
      }
      return res;
    } catch (e: any) {
      if (seq !== loadSeqRef.current) return null;
      setLoadError(String(e?.message || '频道表加载失败'));
      return null;
    } finally {
      if (seq === loadSeqRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroup]);

  // 进页默认选台：历史第一条 → 第一个可用收藏 → 当前源第一个频道。单条候选项校验+播放：
  // 源/分组/频道任一缺失跳过（跨源先用 api.liveList 静态校验不动页面状态，命中才 loadList 切表）
  const entryPlayItem = async (
    table: LiveListData,
    it: Pick<LiveHistoryItem, 'liveName' | 'groupName' | 'channelName' | 'line'>,
  ): Promise<boolean> => {
    const src = it.liveName || table.name;
    let t: LiveListData | null = table;
    if (src !== table.name) {
      try {
        const r = await api.liveList(it.liveName);
        t = r.error ? null : r;
      } catch { t = null; }
    }
    if (!t) return false; // 源已不可解析
    const g = t.groups.find((x) => x.name === it.groupName);
    const c = g?.channels.find((x) => x.name === it.channelName);
    if (!g || !c) return false; // 分组/频道已不存在
    if (src !== table.name) {
      const loaded = await loadList(it.liveName); // 后端 (设备,源) 缓存，二次调用秒回
      if (!loaded) return false;
    }
    setActiveGroup(g.name);
    playChannel({ live: src, group: g.name, channel: c.name }, c, Math.min(it.line ?? 0, Math.max(c.lines - 1, 0)));
    return true;
  };

  const entryAutoPlay = async (table: LiveListData, histList: LiveHistoryItem[], favList: LiveFavoriteItem[]) => {
    for (const h of histList) if (await entryPlayItem(table, h)) return;
    for (const fav of favList) if (await entryPlayItem(table, fav)) return;
    const g0 = table.groups.find((x) => x.channels.length) || table.groups[0];
    const c0 = g0?.channels[0];
    if (g0 && c0) playChannel({ live: table.name, group: g0.name, channel: c0.name }, c0, 0);
  };

  useEffect(() => {
    let stale = false;
    // 历史/收藏/频道表都就绪后再选台（任一未返回都无法判定「该播哪条」，先到先播会抢跑）
    const histP = api.liveHistory()
      .then((r) => { if (!stale) setLiveHist(r.list || []); return r.list || []; })
      .catch(() => [] as LiveHistoryItem[]);
    const favsP = api.liveFavorites()
      .then((r) => { if (!stale) setFavs(r.list || []); return r.list || []; })
      .catch(() => [] as LiveFavoriteItem[]);
    Promise.all([histP, favsP, loadList('')]).then(([histList, favList, table]) => {
      if (stale || !table) return;
      void entryAutoPlay(table, histList, favList);
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFavs = useCallback(() => {
    api.liveFavorites().then((r) => setFavs(r.list || [])).catch(() => {});
  }, []);

  const sourceName = activeLive || data?.name || '';
  useEffect(() => { sourceNameRef.current = sourceName; }, [sourceName]);

  // 进页/换表：后台探测各源分组/频道数（后端落库缓存，二次进页秒回）；当前源直接取自频道表省一次请求
  useEffect(() => {
    if (!data?.name) return;
    const chs = data.groups.reduce((n, g) => n + g.channels.length, 0);
    setLiveMeta((p) => ({ ...p, [data.name]: { groups: data.groups.length, channels: chs } }));
    const queue = (data.lives || []).map((l) => l.name).filter((n) => n && n !== data.name);
    let stale = false;
    // 3 并发：设备端每个源首次解析可能要拉远程配置，逐个打满会拖慢桥接
    const worker = async () => {
      while (!stale && queue.length) {
        const name = queue.shift()!;
        try {
          const r = await api.liveGroups(name);
          if (!stale && !r.error && typeof r.groups === 'number') {
            setLiveMeta((p) => ({ ...p, [name]: { groups: r.groups, channels: r.channels || 0 } }));
          }
        } catch { /* 单源失败不影响其余 */ }
      }
    };
    void Promise.all([worker(), worker(), worker()]);
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.name, data?.lives]);

  // ---- 线路探测 ----
  const probeKeyOf = (group: string, channel: string, line: number) => `${group}::${channel}::${line}`;

  // 频道探测摘要：最优 ok 线路 / 是否全部探测失败
  const channelProbe = (group: string, channel: string, lines: number) => {
    let best: LiveProbeResult | null = null;
    let probed = 0;
    let failed = 0;
    for (let i = 0; i < lines; i++) {
      const p = probes[probeKeyOf(group, channel, i)];
      if (!p) continue;
      probed++;
      if (p.status === 'fail') failed++;
      else if (!best || (p.metrics?.scores?.total ?? 0) > (best.metrics?.scores?.total ?? 0)) best = p;
    }
    return { best, probed, allFail: probed > 0 && probed === failed };
  };

  // 播放默认线路：探测得分最高的可用线路，没有则线路 1
  const bestLine = (group: string, channel: string, lines: number) =>
    channelProbe(group, channel, lines).best?.line ?? 0;

  // 探测收尾：关 SSE、清状态（done 到达 / 取消兜底 / 切源离页共用）
  const finalizeScan = useCallback(() => {
    scanEsRef.current?.close();
    scanEsRef.current = null;
    scanIdRef.current = '';
    setScan(null);
  }, []);

  // group 非空时只探测该分组（手动探测按钮按当前分组发起）；空 = 全源
  const startScan = useCallback((live: string, group = '') => {
    scanEsRef.current?.close();
    scanEsRef.current = null;
    scanSeenRef.current = new Set();
    setScan({ status: 'running', total: 0, finished: 0, group: group || undefined });
    api.liveScan(live, group).then((r) => {
      // 请求期间已切源：任务已无消费方，取消服务端扫描（防设备端空跑、与新源播放竞争），不碰新源状态
      if (live !== sourceNameRef.current) {
        if (r.scanId) api.liveScanCancel(r.scanId).catch(() => {});
        return;
      }
      if (r.error || !r.scanId) {
        setScan(null);
        showToast(r.error || '探测启动失败', 'warning');
        return;
      }
      const sid = r.scanId;
      setScan((s) => (s ? { ...s, total: r.total } : s));
      const es = new EventSource(`/api/live/scan/${sid}`);
      scanEsRef.current = es;
      scanIdRef.current = sid;
      const startedAt = Date.now();
      es.onmessage = (e) => {
        let msg: any;
        try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'meta') {
          setScan((s) => (s ? { ...s, total: msg.total } : s));
        } else if (msg.type === 'result') {
          const k = probeKeyOf(msg.result.group, msg.result.channel, msg.result.line);
          if (!scanSeenRef.current.has(k)) {
            scanSeenRef.current.add(k);
            setScan((s) => (s ? { ...s, finished: s.finished + 1 } : s));
          }
          setProbes((prev) => ({ ...prev, [k]: msg.result as LiveProbeResult }));
        } else if (msg.type === 'done') {
          es.close();
          if (scanIdRef.current !== sid) return; // 期间已切源/另起扫描，静默退出
          finalizeScan();
          const scope = group ? `分组「${group}」` : '';
          if (msg.error) showToast(`${scope}探测中断：${msg.error}`, 'warning');
          else if (msg.cancelled) showToast(`${scope}探测已取消：已测 ${msg.ok}/${msg.total} 条线路`, 'info');
          else showToast(`${scope}探测完成：${msg.ok}/${msg.total} 条线路可用`, 'success');
        }
      };
      es.onerror = () => {
        // 服务端 SSE 断线会自动重连并重放事件（seen 集合保证计数幂等）；超 15 分钟视为任务已死
        if (Date.now() - startedAt > 15 * 60 * 1000) {
          es.close();
          if (scanEsRef.current === es) scanEsRef.current = null;
          if (scanIdRef.current === sid) {
            scanIdRef.current = '';
            setScan(null);
            showToast('探测连接中断', 'warning');
          }
        }
      };
    }).catch(() => {
      if (live !== sourceNameRef.current) return;
      setScan(null);
      showToast('探测启动失败', 'warning');
    });
  }, [showToast, finalizeScan]);

  // 切源/进页：载入探测缓存（3h 内复用）；体检只经手动探测按钮发起
  useEffect(() => {
    if (!sourceName) return;
    scanSeenRef.current = new Set();
    setProbes({});
    let stale = false;
    api.liveProbe(sourceName).then((r) => {
      if (stale) return;
      const m: Record<string, LiveProbeResult> = {};
      for (const it of r.list || []) m[probeKeyOf(it.group, it.channel, it.line)] = it;
      setProbes(m);
    }).catch(() => {});
    return () => {
      stale = true;
      // 旧源探测连同服务端任务一并终止（硬取消，在飞探测立即中断），不占设备、不与新源播放竞争
      if (scanIdRef.current) api.liveScanCancel(scanIdRef.current).catch(() => {});
      finalizeScan();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceName]);

  // ---- 收藏 ----
  const favKey = (f: { liveName: string; groupName: string; channelName: string }) =>
    `${f.liveName}::${f.groupName}::${f.channelName}`;
  const histKey = favKey; // 历史记录与收藏同键结构（源::分组::频道）
  const relTime = (iso: string) => {
    const t = Date.parse(iso);
    if (!t) return '';
    const s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
    if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
    if (s < 172800) return '昨天';
    return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
  };
  const isFav = useMemo(
    () => !!current && favs.some((f) => favKey(f) === favKey({ liveName: current.live, groupName: current.group, channelName: current.channel })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [favs, current],
  );

  const toggleFav = () => {
    if (!current || !currentChannel) return;
    const body: LiveFavoriteItem = {
      liveName: current.live, groupName: current.group, channelName: current.channel,
      line, logo: currentChannel.logo,
    };
    const wasFav = favs.some((f) => favKey(f) === favKey(body));
    setFavs((prev) => (wasFav ? prev.filter((f) => favKey(f) !== favKey(body)) : [body, ...prev]));
    showToast(wasFav ? `已取消收藏 ${body.channelName}` : `已收藏 ${body.channelName}`, wasFav ? 'info' : 'success');
    api.toggleLiveFavorite(body)
      .then((res) => { if (typeof res.favorited === 'boolean' && res.favorited !== !wasFav) loadFavs(); })
      .catch(() => { loadFavs(); showToast('收藏操作失败', 'warning'); });
  };

  // 手动换线路：更新收藏里记住的线路偏好
  const switchLine = (next: number) => {
    const ref = currentRef.current;
    const channel = currentChannelRef.current;
    if (!ref || !channel) return;
    playChannel(ref, channel, next);
    const fav = favs.find((f) => favKey(f) === favKey(ref));
    if (fav) {
      setFavs((prev) => prev.map((f) => (favKey(f) === favKey(ref) ? { ...f, line: next } : f)));
      api.saveLiveFavoriteLine({ ...fav, line: next }).catch(() => {});
    }
  };

  // 收藏频道播放：直接跳到收藏记录的直播源/分组/频道/线路（跨源先 loadList 切表）
  const playFromFav = async (fav: LiveFavoriteItem) => {
    const target = fav.liveName || data?.name || '';
    let table: LiveListData | null = data;
    if (target && target !== sourceName) table = await loadList(target);
    if (!table) return;
    const g = table.groups.find((x) => x.name === fav.groupName);
    const c = g?.channels.find((x) => x.name === fav.channelName);
    if (!g || !c) {
      showToast('收藏的频道在直播源中已不存在', 'warning');
      return;
    }
    setActiveGroup(g.name); // 分组选择框跟随跳转（原实现只切源不切分组，分组框会停留在旧分组）
    playChannel({ live: target, group: g.name, channel: c.name }, c, Math.min(fav.line, Math.max(c.lines - 1, 0)));
  };

  // 历史记录播放：复用 entryPlayItem 的静默校验+切源+播放；源/分组/频道任一缺失时提示且不动当前源
  const playFromHistory = async (h: LiveHistoryItem) => {
    if (!data) return;
    if (!(await entryPlayItem(data, h))) showToast('历史记录的频道已不存在，直播配置可能已变更', 'warning');
  };

  // ---- 渲染数据 ----
  const groups = data?.groups || [];

  // ---- 收藏有效性 ----
  // 后台懒取收藏涉及其它源的频道表（后端 (设备,源) 10min 缓存 + live_tables 落库，二次进页秒回）；
  // 当前源直接用已加载的 data，不重复请求。取失败的源记 null = 源已不可解析
  useEffect(() => {
    if (!favs.length) return;
    const currentName = data?.name;
    const targets = [...new Set<string>(favs.map((f) => f.liveName || currentName || ''))]
      .filter((n) => n && n !== currentName && !favTableFetchedRef.current.has(n));
    if (!targets.length) return;
    let stale = false;
    targets.forEach((n) => {
      favTableFetchedRef.current.add(n);
      api.liveList(n)
        .then((r) => { if (!stale) setFavTables((p) => ({ ...p, [n]: r.error ? null : r })); })
        .catch(() => { if (!stale) setFavTables((p) => ({ ...p, [n]: null })); });
    });
    return () => { stale = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [favs, data?.name]);

  // 收藏项判定：直播配置变更后源/分组/频道/线路任一找不到 → invalid（置灰+提示）；checking=源表未返回
  const favValidity = (fav: LiveFavoriteItem): { status: 'checking' } | { status: 'ok'; channel: LiveChannel } | { status: 'invalid'; reason: string } => {
    const src = fav.liveName || data?.name || '';
    let table: LiveListData | null;
    if (src && src === data?.name) {
      table = data; // 当前源直接用已加载的频道表
    } else {
      const cached = favTables[src];
      if (cached === undefined) return { status: 'checking' }; // 跨源表还没取回
      if (cached === null) return { status: 'invalid', reason: `直播源「${src}」已不存在，直播配置可能已变更` };
      table = cached;
    }
    if (!table) return { status: 'checking' }; // 当前源频道表尚未加载完
    const g = table.groups.find((x) => x.name === fav.groupName);
    if (!g) return { status: 'invalid', reason: `分组「${fav.groupName}」在直播源「${src}」中已不存在，直播配置可能已变更` };
    const c = g.channels.find((x) => x.name === fav.channelName);
    if (!c) return { status: 'invalid', reason: `频道「${fav.channelName}」在分组「${fav.groupName}」中已不存在，直播配置可能已变更` };
    if ((fav.line ?? 0) >= (c.lines || 1)) {
      return { status: 'invalid', reason: `频道「${fav.channelName}」仅剩 ${c.lines} 条线路，收藏的线路 ${(fav.line ?? 0) + 1} 已不存在` };
    }
    return { status: 'ok', channel: c };
  };

  // 删除收藏（toggle 接口按 (源,分组,频道) 键再按一次即取消收藏）
  const removeFav = async (fav: LiveFavoriteItem) => {
    setFavs((prev) => prev.filter((f) => favKey(f) !== favKey(fav)));
    setDelFav(null);
    try {
      const res = await api.toggleLiveFavorite(fav);
      if (typeof res.favorited === 'boolean' && res.favorited) loadFavs(); // 本想删除却变成收藏（状态漂移）：重拉对齐
      else showToast(`已删除收藏 ${fav.channelName}`, 'info');
    } catch {
      loadFavs();
      showToast('删除收藏失败', 'warning');
    }
  };

  // 分组探测统计（探测覆盖到的线路 ok/total），供分组下拉显示
  const groupStats = useMemo(() => {
    const m: Record<string, { ok: number; total: number }> = {};
    for (const g of groups) {
      for (const c of g.channels) {
        for (let i = 0; i < (c.lines || 1); i++) {
          const p = probes[probeKeyOf(g.name, c.name, i)];
          if (!p) continue;
          const s = (m[g.name] ||= { ok: 0, total: 0 });
          s.total++;
          if (p.status === 'ok') s.ok++;
        }
      }
    }
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [probes, data]);

  const shownChannels: { group: string; channel: LiveChannel }[] =
    (groups.find((g) => g.name === activeGroup)?.channels || []).map((c) => ({ group: activeGroup, channel: c }));

  const epgNowIdx = epg ? epg.list.findIndex((p) => p.selected) : -1;
  const epgNow = epg && epgNowIdx >= 0 ? epg.list[epgNowIdx] : undefined;
  const epgNext = epg && epgNowIdx >= 0 ? epg.list[epgNowIdx + 1] : undefined;
  const activeGroupChannels = groups.find((g) => g.name === activeGroup)?.channels.length || 0;

  // ---- 播放器操作 ----
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {}); else v.pause();
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };
  const toggleFullscreen = () => {
    const el = videoRef.current?.parentElement;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => {});
  };
  const replay = () => {
    const ref = currentRef.current;
    const channel = currentChannelRef.current;
    if (ref && channel) playChannel(ref, channel, lineRef.current);
  };

  // ---------- 渲染 ----------
  const lineProbe = current ? probes[probeKeyOf(current.group, current.channel, line)] : undefined;
  // 当前频道的探测摘要（频道下拉按钮上的速度·清晰度徽章）
  const curProbe = current && currentChannel ? channelProbe(current.group, currentChannel.name, currentChannel.lines || 1) : null;

  const renderChannelRow = (group: string, channel: LiveChannel) => {
    const active = current?.group === group && current?.channel === channel.name;
    const fav = favs.find((f) => f.liveName === sourceName && f.groupName === group && f.channelName === channel.name);
    const cp = channelProbe(group, channel.name, channel.lines || 1);
    return (
      <button
        key={`${group}::${channel.name}`}
        onClick={() => { setMenuOpen(''); playChannel({ live: sourceName, group, channel: channel.name }, channel,
          fav && fav.line < channel.lines ? fav.line : bestLine(group, channel.name, channel.lines || 1)); }}
        className={`w-full flex items-center gap-3 px-3.5 py-2.5 text-left transition-colors border-l-2 ${
          active ? 'bg-emerald-500/10 border-emerald-500' : 'border-transparent hover:bg-zinc-800/50'
        }`}
      >
        {channel.logo
          ? <img src={imgUrl(channel.logo)} alt="" className="w-8 h-8 rounded-lg object-cover bg-zinc-800 shrink-0" loading="lazy"
              onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
          : <div className="w-8 h-8 rounded-lg bg-zinc-800 shrink-0 flex items-center justify-center"><Tv className="w-4 h-4 text-zinc-600" /></div>}
        <span className={`flex-1 truncate text-sm ${active ? 'text-emerald-300 font-medium' : 'text-zinc-200'}`}>{channel.name}</span>
        {cp.allFail ? (
          <span className="text-[10px] text-rose-400/90 shrink-0" title="所有线路探测不可用">✕</span>
        ) : cp.best?.metrics ? (
          <MetricBadges metrics={cp.best.metrics} live compact className="shrink-0" />
        ) : null}
        {channel.lines > 1 && <span className="text-[10px] text-zinc-500 shrink-0">{channel.lines} 线路</span>}
        {fav && <Star className="w-3.5 h-3.5 text-amber-400 shrink-0 fill-amber-400" />}
      </button>
    );
  };

  return (
    <div className="animate-fade-in">
      {/* 播放器上方行：直播源+设备状态 | 分组+探测 | 我的收藏 三个组合框（标题前缀说明清楚各项是什么；移动端各占整行，名称放得下） */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        {/* 直播源 + 设备状态融合组合框：主体段开源下拉（标题前缀 + 分组数徽章），右段设备在线状态（与分组框探测段同构同宽）；移动端整行、桌面固定宽 */}
        <div data-live-dropdown className="relative w-full lg:flex-1 lg:min-w-0">
          <div className="flex items-stretch rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden transition-colors hover:border-emerald-600/60">
            <button
              onClick={() => setMenuOpen(menuOpen === 'live' ? '' : 'live')}
              className="flex-1 min-w-0 flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800/50 transition-colors"
            >
              <Signal className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-xs text-zinc-500 shrink-0">直播源</span>
              <span className="flex-1 min-w-0 truncate font-medium">{sourceName || '未选择'}</span>
              {liveMeta[sourceName] && (
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-400 shrink-0 tabular-nums"
                      title={`${liveMeta[sourceName].channels} 个频道`}>
                  {liveMeta[sourceName].groups} 分组
                </span>
              )}
              <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${menuOpen === 'live' ? 'rotate-180' : ''}`} />
            </button>
            {/* 设备状态段已移除（09-02 用户要求），在线状态经桥接请求自然反映 */}
          </div>
          {menuOpen === 'live' && (
            <div className="absolute z-30 mt-2 w-full lg:w-64 max-w-[calc(100vw-2rem)] max-h-80 overflow-auto rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 py-1.5">
              {(data?.lives || []).map((l) => (
                <button
                  key={l.name}
                  onClick={() => {
                    setMenuOpen('');
                    stopPlayback();        // 立即停掉旧源画面，并作废在途播放请求
                    setActiveLive(l.name); // 乐观更新：选择框立即显示新源，不等 liveList 往返
                    loadList(l.name);
                  }}
                  className={`w-full flex items-center gap-2 px-4 py-2.5 text-sm transition-colors ${
                    sourceName === l.name ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-300 hover:bg-zinc-800/70'
                  }`}
                >
                  <span className="flex-1 truncate">{l.name}</span>
                  {liveMeta[l.name] ? (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-400 shrink-0 tabular-nums"
                          title={`${liveMeta[l.name].channels} 个频道`}>
                      {liveMeta[l.name].groups} 分组 · {liveMeta[l.name].channels} 频道
                    </span>
                  ) : (
                    <span className="text-[10px] text-zinc-600 shrink-0">…</span>
                  )}
                </button>
              ))}
              {(data?.lives || []).length === 0 && <div className="px-4 py-2.5 text-sm text-zinc-500">只有一个直播源</div>}
            </div>
          )}
        </div>

        {/* 分组 + 探测融合组合框：主体段开分组下拉，右段探测当前分组；
            嵌套 clickable 在 IAB 下事件会路由给外层（真机踩过），必须与下方频道组合框同构：扁平并排独立 button */}
        <div data-live-dropdown className="relative w-full lg:flex-1 lg:min-w-0">
          <div className="flex items-stretch rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden transition-colors hover:border-emerald-600/60">
            <button
              onClick={() => setMenuOpen(menuOpen === 'group' ? '' : 'group')}
              className="flex-1 min-w-0 flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800/50 transition-colors"
            >
              <ListVideo className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-xs text-zinc-500 shrink-0">分组</span>
              <span className="flex-1 min-w-0 truncate font-medium">{activeGroup || '未选择'}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-400 shrink-0 tabular-nums">
                {activeGroupChannels} 频道
              </span>
              <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${menuOpen === 'group' ? 'rotate-180' : ''}`} />
            </button>
            <div className="flex items-center border-l border-zinc-800 shrink-0">
              <button
                onClick={() => {
                  if (!scan || scan.status !== 'running') {
                    if (sourceName && !scan) startScan(sourceName, activeGroup);
                    return;
                  }
                  const sid = scanIdRef.current;
                  if (!sid) return;
                  // 后端硬取消：在飞探测立即中断、done 秒回；期间按钮转「取消中…」禁用
                  setScan((s) => (s && s.status === 'running' ? { ...s, status: 'cancelling' } : s));
                  api.liveScanCancel(sid)
                    .then((r) => { if (!r.ok) throw new Error('not running'); })
                    .catch(() => { if (scanIdRef.current === sid) finalizeScan(); }); // 任务已不在（done 丢失等）：本地收尾
                  setTimeout(() => { if (scanIdRef.current === sid) finalizeScan(); }, 5000); // SSE 已断时兜底
                }}
                disabled={!sourceName || scan?.status === 'cancelling'}
                title={scan ? '取消探测（立即中断在飞探测）'
                  : `探测当前分组「${activeGroup || sourceName}」：前 10 个频道 × 每频道前 2 条线路（可随时取消）`}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm transition-colors disabled:opacity-50 ${
                  scan ? 'text-amber-300 hover:text-amber-200' : 'text-zinc-300 hover:text-emerald-300'
                }`}
              >
                <Activity className={`w-4 h-4 shrink-0 ${scan ? 'animate-pulse text-amber-400' : 'text-emerald-400'}`} />
                {scan?.status === 'cancelling' ? '取消中…' : scan ? '取消' : '探测'}
              </button>
            </div>
          </div>
          {menuOpen === 'group' && (
            <div className="absolute z-30 right-0 lg:right-auto mt-2 w-full lg:w-64 max-w-[calc(100vw-2rem)] max-h-80 overflow-auto rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 py-1.5">
              {groups.map((g) => {
                const gs = groupStats[g.name];
                return (
                  <button
                    key={g.name}
                    onClick={() => { setMenuOpen(''); setActiveGroup(g.name); }}
                    className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                      activeGroup === g.name ? 'text-emerald-400 bg-emerald-500/10' : 'text-zinc-300 hover:bg-zinc-800/70'
                    }`}
                  >
                    <span className="flex-1 text-left truncate">{g.name}</span>
                    <span className="text-[10px] text-zinc-500 tabular-nums shrink-0 whitespace-nowrap">
                      {g.channels.length} 频道
                      {gs && <span className="text-emerald-400/80" title="探测可用线路数"> · {gs.ok}/{gs.total}</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        {/* 收藏 + 历史融合组合框（与分组+探测同构：主体段开收藏面板，border-l 右段开历史面板）；
            收藏面板每行带源/分组/线路徽章（收藏时即记录），点击直接跳到该源/分组/频道/线路播放；
            历史面板每行额外带最后观看时间，最多 10 条，找不到频道点击只提示不动当前源 */}
        <div data-live-dropdown className="relative w-full lg:flex-1 lg:min-w-0">
          <div className="flex items-stretch rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden transition-colors hover:border-emerald-600/60">
            <button
              onClick={() => setMenuOpen(menuOpen === 'fav' ? '' : 'fav')}
              className="flex-1 min-w-0 flex items-center gap-1.5 px-3 py-2 text-sm text-zinc-200 hover:bg-zinc-800/50 transition-colors"
            >
              <Star className={`w-4 h-4 shrink-0 ${favs.length ? 'fill-amber-400 text-amber-400' : 'text-amber-400'}`} />
              <span className="text-xs text-zinc-500 shrink-0">收藏</span>
              <span className="flex-1 min-w-0 truncate font-medium">{favs.length ? '我的收藏' : '暂无收藏'}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-zinc-800 text-zinc-400 shrink-0 tabular-nums">{favs.length} 收藏</span>
              <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${menuOpen === 'fav' ? 'rotate-180' : ''}`} />
            </button>
            <div className="flex items-center border-l border-zinc-800 shrink-0">
              <button
                onClick={() => setMenuOpen(menuOpen === 'hist' ? '' : 'hist')}
                title={`观看历史（最多保留 10 条）：点击记录跳到对应频道播放`}
                className={`flex items-center gap-1.5 px-3 py-2 text-sm transition-colors ${
                  menuOpen === 'hist' ? 'text-emerald-300' : 'text-zinc-300 hover:text-emerald-300'
                }`}
              >
                <History className="w-4 h-4 text-emerald-400 shrink-0" />
                历史
              </button>
            </div>
          </div>
          {menuOpen === 'fav' && (
            <div className="absolute z-30 right-0 mt-2 w-full lg:w-96 max-w-[calc(100vw-2rem)] max-h-96 overflow-auto scrollbar-thin rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 py-1.5">
              {favs.length === 0 && (
                <div className="py-8 px-6 text-center text-sm text-zinc-500">还没有收藏频道，播放后点 ★ 收藏</div>
              )}
              {favs.map((fav) => {
                const v = favValidity(fav);
                const invalid = v.status === 'invalid';
                const rowChannel = v.status === 'ok' ? v.channel : null;
                return (
                  <div
                    key={favKey(fav)}
                    className={`w-full flex items-stretch border-l-2 transition-colors ${
                      current && favKey(fav) === favKey(current) ? 'bg-emerald-500/10 border-emerald-500' : 'border-transparent'
                    }`}
                  >
                    {/* 播放区与删除按钮平级并排（IAB 嵌套 clickable 坑，与频道组合框同构）；失效项置灰只提示不播放 */}
                    <button
                      onClick={() => {
                        setMenuOpen('');
                        if (v.status === 'invalid') showToast(v.reason, 'warning');
                        else playFromFav(fav); // checking 态交给 playFromFav 自校验（切源后查不到会另行提示）
                      }}
                      className={`flex-1 min-w-0 flex items-center gap-2.5 pl-4 py-2.5 text-left hover:bg-zinc-800/50 transition-colors ${invalid ? 'opacity-60' : ''}`}
                    >
                      {fav.logo || rowChannel?.logo
                        ? <img src={imgUrl(fav.logo || rowChannel!.logo)} alt="" className="w-8 h-8 rounded-lg object-cover bg-zinc-800 shrink-0" loading="lazy"
                            onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                        : <div className="w-8 h-8 rounded-lg bg-zinc-800 shrink-0 flex items-center justify-center"><Tv className="w-4 h-4 text-zinc-600" /></div>}
                      <span className={`flex-1 min-w-0 truncate text-sm ${invalid ? 'text-zinc-500' : 'text-zinc-200'}`}>{fav.channelName}</span>
                      {fav.liveName && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0 max-w-[88px] truncate" title={`直播源：${fav.liveName}`}>{fav.liveName}</span>}
                      {fav.groupName && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0 max-w-[72px] truncate" title={`分组：${fav.groupName}`}>{fav.groupName}</span>}
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0 tabular-nums" title={`线路 ${(fav.line ?? 0) + 1}`}>线路 {(fav.line ?? 0) + 1}</span>
                    </button>
                    <button
                      onClick={() => setDelFav(fav)}
                      title="删除该收藏"
                      className="group/del shrink-0 flex items-center px-1.5 text-rose-700 hover:text-rose-500 transition-colors"
                    >
                      {/* 悬浮底色放在贴合图标的内层小矩形上（按钮本体被 items-stretch 拉满行高，直接给 bg 会铺成整行横带） */}
                      <span className="flex items-center justify-center w-6 h-6 rounded-md transition-colors group-hover/del:bg-zinc-800">
                        <Trash2 className="w-4 h-4" />
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {menuOpen === 'hist' && (
            <div className="absolute z-30 right-0 mt-2 w-full lg:w-96 max-w-[calc(100vw-2rem)] max-h-96 overflow-auto scrollbar-thin rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 py-1.5">
              {liveHist.length === 0 && (
                <div className="py-8 px-6 text-center text-sm text-zinc-500">还没有观看记录，播一个频道试试</div>
              )}
              {liveHist.map((h) => (
                <button
                  key={histKey(h)}
                  onClick={() => { setMenuOpen(''); playFromHistory(h); }}
                  className={`w-full flex items-center gap-2.5 pl-4 pr-3 py-2.5 text-left hover:bg-zinc-800/50 transition-colors ${
                    current && histKey(h) === favKey(current) ? 'bg-emerald-500/10' : ''
                  }`}
                >
                  {h.logo
                    ? <img src={imgUrl(h.logo)} alt="" className="w-8 h-8 rounded-lg object-cover bg-zinc-800 shrink-0" loading="lazy"
                        onError={(e) => { (e.target as HTMLImageElement).style.visibility = 'hidden'; }} />
                    : <div className="w-8 h-8 rounded-lg bg-zinc-800 shrink-0 flex items-center justify-center"><Tv className="w-4 h-4 text-zinc-600" /></div>}
                  <span className="flex-1 min-w-0 truncate text-sm text-zinc-200">{h.channelName}</span>
                  {h.liveName && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0 max-w-[88px] truncate" title={`直播源：${h.liveName}`}>{h.liveName}</span>}
                  {h.groupName && <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0 max-w-[72px] truncate" title={`分组：${h.groupName}`}>{h.groupName}</span>}
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 shrink-0 tabular-nums" title={`线路 ${(h.line ?? 0) + 1}`}>线路 {(h.line ?? 0) + 1}</span>
                  <span className="text-[10px] text-zinc-500 shrink-0 tabular-nums" title={`最后观看：${h.updatedAt}`}>{relTime(h.updatedAt)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* 探测进度条（取消中转琥珀色静候 done） */}
      {scan && (
        <div className={`flex items-center gap-3 mb-3 px-3.5 py-2 rounded-xl border ${
          scan.status === 'cancelling'
            ? 'border-amber-500/30 bg-amber-500/[0.06]'
            : 'border-emerald-500/25 bg-emerald-500/[0.06]'
        }`}>
          <Activity className={`w-4 h-4 animate-pulse shrink-0 ${scan.status === 'cancelling' ? 'text-amber-400' : 'text-emerald-400'}`} />
          <span className="text-xs text-zinc-300 shrink-0 tabular-nums">
            {scan.status === 'cancelling' ? '正在取消探测…'
              : `${scan.group ? `「${scan.group}」` : ''}线路探测 ${scan.finished}/${scan.total || '…'}`}
          </span>
          {scan.status === 'running' && (
            <div className="flex-1 h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
              <div className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-500"
                style={{ width: scan.total ? `${Math.min(100, (scan.finished / scan.total) * 100)}%` : '8%' }} />
            </div>
          )}
        </div>
      )}

      {/* 播放器：全宽（源/分组/频道/线路四下拉选择行在下方，再下为信息+节目单） */}
      <div className="flex flex-col gap-3">
          <div className="relative rounded-2xl overflow-hidden bg-black border border-zinc-800/70 aspect-video group">
            <video
              ref={videoRef}
              className="w-full h-full object-contain"
              playsInline
              autoPlay
              muted={muted}
              onClick={togglePlay}
            />
            {!current && !videoLoading && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/60">
                <Tv className="w-12 h-12 text-zinc-600" />
                <p className="text-sm text-zinc-400">选择频道开始观看</p>
              </div>
            )}
            {videoLoading && !playError && (
              <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                <div className="w-10 h-10 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              </div>
            )}
            {playError && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-black/70 px-6 text-center">
                <p className="text-sm text-rose-200">{playError}</p>
                <div className="flex gap-2">
                  <button onClick={replay} className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm text-white transition-colors">
                    <RefreshCw className="w-4 h-4" /> 重试
                  </button>
                  {currentChannel && currentChannel.lines > 1 && line + 1 < currentChannel.lines && (
                    <button onClick={() => switchLine(line + 1)} className="px-4 py-2 rounded-xl bg-zinc-700 hover:bg-zinc-600 text-sm text-white transition-colors">
                      换线路
                    </button>
                  )}
                </div>
              </div>
            )}
            {current && (
              <>
                {muted && isPlaying && (
                  <button onClick={toggleMute} className="absolute top-3 right-3 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-emerald-600/90 hover:bg-emerald-500 text-xs text-white">
                    <VolumeX className="w-3.5 h-3.5" /> 点击开声
                  </button>
                )}
                <div className="absolute bottom-0 inset-x-0 flex items-center gap-3 px-4 py-3 bg-gradient-to-t from-black/80 to-transparent opacity-100 lg:opacity-0 lg:group-hover:opacity-100 transition-opacity">
                  <button onClick={togglePlay} className="text-white/90 hover:text-white">{isPlaying ? <Pause className="w-5 h-5" /> : <Play className="w-5 h-5" />}</button>
                  <button onClick={toggleMute} className="text-white/90 hover:text-white">{muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}</button>
                  <div className="flex-1" />
                  {playData?.direct && !viaProxy && <span className="text-[10px] text-emerald-300/80">直连</span>}
                  {viaProxy && <span className="text-[10px] text-sky-300/80">服务器中转</span>}
                  <button onClick={replay} className="text-white/90 hover:text-white" title="重新拉流"><RefreshCw className="w-4 h-4" /></button>
                  <button onClick={toggleFullscreen} className="text-white/90 hover:text-white"><Maximize className="w-5 h-5" /></button>
                </div>
              </>
            )}
          </div>

          {/* 信息栏：正在播放的频道（点击即下拉切换频道）+ 收藏 + 线路（并行最右）+ EPG */}
          <div className="rounded-2xl bg-zinc-900/40 border border-zinc-800/70 p-4">
            <div className="flex flex-wrap lg:flex-nowrap items-center gap-2">
              {/* 频道区域：收藏星（替代原电视图标）｜正在播放的频道（点击下拉切换，速度/清晰度在下拉列表里展示）｜线路切换，三段并排同一组合框 */}
              <div data-live-dropdown className="relative flex-1 min-w-[240px]">
                <div className="flex items-stretch rounded-xl bg-zinc-900/60 border border-zinc-800 overflow-hidden">
                  {current ? (
                    <button
                      onClick={toggleFav}
                      title="收藏频道"
                      className={`shrink-0 flex items-center px-2.5 hover:bg-zinc-800/50 transition-colors ${isFav ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-300'}`}
                    >
                      <Star className={`w-5 h-5 ${isFav ? 'fill-amber-400' : ''}`} />
                    </button>
                  ) : (
                    <div className="shrink-0 flex items-center px-2.5 text-emerald-400">
                      <Tv className="w-5 h-5" />
                    </div>
                  )}
                  <button
                    onClick={() => setMenuOpen(menuOpen === 'channel' ? '' : 'channel')}
                    className="flex-1 min-w-0 flex items-center gap-2 px-2 py-2.5 text-left hover:bg-zinc-800/50 transition-colors"
                  >
                    <span className="flex-1 min-w-0 truncate text-base font-semibold text-zinc-100">
                      {currentChannel ? currentChannel.name : '选择频道开始播放'}
                    </span>
                    {currentChannel && curProbe?.allFail && (
                      <span className="text-[10px] font-bold text-rose-400/90 shrink-0" title="所有线路探测不可用">✕</span>
                    )}
                    <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${menuOpen === 'channel' ? 'rotate-180' : ''}`} />
                  </button>
                  <div className="flex items-center border-l border-zinc-800 shrink-0">
                    <button
                      onClick={() => currentChannel && setMenuOpen(menuOpen === 'line' ? '' : 'line')}
                      disabled={!currentChannel}
                      title="切换线路（速度/清晰度在下拉列表展示）"
                      className="flex items-center gap-1.5 px-3 py-2.5 text-sm text-zinc-200 hover:bg-zinc-800/50 transition-colors disabled:opacity-50"
                    >
                      <Radio className="w-4 h-4 text-emerald-400 shrink-0" />
                      <span className="shrink-0">{currentChannel ? `线路 ${line + 1}` : '线路'}</span>
                      {currentChannel && currentChannel.lines > 1 && <span className="text-[10px] text-zinc-500 shrink-0">/ {currentChannel.lines}</span>}
                      <ChevronDown className={`w-4 h-4 text-zinc-500 shrink-0 transition-transform ${menuOpen === 'line' ? 'rotate-180' : ''}`} />
                    </button>
                  </div>
                </div>
                {menuOpen === 'channel' && (
                  <div className="absolute z-30 mt-2 w-full max-h-96 overflow-y-auto scrollbar-thin rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 py-1.5">
                    {loading && (
                      <div className="py-10 flex justify-center">
                        <div className="w-7 h-7 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
                      </div>
                    )}
                    {!loading && loadError && (
                      <div className="py-8 px-6 text-center">
                        <p className="text-sm text-zinc-400 mb-3">{loadError}</p>
                        <button onClick={() => loadList(activeLive)} className="px-4 py-1.5 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-sm text-white transition-colors">
                          重试
                        </button>
                      </div>
                    )}
                    {!loading && !loadError && shownChannels.length === 0 && (
                      <div className="py-8 px-6 text-center text-sm text-zinc-500">没有匹配的频道</div>
                    )}
                    {!loading && !loadError && shownChannels.map(({ group, channel }) => renderChannelRow(group, channel))}
                  </div>
                )}
                {menuOpen === 'line' && currentChannel && (
                  <div className="absolute z-30 right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] max-h-80 overflow-auto rounded-xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 py-1.5">
                    {Array.from({ length: currentChannel.lines }).map((_, i) => {
                      const lp = current ? probes[probeKeyOf(current.group, current.channel, i)] : undefined;
                      const fail = lp?.status === 'fail';
                      return (
                        <button
                          key={i}
                          onClick={() => { setMenuOpen(''); switchLine(i); }}
                          className={`w-full flex items-center gap-2.5 px-4 py-2.5 text-sm transition-colors ${
                            line === i ? 'text-emerald-400 bg-emerald-500/10' : fail ? 'text-zinc-600 hover:bg-zinc-800/70 line-through' : 'text-zinc-300 hover:bg-zinc-800/70'
                          }`}
                        >
                          <span className="shrink-0">线路 {i + 1}</span>
                          {lp?.status === 'ok' && lp.metrics ? (
                            <MetricBadges metrics={lp.metrics} live compact className="ml-auto shrink-0" />
                          ) : fail ? (
                            <span className="ml-auto text-[10px] text-rose-400/80 shrink-0 truncate max-w-[110px]" title={lp?.error}>{lp?.error}</span>
                          ) : (
                            <span className="ml-auto text-[10px] text-zinc-600 shrink-0">未探测</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

            </div>
            {epg && epg.list.length > 0 ? (
              <div className="mt-3 border-t border-zinc-800/70 pt-3">
                <button onClick={() => setEpgOpen((v) => !v)} className="w-full flex items-center gap-2 text-sm">
                  <ListVideo className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-zinc-200 truncate">
                    <span className="text-emerald-300">{epgNow?.title || '暂无当前节目'}</span>
                    {epgNow && <span className="text-zinc-500 ml-2 text-xs">{epgNow.start} ~ {epgNow.end}</span>}
                  </span>
                  {epgNext && <span className="text-xs text-zinc-500 truncate hidden sm:inline">接下来：{epgNext.title}</span>}
                  <ChevronDown className={`w-4 h-4 text-zinc-500 ml-auto shrink-0 transition-transform ${epgOpen ? 'rotate-180' : ''}`} />
                </button>
                {epgOpen && (
                  <div className="mt-2 max-h-56 overflow-y-auto scrollbar-thin divide-y divide-zinc-800/50">
                    {epg.list.map((p, i) => (
                      <div key={i} className={`flex items-center gap-3 py-2 text-sm ${p.selected ? 'text-emerald-300' : 'text-zinc-400'}`}>
                        <span className="text-xs tabular-nums text-zinc-500 w-24 shrink-0">{p.start} ~ {p.end}</span>
                        <span className="truncate">{p.title}</span>
                        {p.selected && <span className="ml-auto text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/15 shrink-0">正在播出</span>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : currentChannel?.epg ? (
              <div className="mt-3 border-t border-zinc-800/70 pt-3 text-xs text-zinc-500">
                {epgEmpty ? '今日暂无节目单' : '节目单加载中…'}
              </div>
            ) : null}
          </div>
      </div>

      {/* 删除收藏二次确认弹窗：展示完整收藏信息；不做背板点击关闭（IAB 外层 div onClick 会抢内层按钮事件，真机踩过），只用按钮 */}
      {delFav && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
          <div className="w-full max-w-sm rounded-2xl bg-zinc-900 border border-zinc-800 shadow-2xl shadow-black/60 p-5">
            <h3 className="text-base font-semibold text-zinc-100 mb-4">删除收藏</h3>
            <div className="flex items-center gap-3 mb-4">
              {delFav.logo
                ? <img src={imgUrl(delFav.logo)} alt="" className="w-10 h-10 rounded-lg object-cover bg-zinc-800 shrink-0" />
                : <div className="w-10 h-10 rounded-lg bg-zinc-800 shrink-0 flex items-center justify-center"><Tv className="w-5 h-5 text-zinc-600" /></div>}
              <span className="text-sm font-medium text-zinc-100 truncate">{delFav.channelName}</span>
            </div>
            <div className="space-y-2 text-sm mb-5">
              <div className="flex justify-between gap-4"><span className="text-zinc-500 shrink-0">直播源</span><span className="text-zinc-200 truncate">{delFav.liveName || data?.name}</span></div>
              <div className="flex justify-between gap-4"><span className="text-zinc-500 shrink-0">分组</span><span className="text-zinc-200 truncate">{delFav.groupName}</span></div>
              <div className="flex justify-between gap-4"><span className="text-zinc-500 shrink-0">线路</span><span className="text-zinc-200 shrink-0">线路 {(delFav.line ?? 0) + 1}</span></div>
            </div>
            <p className="text-xs text-zinc-500 mb-4">删除后该收藏不再显示，频道仍可正常播放并重新收藏。</p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setDelFav(null)} className="px-4 py-2 rounded-xl bg-zinc-800 hover:bg-zinc-700 text-sm text-zinc-200 transition-colors">取消</button>
              <button onClick={() => removeFav(delFav)} className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-sm text-white transition-colors">删除</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
