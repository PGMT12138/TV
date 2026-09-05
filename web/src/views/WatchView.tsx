import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../api';
import { Episode, ScanCandidateResult, ScanMetrics, scanResultKey } from '../types';
import { fmtSpeed, fmtRes, AD_LABEL, compareRecommended, isDurationAbnormal, isMobileDevice } from '../utils/scanFormat';
import { lockOrientation, unlockOrientation, type OrientationLock } from '../utils/orientation';
import { SourcePickerModal } from '../components/SourcePickerModal';
import { MetricBadges } from '../components/MetricBadges';
import Hls from 'hls.js';
import {
  Play,
  Pause,
  Volume2,
  Volume1,
  VolumeX,
  Maximize2,
  Minimize2,
  RotateCcw,
  RotateCw,
  Smartphone,
  Lock,
  LockOpen,
  Bookmark,
  Share2,
  ChevronLeft,
  ListVideo,
  X,
  Loader2,
  WifiOff,
  SearchX,
  Zap,
  Film,
  Signal,
  Check
} from 'lucide-react';

const describeMetrics = (m: ScanMetrics) =>
  [fmtRes(m.height), AD_LABEL[m.adLevel], `${fmtSpeed(m.throughputMbps)}b/s`].join(' · ');

export const WatchView: React.FC = () => {
  const {
    selectedMovieId,
    selectedEpisodeId,
    getMovieById,
    loadMovieDetail,
    resolveResources,
    restartResourceSearch,
    movieResources,
    currentEpisodes,
    selectMatch,
    selectFlag,
    startScan,
    probeSite,
    reprobeSites,
    probingSites,
    patchScan,
    patchResource,
    confirmRestoredSource,
    navigateTo,
    goBack,
    recordWatchProgress,
    watchHistory,
    toggleFavorite,
    isFavorite,
    showToast,
  } = useApp();

  const movie = getMovieById(selectedMovieId || '');
  const movieId = movie?.id || selectedMovieId || '';
  const resource = movieResources[movieId];
  const activeLine = currentEpisodes(movieId);
  const episodes = activeLine?.episodes || [];
  const selectedMatch = resource?.selected;
  const scan = resource?.scan;
  // 探测阶段已经按响应头/文件魔数识别过真实媒体类型；播放地址常把 MP4 藏在
  // 无后缀签名 URL（甚至 filename=*.iso）里，不能只靠 URL 后缀猜播放引擎。
  const activeProbeKind = scan?.results.find(
    (r) => r.siteKey === selectedMatch?.siteKey && r.flag === activeLine?.flag
  )?.metrics?.kind;

  const [currentEpisode, setCurrentEpisode] = useState<Episode | null>(null);
  const [playerLoading, setPlayerLoading] = useState(true);
  const [playerError, setPlayerError] = useState('');
  const [buffering, setBuffering] = useState(false);  // 视频流缓冲中（起播/卡顿/拖进度条）
  const [bufferedEnd, setBufferedEnd] = useState(0);  // 当前播放位置对应的缓冲区末端（秒）
  const [sourceModalOpen, setSourceModalOpen] = useState(false);
  const [researching, setResearching] = useState(false);
  const [autoRecovering, setAutoRecovering] = useState(false);
  const [recoveryPending, setRecoveryPending] = useState('');
  const [playNonce, setPlayNonce] = useState(0);      // 重试播放的触发器

  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  // 起播看门狗：HEVC-TS 等播放器解不了的流，分片正常下载但 MSE 进不了帧，
  // readyState 永远停在 0 且不触发 hls.js fatal error
  const playbackWatchdogRef = useRef<number | null>(null);
  // 选集令牌过期自动换新：部分采集站 playUrl 带时效 token，页面停留超时后播放/
  // 探测都会失败（App 端每次进详情都拿新 token 所以无感）。失败后重拉一次详情
  // 换新令牌自动重试；按站点+线路 30s 防抖，避免线路真挂了时无限刷新
  const tokenRefreshRef = useRef<{ key: string; t: number } | null>(null);
  const failedSourceKeysRef = useRef<Set<string>>(new Set());
  const recoveryBusyRef = useRef(false);
  const freshRecoveryAttemptedRef = useRef(false);
  const restoreConfirmedKeyRef = useRef('');
  const playerContainerRef = useRef<HTMLDivElement>(null);
  const infoRef = useRef<HTMLElement>(null);
  const controlsTimeoutRef = useRef<number | null>(null);
  const resumeRef = useRef(0); // 自动切源/手动换源时携带的播放位置
  const lastVolumeRef = useRef(1); // 静音前的音量，取消静音时恢复

  // Playback state
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(100);
  const [volume, setVolume] = useState(() => {
    const saved = parseFloat(localStorage.getItem('cine.volume') || '');
    return Number.isFinite(saved) && saved > 0 ? Math.min(saved, 1) : 1; // 默认 100%，记忆上次音量
  });
  const [isMuted, setIsMuted] = useState(false);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [showControls, setShowControls] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 移动端防误触锁定：锁定后拦截播放器全部交互（暂停/进度/音量/控制栏），仅解锁按钮可点
  const [controlsLocked, setControlsLocked] = useState(false);
  const mobilePlayer = isMobileDevice();

  const favorited = movie ? isFavorite(movie.id) : false;

  // 详情兜底加载 + 资源解析（从卡片直接进播放页时影片可能还没解析过）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!getMovieById(movieId)) await loadMovieDetail(movieId);
      if (!cancelled) resolveResources(movieId);
    })();
    return () => { cancelled = true; };
  }, [movieId]);

  // 资源就绪后确定当前集（换站点/线路后集 id 变化，按集数号延续；历史里有上次的集数则优先恢复）
  useEffect(() => {
    if (resource?.status !== 'ready' || episodes.length === 0) return;
    setCurrentEpisode((prev) => {
      if (prev && episodes.some((e) => e.id === prev.id)) return prev;
      if (prev) {
        const byNum = episodes.find((e) => e.number === prev.number);
        if (byNum) return byNum;
      }
      const bySel = selectedEpisodeId ? episodes.find((e) => e.id === selectedEpisodeId) : undefined;
      if (bySel) return bySel;
      const saved = watchHistory.find((h) => h.movieId === movieId);
      const bySaved = saved?.episodeNumber ? episodes.find((e) => e.number === saved.episodeNumber) : undefined;
      return bySaved || episodes[0];
    });
  }, [resource?.status, selectedMatch?.siteKey, activeLine?.flag, episodes.length, episodes[0]?.id]);

  // 资源就绪即触发智能选源扫描（AppContext 内部有去重与结果复用）
  useEffect(() => {
    if (resource?.status === 'ready') startScan(movieId);
  }, [resource?.status, movieId, startScan]);

  // 扫描完成后的自动切源：当前源失败/有广告，或推荐源综合分领先 >0.15 才切换；
  // 用户手动选过源（userPicked）或已切过（switched）则不再动
  const applySourceRef = useRef<(siteKey: string, flag: string | undefined, manual?: boolean) => Promise<boolean>>(
    async () => false
  );
  const autoRecoverRef = useRef<(reason: string, markCurrent?: boolean) => Promise<boolean>>(
    async () => false
  );

  useEffect(() => {
    failedSourceKeysRef.current.clear();
    recoveryBusyRef.current = false;
    freshRecoveryAttemptedRef.current = false;
    restoreConfirmedKeyRef.current = '';
    setAutoRecovering(false);
    setRecoveryPending('');
  }, [movieId]);

  // 首次加载（awaitScan）：扫描中出现第一条可用线路就先播当前较优者；
  // 全部完成后由下方自动切源效果换到最优（provisional 标记临时线路）
  useEffect(() => {
    if (!resource?.awaitScan || !scan) return;
    const ok = scan.results.filter((r) => r.status === 'ok' && r.flag && r.metrics);
    if (!ok.length && scan.status !== 'done') return; // 还没有可用线路，继续等
    let best: ScanCandidateResult | undefined;
    if (ok.length) {
      best = [...ok].sort(compareRecommended)[0];
      if (scan.status === 'done' && scan.recommendedKey) {
        const rec = scan.results.find((r) => scanResultKey(r) === scan.recommendedKey);
        if (rec && rec.status === 'ok' && rec.metrics && rec.flag) best = rec;
      }
    }
    const provisional = scan.status !== 'done' && !!best;
    patchResource(movieId, { awaitScan: false, provisional: provisional || undefined });
    if (best && !(best.siteKey === selectedMatch?.siteKey && best.flag === activeLine?.flag)) {
      applySourceRef.current(best.siteKey, best.flag, false);
      showToast(
        provisional ? `已先用较优线路播放：${best.siteName} · ${best.flag}` : `已选择最优线路：${best.siteName} · ${best.flag}`,
        'success'
      );
    }
  }, [scan?.status, scan?.finished, resource?.awaitScan, movieId]);

  useEffect(() => {
    if (!scan || scan.status !== 'done' || scan.userPicked || scan.switched || !scan.recommendedKey) return;
    if (resource?.awaitScan) return; // 首次加载的选优由上面的 awaitScan 效果负责，避免同帧重复切换
    if (!resource || resource.status !== 'ready' || !selectedMatch || !activeLine) return;
    const rec = scan.results.find((r) => scanResultKey(r) === scan.recommendedKey);
    if (!rec || rec.status !== 'ok' || !rec.metrics || !rec.flag) return;
    if (rec.siteKey === selectedMatch.siteKey && rec.flag === activeLine.flag) return;
    const cur = scan.results.find((r) => r.siteKey === selectedMatch.siteKey && r.flag === activeLine.flag);
    let should = false;
    if (!cur || cur.status === 'fail' || !cur.metrics) should = true;
    else {
      const curDurationBad = isDurationAbnormal(cur.metrics);
      const recDurationBad = isDurationAbnormal(rec.metrics);
      // 时长分层优先于广告、清晰度、速度与综合分：正常线路绝不切到异常线路。
      if (curDurationBad !== recDurationBad) should = curDurationBad && !recDurationBad;
      else if (cur.metrics.adLevel === 'dirty' && rec.metrics.adLevel !== 'dirty') should = true;
      else if (resource?.provisional) should = compareRecommended(rec, cur) < 0; // 临时线路：全部测完即换最优
      else if (rec.metrics.scores.total - cur.metrics.scores.total > 0.15) should = true;
    }
    if (!should) return;
    patchScan(movieId, { switched: true });
    if (resource?.provisional) patchResource(movieId, { provisional: false });
    applySourceRef.current(rec.siteKey, rec.flag, false);
    showToast(
      resource?.provisional
        ? `测速完成，已切换到最优线路：${rec.siteName} · ${rec.flag}`
        : `已切换到更优线路：${rec.siteName} · ${rec.flag}（${describeMetrics(rec.metrics)}）`,
      'success'
    );
  }, [scan?.status, scan?.switched, scan?.userPicked, resource?.status, resource?.provisional, movieId]);

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  const handleResearch = useCallback(async () => {
    if (researching) return;
    failedSourceKeysRef.current.clear();
    freshRecoveryAttemptedRef.current = false;
    recoveryBusyRef.current = true; // removeAttribute/load 可能触发 video.error，手动重搜期间禁止自动恢复抢跑
    setAutoRecovering(false);
    setRecoveryPending('');
    setResearching(true);
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }
    destroyHls();
    resumeRef.current = 0;
    setCurrentEpisode(null);
    setIsPlaying(false);
    setPlayerError('');
    setPlayerLoading(true);
    setBuffering(false);
    setBufferedEnd(0);
    setCurrentTime(0);
    try {
      await restartResourceSearch(movieId);
    } catch {
      // AppContext 已展示失败原因；保留空面板，避免旧线路重新出现。
    } finally {
      recoveryBusyRef.current = false;
      setResearching(false);
    }
  }, [destroyHls, movieId, researching, restartResourceSearch]);

  // 首播门控（布尔值，只在"无可用线路 → 有可用线路"时翻转一次；
  // 不能直接依赖 scan 状态，否则扫描完成会触发播放器重载，把续播进度清掉）
  const scanGateOpen =
    !resource?.awaitScan || !!(scan && scan.results.some((r) => r.status === 'ok' && r.flag && r.metrics));

  // 拉取播放地址并挂载到 <video>（m3u8 用 hls.js）
  useEffect(() => {
    if (resource?.status !== 'ready' || !currentEpisode || !selectedMatch || !activeLine) {
      // 站点就绪但没有任何可用选集（站点失效）：清掉起播 loading，别永远"正在解析"
      if (resource?.status === 'ready' && !currentEpisode) setPlayerLoading(false);
      return;
    }
    // 首次加载且无历史偏好：等扫描出现第一条可用线路（由选优效果切过去）再起播
    if (!scanGateOpen) return;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;

    (async () => {
      setPlayerLoading(true);
      setPlayerError('');
      setBuffering(true);
      setBufferedEnd(0);
      destroyHls();
      try {
        const res = await api.player(selectedMatch.siteKey, activeLine.flag, currentEpisode.id);
        if (cancelled) return;
        if (res.error) throw new Error(res.error);
        const src = res.play || res.url;
        if (!src) throw new Error('未获取到播放地址');
        // 判定反转：只排除明确的文件直链（mp4/mkv 等），其余一律走 hls.js——大量线路入口是
        // php/无后缀地址（如 m3u8.meilinvps.com/m3u8/32641）302 到 CDN m3u8，后端按后缀
        // 误判 hls=false 后经 video.src 原生挂载，Chromium 不支持原生 HLS 会永远卡加载。
        // 扩展名藏在 query 里的直链（网盘/对象存储签名 URL 的 filename*=...mp4，
        // 或实际为 MP4 却标成 filename*=...iso）也算文件：
        // 喂给 hls.js 会把整个文件当清单下载，永远进不了帧
        const FILE_EXT_RE = /\.(mp4|mkv|flv|avi|mov|webm|m4s|iso)(?=[?&#]|$)/i;
        const fileish = (u?: string) => {
          if (!u) return false;
          if (FILE_EXT_RE.test(u)) return true;
          try { return FILE_EXT_RE.test(decodeURIComponent(u)); } catch { return false; }
        };
        const isFile = activeProbeKind === 'file' || fileish(src) || fileish(res.url);
        // 起播看门狗：HEVC-TS 等播放器解不了的流，分片正常下载但 MSE 进不了帧，
        // readyState 永远停在 0 且不触发 hls.js fatal error；大文件直链走 /stream
        // 代理时 moov 在尾部、Range 回读也要时间，60s 无 metadata 才判死
        const armWatchdog = () => {
          if (playbackWatchdogRef.current) window.clearTimeout(playbackWatchdogRef.current);
          playbackWatchdogRef.current = window.setTimeout(() => {
            playbackWatchdogRef.current = null;
            if (cancelled || video.readyState > 0) return;
            setBuffering(false);
            const message = '该线路一直未能起播，正在自动更换线路';
            void autoRecoverRef.current(message).then((recovered) => {
              if (!recovered && !cancelled) {
                setPlayerError('该线路一直未能起播：可能是浏览器不支持的编码，请手动更换线路');
              }
            });
          }, 60000);
        };

        if (!isFile && Hls.isSupported()) {
          // 前向缓冲 5 分钟：maxBufferSize 同步放大否则高码率下会先被字节数截断；
          // backBufferLength 限制已播部分留存，避免长片整个留在内存里
          const hls = new Hls({
            maxBufferLength: 300,
            maxMaxBufferLength: 600,
            maxBufferSize: 300 * 1000 * 1000,
            backBufferLength: 300,
          });
          hls.loadSource(src);
          hls.attachMedia(video);
          hls.on(Hls.Events.ERROR, (_evt, data) => {
            if (!data.fatal || cancelled) return;
            // 无后缀 mp4 直链被当成 m3u8 喂给 hls.js 时报清单解析/加载错误：降级 video.src 原生播放
            if (/MANIFEST_(LOAD|PARSING)_ERROR/.test(String(data.details))) {
              hls.destroy();
              if (hlsRef.current === hls) hlsRef.current = null;
              video.src = src;
              video.play().then(() => setIsPlaying(true)).catch(() => {});
              return;
            }
            setBuffering(false);
            const message = /BUFFER_CODEC/i.test(String(data.details))
              ? '该线路音视频编码不受支持'
              : '该线路视频加载失败';
            void autoRecoverRef.current(message).then((recovered) => {
              if (!recovered && !cancelled) setPlayerError(`${message}，请手动更换线路`);
            });
          });
          hlsRef.current = hls;
          armWatchdog();
        } else {
          video.src = src;
          armWatchdog();
        }
        video.play().then(() => setIsPlaying(true)).catch(() => {});
      } catch (e: any) {
        if (!cancelled) {
          setBuffering(false);
          const msg = String(e?.message || '播放地址获取失败');
          // 令牌过期类失败：重拉站点详情换新选集 token 自动重试（重拉后集 id 变化、
          // 按集数号延续进度，播放效果会自动重新起播）。设备离线重拉无意义，跳过
          const refreshKey = `${selectedMatch.siteKey}:${activeLine.flag}`;
          const last = tokenRefreshRef.current;
          const mayRefresh =
            !/设备未连接|device offline/i.test(msg) &&
            (!last || last.key !== refreshKey || Date.now() - last.t > 30_000);
          if (mayRefresh) {
            tokenRefreshRef.current = { key: refreshKey, t: Date.now() };
            showToast('线路选集令牌已过期，正在刷新线路重试…', 'info');
            setPlayerLoading(true);
            try {
              const flags = await selectMatch(movieId, selectedMatch, false);
              if (flags?.length) {
                // 重拉会把激活线路重置回第一条。原线路仍在则使用新的 episode token；
                // 原线路消失则降级到同站第一条，并解除历史恢复锁定。
                const idx = flags.findIndex((f) => f.flag === activeLine.flag);
                const nextIndex = idx >= 0 ? idx : 0;
                if (nextIndex > 0) selectFlag(movieId, nextIndex, false);
                const nextFlag = flags[nextIndex];
                const nextEpisode = nextFlag.episodes.find((ep) => ep.number === currentEpisode.number)
                  || nextFlag.episodes[0];
                if (nextEpisode) setCurrentEpisode(nextEpisode);
                if (idx < 0) {
                  failedSourceKeysRef.current.add(`${selectedMatch.siteKey}::${selectedMatch.vodId}::${activeLine.flag}`);
                  patchResource(movieId, {
                    restorePending: undefined, restoredPick: undefined, provisional: true,
                  });
                  showToast('原线路已下线，已切换该站其它线路继续播放', 'info');
                }
                if (!cancelled) setPlayerLoading(false);
                return;
              }
            } catch { /* 重拉失败走下面的错误展示 */ }
          }
          const recovered = /设备未连接|device offline/i.test(msg)
            ? false
            : await autoRecoverRef.current(msg);
          if (!recovered) {
            setPlayerError(
              /设备未连接|device offline/i.test(msg)
                ? '播放设备不在线，打开 App 后点击重试'
                : msg
            );
          }
        }
      } finally {
        if (!cancelled) setPlayerLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (playbackWatchdogRef.current) {
        window.clearTimeout(playbackWatchdogRef.current);
        playbackWatchdogRef.current = null;
      }
    };
  }, [resource?.status, scanGateOpen, currentEpisode?.id, selectedMatch?.siteKey, activeLine?.flag, playNonce]);

  // 未探测线路可能先因无后缀 URL 被误挂到 hls.js；探测稍后确认是文件时仅在尚未
  // 起播的 HLS 实例上重试一次。已经按 .iso 等提示走原生播放时不重载，避免进度归零。
  useEffect(() => {
    const video = videoRef.current;
    if (activeProbeKind !== 'file' || !hlsRef.current || !video || video.readyState > 0) return;
    resumeRef.current = video.currentTime || resumeRef.current;
    setPlayNonce((n) => n + 1);
  }, [activeProbeKind]);

  useEffect(() => () => destroyHls(), [destroyHls]);

  // Resume progress from history if available（换源后集 id 会变，按集数号兜底匹配）
  useEffect(() => {
    const saved =
      watchHistory.find((h) => h.movieId === movieId && h.episodeId === currentEpisode?.id) ||
      (currentEpisode
        ? watchHistory.find((h) => h.movieId === movieId && h.episodeNumber === currentEpisode.number)
        : undefined);
    if (saved && saved.watchedSeconds > 5 && videoRef.current) {
      videoRef.current.currentTime = saved.watchedSeconds;
      setCurrentTime(saved.watchedSeconds);
      showToast(`已为您恢复到上次观看进度：${formatTime(saved.watchedSeconds)}`, 'info');
    }
  }, [movieId, currentEpisode?.id]);

  // Record progress periodically
  useEffect(() => {
    const timer = setInterval(() => {
      if (videoRef.current && !videoRef.current.paused && duration > 0 && currentEpisode) {
        recordWatchProgress(movieId, currentEpisode.id, videoRef.current.currentTime, duration);
      }
    }, 4000);
    return () => clearInterval(timer);
  }, [movieId, currentEpisode?.id, duration, recordWatchProgress]);

  // 大屏下影片信息卡高度与播放器保持一致（宽度/窗口变化时跟随，内容超出时卡内滚动）。
  // 依赖 movie：启动只预载 catalogAll 的 139 部热门片，玩具总动员5 等长尾片进播放页时
  // 首帧 !movie 走加载分支、refs 未挂载，依赖为空会让本效果只跑一次且扑空，详情异步
  // 加载完成后不再同步——信息卡按内容自然高度撑开、超过播放器（齐高失效实例）
  useEffect(() => {
    const player = playerContainerRef.current;
    const info = infoRef.current;
    if (!player || !info || typeof ResizeObserver === 'undefined') return;
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => {
      // 仅大屏左右并排时齐高；移动端信息区在播放器下方独立成块，清掉内联高度防误压缩
      info.style.height = mq.matches ? `${player.offsetHeight}px` : '';
    };
    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(player);
    mq.addEventListener('change', apply);
    return () => {
      ro.disconnect();
      mq.removeEventListener('change', apply);
      info.style.height = '';
    };
  }, [movie?.id]);

  // Control auto-hide
  const handleMouseMove = useCallback(() => {
    setShowControls(true);
    if (controlsTimeoutRef.current) {
      window.clearTimeout(controlsTimeoutRef.current);
    }
    controlsTimeoutRef.current = window.setTimeout(() => {
      if (isPlaying) {
        setShowControls(false);
      }
    }, 3500);
  }, [isPlaying]);

  const handlePlayPause = () => {
    if (!videoRef.current) return;
    if (videoRef.current.paused) {
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      videoRef.current.pause();
      setIsPlaying(false);
    }
  };

  // 移动端点击画面只切换控制栏显隐，播放/暂停只由明确的播放按钮触发。
  const handlePlayerSurfaceClick = () => {
    if (!mobilePlayer) {
      handlePlayPause();
      handleMouseMove();
      return;
    }
    if (controlsTimeoutRef.current) {
      window.clearTimeout(controlsTimeoutRef.current);
      controlsTimeoutRef.current = null;
    }
    setShowControls((visible) => !visible);
  };

  const handleTimeUpdate = () => {
    if (videoRef.current) {
      setCurrentTime(videoRef.current.currentTime);
    }
  };

  // 追踪当前播放位置所在缓冲区间的末端，用于进度条展示已缓冲长度
  const handleProgress = () => {
    const video = videoRef.current;
    if (!video || !isFinite(video.duration) || video.duration <= 0) return;
    const t = video.currentTime;
    for (let i = 0; i < video.buffered.length; i++) {
      if (video.buffered.start(i) <= t && t <= video.buffered.end(i)) {
        setBufferedEnd(video.buffered.end(i));
        return;
      }
    }
  };

  const handleLoadedMetadata = () => {
    if (videoRef.current) {
      setDuration(videoRef.current.duration || 100);
      videoRef.current.volume = volume;
      videoRef.current.playbackRate = playbackRate;
      // 换源携带的播放位置（同片不同源内容一致，可安全跳转）
      const resume = resumeRef.current;
      if (resume > 5 && isFinite(videoRef.current.duration) && resume < videoRef.current.duration - 10) {
        videoRef.current.currentTime = resume;
        setCurrentTime(resume);
      }
      resumeRef.current = 0;
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newTime = parseFloat(e.target.value);
    if (videoRef.current) {
      videoRef.current.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleSkip = (seconds: number) => {
    if (videoRef.current) {
      const nextTime = Math.max(0, Math.min(duration, videoRef.current.currentTime + seconds));
      videoRef.current.currentTime = nextTime;
      setCurrentTime(nextTime);
    }
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseFloat(e.target.value);
    setVolume(val);
    if (val > 0) localStorage.setItem('cine.volume', String(val));
    if (videoRef.current) {
      videoRef.current.volume = val;
      videoRef.current.muted = val === 0;
      setIsMuted(val === 0);
    }
  };

  const handleToggleMute = () => {
    const video = videoRef.current;
    // 静音态（含音量为 0）点击恢复上次音量，非静音态点击则记住当前音量并静音
    if (isMuted || volume === 0) {
      const restore = volume > 0 ? volume : lastVolumeRef.current || 1;
      setVolume(restore);
      setIsMuted(false);
      if (video) {
        video.muted = false;
        video.volume = restore;
      }
    } else {
      lastVolumeRef.current = volume;
      setIsMuted(true);
      if (video) video.muted = true;
    }
  };

  const handleRateChange = (rate: number) => {
    setPlaybackRate(rate);
    if (videoRef.current) {
      videoRef.current.playbackRate = rate;
    }
    showToast(`倍速已调整为 ${rate}x`, 'info');
  };

  const [orientation, setOrientation] = useState<OrientationLock>('landscape');

  const handleToggleFullscreen = () => {
    if (!playerContainerRef.current) return;
    if (!document.fullscreenElement) {
      playerContainerRef.current.requestFullscreen().then(() => {
        setIsFullscreen(true);
        // 手机上全屏默认横屏（桌面引擎窗口已够宽无需旋转；Screen Orientation lock 仅移动端全屏生效）
        if (isMobileDevice()) {
          setOrientation('landscape');
          lockOrientation('landscape');
        }
      }).catch(() => {});
    } else {
      document.exitFullscreen().then(() => {
        setIsFullscreen(false);
        unlockOrientation();
      }).catch(() => {});
    }
  };

  // 系统手势或浏览器按钮也可能退出全屏，始终以真实全屏元素同步 UI 和外框样式。
  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreen = document.fullscreenElement === playerContainerRef.current;
      setIsFullscreen(fullscreen);
      if (!document.fullscreenElement) unlockOrientation();
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  // 全屏内切换横竖屏（仅移动端显示）
  const handleRotateOrientation = () => {
    const next: OrientationLock = orientation === 'landscape' ? 'portrait' : 'landscape';
    setOrientation(next);
    lockOrientation(next);
    showToast(next === 'landscape' ? '已切换为横屏' : '已切换为竖屏', 'info');
  };

  const handleSwitchEpisode = (ep: Episode) => {
    if (ep.id === currentEpisode?.id) return;
    setCurrentEpisode(ep);
    setCurrentTime(0);
    if (videoRef.current) {
      videoRef.current.currentTime = 0;
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    }
    showToast(`已切换至《${ep.title}》`, 'info');
  };

  const handleEnded = () => {
    setIsPlaying(false);
    setBuffering(false);
    if (!currentEpisode) return;
    const idx = episodes.findIndex((e) => e.id === currentEpisode.id);
    const next = episodes[idx + 1];
    if (next) {
      showToast('本集播放完毕，自动播放下一集', 'info');
      handleSwitchEpisode(next);
    } else {
      showToast('全片播放完毕', 'info');
    }
  };

  // ---- 智能选源 ----

  const flagResult = (flag: string) =>
    scan?.results.find((r) => r.siteKey === resource?.selected?.siteKey && !!r.flag && r.flag === flag);

  // 推荐线路：时长异常绝对沉底，再按可播性/清晰度/速度排序，最多 3 条；
  // 不排除当前线路——它排进前 3 时在卡片右侧标记已选择
  const topLines = (scan?.results || [])
    .filter((r) => r.status === 'ok' && r.flag && r.metrics)
    .sort(compareRecommended)
    .slice(0, 3);

  // 播放器下方加载提示：聚合所有进行中的加载动作（搜索站点/获取选集/智能测速/补充探测/
  // 懒补测/解析播放地址），逐条展示动画与友好文案，用户始终知道系统在忙什么
  const busyHints: string[] = [];
  if (resource?.status === 'searching') busyHints.push('正在设备站点中搜索片源，找到后自动进入测速选源…');
  if (resource?.status === 'selecting')
    busyHints.push(`正在「${resource.selected?.siteName || '来源站点'}」获取线路与选集…`);
  if (scan?.status === 'running')
    busyHints.push(
      scan.extending
        ? `正在补充探测其余站点的线路（已测 ${scan.finished}/${scan.total || '…'} 条），结果实时并入推荐`
        : `正在智能测速选源（已测 ${scan.finished}/${scan.total || '…'} 条），选出较快线路后自动播放`
    );
  if (probingSites.size > 0) {
    const names = (resource?.matches || [])
      .filter((m) => probingSites.has(m.siteKey))
      .map((m) => m.siteName)
      .slice(0, 3)
      .join('、');
    busyHints.push(`正在补测 ${probingSites.size} 个站点的线路${names ? `：${names}${probingSites.size > 3 ? ' 等' : ''}` : ''}…`);
  }
  if (playerLoading && scanGateOpen && !playerError && resource?.status === 'ready')
    busyHints.push('正在解析播放地址…');
  if (autoRecovering) busyHints.push('当前线路失效，正在自动寻找可用线路…');

  const applySource = async (siteKey: string, flag: string | undefined, manual = true): Promise<boolean> => {
    if (!resource) return false;
    // 同站点换线路：直接切 flag（探测只覆盖每站前 8 条，未探测到的线路走下面的重新拉详情）
    if (siteKey === resource.selected?.siteKey && flag !== undefined) {
      const idx = resource.flags.findIndex((f) => f.flag === flag);
      if (idx >= 0) {
        if (idx !== resource.activeFlagIndex) {
          const pos = videoRef.current?.currentTime || 0;
          if (pos > 5) resumeRef.current = pos;
          patchResource(movieId, { restorePending: undefined, restoredPick: undefined });
          selectFlag(movieId, idx, manual);
        }
        return true;
      }
    }
    const match = resource.matches.find((m) => m.siteKey === siteKey);
    if (!match) return false;
    const pos = videoRef.current?.currentTime || 0;
    if (pos > 5) resumeRef.current = pos;
    const flags = await selectMatch(movieId, match, manual);
    if (!flags?.length) return false;
    const idx = flag ? (flags || []).findIndex((f) => f.flag === flag) : 0;
    if (idx < 0) return false;
    patchResource(movieId, { restorePending: undefined, restoredPick: undefined });
    selectFlag(movieId, idx, manual);
    return true;
  };
  applySourceRef.current = applySource;

  // 播放失败自动自愈：按推荐顺序逐个验证已探测候选（单轮最多 4 条）；扫描尚未
  // 产出候选则等待，候选耗尽后仅强制实时重搜一次，防止坏源造成无限循环。
  const autoRecover = async (reason: string, markCurrent = true): Promise<boolean> => {
    if (recoveryBusyRef.current || !resource) return recoveryBusyRef.current;
    const selected = resource.selected;
    const line = resource.flags[resource.activeFlagIndex] || resource.flags[0];
    if (markCurrent && selected && line) {
      failedSourceKeysRef.current.add(`${selected.siteKey}::${selected.vodId}::${line.flag}`);
    }
    const pos = videoRef.current?.currentTime || currentTime;
    if (pos > 5) resumeRef.current = pos;
    patchResource(movieId, { restorePending: undefined, restoredPick: undefined });
    patchScan(movieId, { switched: true });
    setPlayerError('');

    const candidates = (scan?.results || [])
      .filter((r) => r.status === 'ok' && r.flag && r.metrics)
      .sort(compareRecommended)
      .filter((r) => !failedSourceKeysRef.current.has(`${r.siteKey}::${r.vodId}::${r.flag}`))
      .slice(0, 4);

    if (candidates.length) {
      recoveryBusyRef.current = true;
      setAutoRecovering(true);
      setRecoveryPending('');
      try {
        for (const candidate of candidates) {
          const ok = await applySource(candidate.siteKey, candidate.flag, false);
          if (ok) {
            patchResource(movieId, { provisional: scan?.status === 'running' || undefined });
            showToast(`当前线路失效，已自动切换：${candidate.siteName} · ${candidate.flag}`, 'info');
            setPlayerLoading(true);
            return true;
          }
          failedSourceKeysRef.current.add(`${candidate.siteKey}::${candidate.vodId}::${candidate.flag}`);
        }
      } finally {
        recoveryBusyRef.current = false;
      }
    }

    if (scan?.status === 'running') {
      setRecoveryPending(reason || '当前线路失效');
      setAutoRecovering(true);
      return true;
    }

    if (!freshRecoveryAttemptedRef.current) {
      freshRecoveryAttemptedRef.current = true;
      recoveryBusyRef.current = true;
      setAutoRecovering(true);
      setRecoveryPending('');
      showToast('缓存线路均已失效，正在从 App 实时重新搜索', 'info');
      try {
        await restartResourceSearch(movieId);
        return true;
      } catch {
        return false;
      } finally {
        recoveryBusyRef.current = false;
        setAutoRecovering(false);
      }
    }

    setAutoRecovering(false);
    setRecoveryPending('');
    return false;
  };
  autoRecoverRef.current = autoRecover;

  // 缓存详情在进入播放页时已全部失效：不等用户操作，立即走第三级恢复。
  useEffect(() => {
    if (!resource?.needsFreshSearch || freshRecoveryAttemptedRef.current) return;
    void autoRecoverRef.current(resource.error || '缓存来源失效', false);
  }, [resource?.needsFreshSearch, resource?.error, movieId]);

  // 当前坏线失败得早、扫描结果来得晚时，随着结果渐进到达继续自动挑下一条。
  useEffect(() => {
    if (!recoveryPending) return;
    void autoRecoverRef.current(recoveryPending, false).then((recovered) => {
      if (!recovered) setPlayerError(`${recoveryPending}，且未找到其它可用线路`);
    });
  }, [recoveryPending, scan?.finished, scan?.status]);

  const handlePlaying = () => {
    setIsPlaying(true);
    setBuffering(false);
    setAutoRecovering(false);
    setRecoveryPending('');
    const selected = resource?.selected;
    if (selected && activeLine) {
      failedSourceKeysRef.current.delete(`${selected.siteKey}::${selected.vodId}::${activeLine.flag}`);
      const restoreKey = `${selected.siteKey}::${selected.vodId}::${activeLine.flag}`;
      if (resource?.restorePending && restoreConfirmedKeyRef.current !== restoreKey) {
        restoreConfirmedKeyRef.current = restoreKey;
        confirmRestoredSource(movieId);
        showToast('已恢复上次观看的来源和线路', 'info');
      }
    }
  };

  const handleVideoError = () => {
    const video = videoRef.current;
    if (!video?.currentSrc || recoveryBusyRef.current) return;
    const message = video.error?.message || '该线路媒体加载失败';
    void autoRecoverRef.current(message).then((recovered) => {
      if (!recovered) setPlayerError(`${message}，请手动更换线路`);
    });
  };

  // Keyboard controls
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't trigger if user is typing in an input
      if (['input', 'textarea'].includes((e.target as HTMLElement)?.tagName?.toLowerCase())) {
        return;
      }
      if (e.key === ' ') {
        e.preventDefault();
        handlePlayPause();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        handleSkip(10);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        handleSkip(-10);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setVolume((v) => {
          const nv = Math.min(1, Math.round((v + 0.1) * 100) / 100);
          if (videoRef.current) {
            videoRef.current.volume = nv;
            videoRef.current.muted = false; // 调大声视为解除静音
          }
          if (nv > 0) localStorage.setItem('cine.volume', String(nv));
          setIsMuted(false);
          return nv;
        });
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setVolume((v) => {
          const nv = Math.max(0, Math.round((v - 0.1) * 100) / 100);
          if (videoRef.current) videoRef.current.volume = nv;
          if (nv > 0) localStorage.setItem('cine.volume', String(nv));
          setIsMuted(nv === 0);
          return nv;
        });
      } else if (e.key.toLowerCase() === 'f') {
        e.preventDefault();
        handleToggleFullscreen();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handlePlayPause, handleSkip, handleToggleFullscreen]);

  function formatTime(secs: number) {
    if (isNaN(secs)) return '00:00';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    if (h > 0) {
      return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    }
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  const progressPercent = duration > 0 ? (currentTime / duration) * 100 : 0;
  // 缓冲区可能落后于播放位置（拖进度条后），取两者较大值避免渐变色带倒序
  const bufferedEdge = Math.min(100, Math.max(progressPercent, duration > 0 ? (bufferedEnd / duration) * 100 : 0));

  const renderPlayerOverlay = () => {
    if (resource?.status === 'searching' || resource?.status === 'selecting' || (!resource && playerLoading)) {
      return (
        <div className="absolute inset-0 z-20 bg-black/60 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-300">
            {resource?.status === 'selecting' ? '正在获取线路与选集...' : '正在设备站点中搜索资源...'}
          </p>
        </div>
      );
    }
    if (resource?.status === 'offline') {
      return (
        <div className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3">
          <WifiOff className="w-12 h-12 text-rose-400" />
          <p className="text-sm text-zinc-200">播放设备不在线</p>
          <p className="text-xs text-zinc-500">打开电视端 App 后点击重试</p>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => resolveResources(movieId)}
              className="px-5 py-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold"
            >
              重试
            </button>
            <button
              onClick={() => navigateTo('detail', { movieId })}
              className="px-5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
            >
              返回详情
            </button>
          </div>
        </div>
      );
    }
    if (resource?.status === 'error') {
      return (
        <div className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3">
          <WifiOff className="w-12 h-12 text-rose-400" />
          <p className="text-sm text-zinc-200">{resource.error || '资源解析失败'}</p>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => resolveResources(movieId)}
              className="px-5 py-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold"
            >
              重试
            </button>
            <button
              onClick={() => navigateTo('detail', { movieId })}
              className="px-5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
            >
              返回详情
            </button>
          </div>
        </div>
      );
    }
    if (resource?.status === 'noresult') {
      return (
        <div onClick={() => navigateTo('detail', { movieId })} className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3 cursor-pointer">
          <SearchX className="w-12 h-12 text-zinc-500" />
          <p className="text-sm text-zinc-200">暂无播放资源</p>
          <p className="text-xs text-zinc-500">点击返回详情页</p>
        </div>
      );
    }
    // 首次加载等待扫描：出现较快线路即自动播放，全部完成后自动切最优
    if (!scanGateOpen) {
      return (
        <div className="absolute inset-0 z-20 bg-black/60 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-300">正在智能测速选源，选出较快线路后自动播放</p>
          {scan && (
            <p className="text-xs text-zinc-500 font-mono tabular-nums">
              {scan.finished}/{scan.total || '…'} 条线路
            </p>
          )}
        </div>
      );
    }
    if (autoRecovering) {
      return (
        <div className="absolute inset-0 z-20 bg-black/60 flex flex-col items-center justify-center gap-3 px-6 text-center">
          <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-300">当前线路失效，正在自动寻找可用线路...</p>
        </div>
      );
    }
    if (playerLoading) {
      return (
        <div className="absolute inset-0 z-20 bg-black/60 flex flex-col items-center justify-center gap-3">
          <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-300">正在解析播放地址...</p>
        </div>
      );
    }
    if (playerError) {
      return (
        <div className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3">
          <X className="w-12 h-12 text-rose-400" />
          <p className="text-sm text-rose-200 text-center max-w-[80%]">{playerError}</p>
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => { setPlayerError(''); setPlayNonce((n) => n + 1); }}
              className="px-5 py-2 rounded-full bg-emerald-500 hover:bg-emerald-400 text-black text-xs font-bold"
            >
              重试播放
            </button>
            <button
              onClick={() => navigateTo('detail', { movieId })}
              className="px-5 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-200"
            >
              返回详情更换来源
            </button>
          </div>
        </div>
      );
    }
    if (!mobilePlayer && !isPlaying && !buffering) {
      return (
        <div
          onClick={handlePlayPause}
          className="absolute inset-0 z-20 bg-black/40 flex items-center justify-center cursor-pointer transition-all"
        >
          <div className="w-12 h-12 sm:w-16 sm:h-16 md:w-20 md:h-20 rounded-full bg-emerald-500/90 text-black flex items-center justify-center shadow-2xl hover:scale-110 transition-transform">
            <Play className="w-5 h-5 sm:w-7 sm:h-7 md:w-9 md:h-9 fill-black ml-0.5 sm:ml-1" />
          </div>
        </div>
      );
    }
    return null;
  };

  if (!movie) {
    return (
      <div className="py-40 flex flex-col items-center justify-center space-y-4">
        <Loader2 className="w-10 h-10 text-emerald-400 animate-spin" />
        <p className="text-sm text-zinc-400">正在加载影片...</p>
      </div>
    );
  }

  return (
    <div id="watch-view" className="space-y-6 pb-20 animate-fade-blur">
      {/* Top breadcrumb & back */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            onClick={goBack}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-zinc-900/80 hover:bg-zinc-800 text-xs text-zinc-300 hover:text-white border border-zinc-800 transition-colors"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>返回</span>
          </button>
          <span className="text-xs text-zinc-500">/</span>
          <span className="text-xs text-emerald-400 font-bold truncate max-w-[200px] sm:max-w-none">
            {movie.title}{currentEpisode && movie.type !== 'movie' ? ` - ${currentEpisode.title}` : ''}
          </span>
        </div>
      </div>

      {/* Main Cinema Stage：大屏播放器与影片信息左右并排（移动端上下堆叠），选源与选集在下方全宽 */}
      <div className="space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-start gap-4">
          {/* Custom HTML5 Video Player Container */}
          <div
            ref={playerContainerRef}
            onMouseMove={mobilePlayer ? undefined : handleMouseMove}
            onMouseLeave={mobilePlayer ? undefined : () => isPlaying && setShowControls(false)}
            id="cine-video-player"
            className={`relative w-full lg:flex-1 lg:min-w-0 aspect-video overflow-hidden bg-black group select-none ${
              mobilePlayer && isFullscreen
                ? 'rounded-none border-0 shadow-none'
                : 'rounded-3xl border border-zinc-800/80 shadow-2xl'
            }`}
            style={{
              boxShadow: mobilePlayer && isFullscreen
                ? 'none'
                : 'rgba(0, 0, 0, 0.8) 0px 30px 60px -12px, rgba(16, 185, 129, 0.2) 0px 0px 0px 1px',
            }}
          >
            {/* HTML5 Video Element（源由播放地址解析后挂载） */}
            <video
              ref={videoRef}
              poster={movie.backdrop || movie.cover}
              onClick={handlePlayerSurfaceClick}
              onTimeUpdate={handleTimeUpdate}
              onProgress={handleProgress}
              onLoadedMetadata={handleLoadedMetadata}
              onError={handleVideoError}
              onWaiting={() => setBuffering(true)}
              onPlaying={handlePlaying}
              onCanPlay={() => setBuffering(false)}
              onPause={() => setIsPlaying(false)}
              onSeeking={() => setBuffering(true)}
              onSeeked={() => setBuffering(false)}
              onEnded={handleEnded}
              playsInline
              className="w-full h-full object-contain cursor-pointer bg-black"
            />

            {/* Dynamic status overlays */}
            {renderPlayerOverlay()}

            {/* 移动端防误触锁定：右侧垂直居中，并与控制栏一起由播放器点击切换显隐；
                锁定后覆盖层拦截其它交互，仅解锁按钮仍可点击。 */}
            {mobilePlayer && (
              <button
                onClick={() => setControlsLocked((v) => !v)}
                title={controlsLocked ? '解锁播放器操作' : '锁定播放器操作'}
                className={`absolute right-3 top-1/2 -translate-y-1/2 z-50 w-9 h-9 rounded-full flex items-center justify-center text-white/90 drop-shadow-[0_1px_3px_rgba(0,0,0,0.9)] transition-opacity duration-300 ${
                  showControls ? 'opacity-100' : 'opacity-0 pointer-events-none'
                }`}
              >
                {controlsLocked
                  ? <LockOpen className="w-4 h-4" />
                  : <Lock className="w-4 h-4" />}
              </button>
            )}
            {controlsLocked && (
              <div
                className="absolute inset-0 z-40"
                onClick={handlePlayerSurfaceClick}
              />
            )}

            {/* 视频缓冲加载动画（起播 / 卡顿 / 拖动进度条时） */}
            {buffering && !playerError && (
              <div className="absolute inset-0 z-20 flex items-center justify-center pointer-events-none">
                <div className="absolute inset-0 bg-black/30" />
                <div className="relative flex flex-col items-center gap-3">
                  <div className="w-12 h-12 sm:w-14 sm:h-14 border-[3px] border-emerald-500/25 border-t-emerald-400 rounded-full animate-spin" />
                  <span className="text-xs text-zinc-300 font-sans-modern">视频加载中...</span>
                </div>
              </div>
            )}

            {/* Controls Bar Overlay (Fades out when inactive；锁定时整体隐藏防误触) */}
            <div
              className={`absolute inset-x-0 bottom-0 z-30 bg-gradient-to-t from-black/95 via-black/70 to-transparent p-2.5 sm:p-4 md:p-6 pb-2.5 sm:pb-4 transition-opacity duration-300 ${
                controlsLocked
                  ? 'opacity-0 pointer-events-none'
                  : showControls
                    ? 'opacity-100'
                    : 'opacity-0 pointer-events-none'
              }`}
            >
              {/* Timeline Scrubber */}
              <div className="relative group/scrubber mb-1.5 sm:mb-3 cursor-pointer">
                <input
                  type="range"
                  min={0}
                  max={duration || 100}
                  step={0.1}
                  value={currentTime}
                  onChange={handleSeek}
                  className="w-full h-1.5 hover:h-2.5 bg-zinc-700/80 rounded-lg appearance-none cursor-pointer accent-emerald-400 transition-all"
                  style={{
                    background: `linear-gradient(to right, #10b981 0%, #10b981 ${progressPercent}%, rgba(16, 185, 129, 0.35) ${progressPercent}%, rgba(16, 185, 129, 0.35) ${bufferedEdge}%, #3f3f46 ${bufferedEdge}%)`,
                  }}
                />
              </div>

              {/* Bottom Controls Row */}
              <div className="flex items-center justify-between text-zinc-100 gap-1.5 sm:gap-3 flex-nowrap">
                {/* Left controls */}
                <div className="flex items-center gap-1 sm:gap-2.5 min-w-0 flex-shrink">
                  <button
                    onClick={handlePlayPause}
                    className="p-1 sm:p-1.5 rounded-full hover:bg-white/10 text-zinc-200 hover:text-emerald-400 transition-colors"
                    title={isPlaying ? '暂停 (Space)' : '播放 (Space)'}
                  >
                    {isPlaying ? <Pause className="w-4 h-4 sm:w-5 sm:h-5" /> : <Play className="w-4 h-4 sm:w-5 sm:h-5 fill-current" />}
                  </button>

                  <button
                    onClick={() => handleSkip(-10)}
                    className="p-1 sm:p-1.5 rounded-full hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                    title="后退 10 秒"
                  >
                    <RotateCcw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  </button>

                  <button
                    onClick={() => handleSkip(10)}
                    className="p-1 sm:p-1.5 rounded-full hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                    title="快进 10 秒"
                  >
                    <RotateCw className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                  </button>

                  {/* Volume Group：滑杆悬停展开并显示百分比，图标随音量分档 */}
                  <div className="flex items-center gap-1 sm:gap-2 group/volume">
                    <button
                      onClick={handleToggleMute}
                      className="p-1 sm:p-1.5 rounded-full hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                      title={isMuted || volume === 0 ? '取消静音' : '静音（↑↓ 调节音量）'}
                    >
                      {isMuted || volume === 0 ? (
                        <VolumeX className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-rose-400" />
                      ) : volume < 0.5 ? (
                        <Volume1 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      ) : (
                        <Volume2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
                      )}
                    </button>
                    <input
                      type="range"
                      min={0}
                      max={1}
                      step={0.01}
                      value={isMuted ? 0 : volume}
                      onChange={handleVolumeChange}
                      className="volume-slider hidden sm:block h-1 rounded-lg appearance-none cursor-pointer opacity-70 transition-all duration-200 w-14 md:w-16"
                      style={{
                        background: `linear-gradient(to right, #10b981 ${(isMuted ? 0 : volume) * 100}%, #3f3f46 ${(isMuted ? 0 : volume) * 100}%)`,
                      }}
                    />
                    <span className="volume-pct hidden sm:block w-7 text-[10px] font-mono text-zinc-400 text-right tabular-nums opacity-0 transition-opacity duration-200">
                      {Math.round((isMuted ? 0 : volume) * 100)}
                    </span>
                  </div>

                  {/* Time Code */}
                  <div className="text-[11px] sm:text-xs font-mono text-zinc-300 ml-0.5 sm:ml-1 whitespace-nowrap flex-shrink-0">
                    <span>{formatTime(currentTime)}</span>
                    <span className="text-zinc-500 mx-0.5 sm:mx-1">/</span>
                    <span className="text-zinc-400">{formatTime(duration)}</span>
                  </div>
                </div>

                {/* Right controls */}
                <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
                  {/* 屏幕旋转：仅移动端全屏时显示（Screen Orientation lock 只在全屏下生效） */}
                  {isMobileDevice() && isFullscreen && (
                    <button
                      onClick={handleRotateOrientation}
                      className="p-1 sm:p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                      title={orientation === 'landscape' ? '切换为竖屏' : '切换为横屏'}
                    >
                      <Smartphone className={`w-3.5 h-3.5 sm:w-4 sm:h-4 transition-transform ${orientation === 'landscape' ? 'rotate-90' : ''}`} />
                    </button>
                  )}
                  {/* Fullscreen Toggle */}
                  <button
                    onClick={handleToggleFullscreen}
                    className="p-1 sm:p-1.5 rounded-lg hover:bg-white/10 text-zinc-300 hover:text-white transition-colors"
                    title={isFullscreen ? '退出全屏 (F)' : '全屏 (F)'}
                  >
                    {isFullscreen ? <Minimize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> : <Maximize2 className="w-3.5 h-3.5 sm:w-4 sm:h-4" />}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Video Title & Primary Info（大屏在播放器右侧，高度跟随播放器） */}
          <aside
            ref={infoRef}
            className="w-full lg:w-72 xl:w-80 lg:shrink-0 lg:sticky lg:top-20 rounded-3xl bg-zinc-900/60 border border-zinc-800 p-4 sm:p-5 flex flex-col gap-4 lg:overflow-hidden"
          >
            <div className="min-w-0 shrink-0">
              <h1 className="text-2xl sm:text-3xl lg:text-xl xl:text-2xl font-instrument-serif font-normal text-white break-words">
                {movie.title}{currentEpisode && movie.type !== 'movie' ? ` • ${currentEpisode.title}` : ''}
              </h1>
              <p className="text-xs sm:text-sm text-zinc-400 mt-1.5">
                {[movie.year, movie.genres.filter(Boolean).join(' / '), movie.director !== '未知' ? `导演：${movie.director}` : '']
                  .filter(Boolean).join(' • ')}
                {selectedMatch && <span className="text-zinc-500"> • 来源：{selectedMatch.siteName}</span>}
              </p>
            </div>

            <div className="space-y-4 lg:flex-1 lg:min-h-0 lg:overflow-y-auto">
              {/* 主要演员 */}
              {movie.cast.length > 0 && (
                <div className="space-y-2">
                  <p className="text-[10px] font-bold text-zinc-500 tracking-wide">主要演员</p>
                  <div className="flex flex-wrap gap-1.5">
                    {movie.cast.slice(0, 8).map((c) => (
                      <span
                        key={`${c.name}-${c.role}`}
                        title={c.name}
                        className="px-2 py-1 rounded-lg bg-zinc-800/70 border border-zinc-700/60 text-[11px] text-zinc-300"
                      >
                        {c.name}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {movie.description && (
                <p className="text-xs sm:text-sm text-zinc-300 leading-relaxed font-light font-sans-modern line-clamp-4 lg:line-clamp-none">
                  {movie.description}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2.5 flex-wrap shrink-0">
              <button
                onClick={() => toggleFavorite(movie.id)}
                className={`flex items-center gap-1.5 px-4 py-2 rounded-full border text-xs font-semibold whitespace-nowrap shrink-0 transition-all ${
                  favorited
                    ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    : 'bg-zinc-800 text-zinc-300 border-zinc-700 hover:text-white'
                }`}
              >
                <Bookmark className={`w-3.5 h-3.5 ${favorited ? 'fill-amber-300' : ''}`} />
                <span>{favorited ? '已收藏' : '收藏'}</span>
              </button>

              <button
                onClick={() => {
                  navigator.clipboard?.writeText(window.location.href);
                  showToast('播放链接已复制', 'success');
                }}
                className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold whitespace-nowrap shrink-0 border border-zinc-700 transition-colors"
              >
                <Share2 className="w-3.5 h-3.5" />
                <span>分享</span>
              </button>
            </div>
          </aside>
        </div>

        {/* 加载状态汇总（播放器正下方）：任何进行中的加载动作都在这里展示动画与友好提示，
            测速/补充探测进行中附带进度条 */}
        {busyHints.length > 0 && (
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3 space-y-2.5">
            {busyHints.map((h) => (
              <div key={h} className="flex items-center gap-2.5 min-w-0">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400 shrink-0" />
                <p className="text-xs text-zinc-300 truncate">{h}</p>
              </div>
            ))}
            {scan?.status === 'running' && (
              <div className="h-1.5 rounded-full bg-zinc-800/80 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-emerald-500 to-emerald-400 rounded-full transition-all duration-500"
                  style={{ width: scan.total ? `${Math.min(100, (scan.finished / scan.total) * 100)}%` : '8%' }}
                />
              </div>
            )}
          </div>
        )}

        {/* 播放源与选集（原详情页功能移入）：当前线路按钮 + 选集按钮 */}
          <div className="rounded-3xl bg-zinc-900/60 border border-zinc-800 p-4 sm:p-5 space-y-4">
            <div className="space-y-2.5">
              {/* 当前线路：独立分区标题，与推荐线路/选集区分 */}
              <div className="flex items-center gap-1.5 px-1 text-xs font-bold text-zinc-200">
                <Signal className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                当前线路
                <span className="text-[10px] font-normal text-zinc-500 truncate">点击卡片可查看全部线路并更换</span>
              </div>
              <button
                onClick={() => setSourceModalOpen(true)}
                className="w-full flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 rounded-2xl border border-zinc-700/80 bg-zinc-800/60 hover:bg-zinc-700/60 hover:border-zinc-600 px-4 py-3 transition-colors text-left"
              >
                <span className="min-w-0 block text-sm font-bold text-zinc-100 truncate">
                  {selectedMatch
                    ? `${selectedMatch.siteName}${activeLine?.flag ? ` · ${activeLine.flag}` : ' 选择线路'}`
                    : resource?.matches?.length
                      ? `已找到 ${resource.matches.length} 个来源，点击查看`
                      : '正在搜索来源…'}
                </span>
                <span className="flex items-center gap-2.5 shrink-0 sm:justify-end">
                  {(() => {
                    const r = flagResult(activeLine?.flag || '');
                    if (r && r.status === 'ok' && r.metrics) return <MetricBadges metrics={r.metrics} />;
                    if (r?.status === 'fail') return <span className="text-[10px] font-bold text-rose-400/90">✕ 探测失败</span>;
                    return scan?.status === 'running' ? (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-500 whitespace-nowrap">
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" /> 待测速
                      </span>
                    ) : null;
                  })()}
                  <ListVideo className="w-4 h-4 text-zinc-400" />
                </span>
              </button>

              {/* 扫描进度与选集获取提示已上移到播放器下方的加载状态条 */}
              {scan && scan.status === 'done' && (
                <div className="flex items-center justify-between gap-2 text-[11px] px-1">
                  <span className="text-zinc-500 shrink-0">
                    {scan.stoppedEarly ? '测速完成 · 已锁定高质量线路' : '测速完成'}
                  </span>
                  <span className="text-zinc-400 truncate">
                    已测 {scan.results.length} 条，{scan.results.filter((r) => r.status === 'ok' && r.flag).length} 条可用
                    {scan.stoppedEarly ? ' · 其余站点可在全部线路中补测' : ' · 全部线路点击上方按钮'}
                  </span>
                </div>
              )}

              {/* 资源状态：失败可重试 / 该来源无选集（不再静默空白；获取中提示在播放器下方加载条） */}
              {resource?.status === 'error' && (
                <div className="flex items-center justify-between gap-2 text-[11px] px-1">
                  <span className="text-rose-300/80 truncate">线路获取失败：{resource.error || '未知错误'}</span>
                  <button
                    onClick={() => {
                      if (resource.selected) selectMatch(movieId, resource.selected);
                      else resolveResources(movieId);
                    }}
                    className="text-emerald-400 hover:text-emerald-300 shrink-0 font-semibold"
                  >
                    重试
                  </button>
                </div>
              )}
              {resource?.status === 'ready' && episodes.length === 0 && (
                <div className="flex items-center justify-between gap-2 text-[11px] px-1">
                  <span className="text-amber-300/80 truncate">该来源没有可用选集</span>
                  <button onClick={() => setSourceModalOpen(true)} className="text-emerald-400 hover:text-emerald-300 shrink-0 font-semibold">
                    换个来源
                  </button>
                </div>
              )}
            </div>

            {/* 推荐线路：测速结果实时排序（含扫描中），最多 3 条免弹窗直达切换 */}
            {topLines.length > 0 && (
              <div className="space-y-2 border-t border-zinc-800/80 pt-3.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <span className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 min-w-0">
                    <Zap className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                    推荐线路
                    <span className="text-[10px] font-normal text-zinc-500 truncate">点击直接切换，无需打开列表</span>
                  </span>
                  <span className="text-[10px] text-zinc-500 shrink-0 whitespace-nowrap">
                    {scan?.status === 'running'
                      ? '测速中 · 实时更新'
                      : `清晰度优先排序 · 共 ${scan!.results.filter((r) => r.status === 'ok' && r.flag).length} 条可用`}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                  {topLines.map((r, i) => {
                    const active = r.siteKey === selectedMatch?.siteKey && r.flag === activeLine?.flag;
                    return (
                      <button
                        key={scanResultKey(r)}
                        onClick={() => !active && applySource(r.siteKey, r.flag)}
                        title={active ? `当前线路：${r.siteName} · ${r.flag}` : `切换到 ${r.siteName} · ${r.flag}${i === 0 ? '（综合最佳）' : ''}`}
                        className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border transition-colors text-left ${
                          active
                            ? 'bg-emerald-500/10 border-emerald-500/60 cursor-default'
                            : 'bg-zinc-800/50 border-zinc-700/70 hover:bg-zinc-700/50 hover:border-emerald-500/50'
                        }`}
                      >
                        <span className="flex-1 flex flex-col gap-1.5 min-w-0">
                          <span className="flex items-center gap-2 min-w-0">
                            <span
                              className={`w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black leading-none shrink-0 ${
                                i === 0
                                  ? 'bg-amber-500/20 text-amber-300 border border-amber-500/50'
                                  : 'bg-zinc-900 text-zinc-500 border border-zinc-700'
                              }`}
                            >
                              {i + 1}
                            </span>
                            <span className="text-xs font-semibold text-zinc-200 truncate">
                              {r.siteName}
                              <span className="text-zinc-500 font-normal"> · {r.flag}</span>
                            </span>
                          </span>
                          <MetricBadges metrics={r.metrics!} />
                        </span>
                        {active && (
                          <span
                            className="w-5 h-5 rounded-full bg-emerald-500 text-black flex items-center justify-center shrink-0"
                            title="当前播放线路"
                          >
                            <Check className="w-3 h-3" strokeWidth={3} />
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* 选集：标题分隔，与上方线路/推荐线路区分 */}
            {episodes.length > 0 && (
              <div className="space-y-2.5 border-t border-zinc-800/80 pt-3.5">
                <div className="flex items-center justify-between gap-2 px-1">
                  <span className="flex items-center gap-1.5 text-xs font-bold text-zinc-200 min-w-0">
                    <Film className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                    选集
                    <span className="text-[10px] font-normal text-zinc-500 truncate">当前线路共 {episodes.length} 集 · 点击切换</span>
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5 max-h-44 overflow-y-auto pr-1">
                  {episodes.map((ep) => {
                    const epSelected = ep.id === currentEpisode?.id;
                    return (
                      <button
                        key={ep.id}
                        onClick={() => handleSwitchEpisode(ep)}
                        title={ep.title}
                        className={`px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
                          epSelected
                            ? 'bg-emerald-500 text-black border-emerald-400'
                            : 'bg-zinc-800/60 text-zinc-300 border-zinc-700/60 hover:text-white hover:bg-zinc-800'
                        }`}
                      >
                        {movie.type === 'movie'
                          ? episodes.length > 1
                            ? ep.title || `第${ep.number}集`
                            : '正片'
                          : `第${ep.number}集`}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
      </div>

      {/* 选源弹窗：未探测站点可批量/单站补测，推荐分组可批量重探 */}
      <SourcePickerModal
        open={sourceModalOpen}
        onClose={() => setSourceModalOpen(false)}
        scan={scan}
        matches={resource?.matches || []}
        isFeature={movie.type === 'movie' || movie.type === 'doc'}
        selectedSiteKey={selectedMatch?.siteKey}
        selectedFlag={activeLine?.flag}
        researching={researching}
        onResearch={handleResearch}
        probingSites={probingSites}
        onProbeSite={(siteKey) => probeSite(movieId, siteKey)}
        onProbeAllUnprobed={() => {
          const probed = new Set((scan?.results || []).map((r) => r.siteKey));
          const keys = [...new Set((resource?.matches || [])
            .map((m) => m.siteKey)
            .filter((key) => !probed.has(key)))];
          if (keys.length) reprobeSites(movieId, keys);
        }}
        onReprobeRecommended={(keys) => {
          if (keys.length) reprobeSites(movieId, keys);
        }}
        onReprobeSite={(siteKey) => reprobeSites(movieId, [siteKey])}
        onSelect={(siteKey, flag) => {
          setSourceModalOpen(false);
          applySource(siteKey, flag);
        }}
      />
    </div>
  );
};
