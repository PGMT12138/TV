import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useApp } from '../context/AppContext';
import { api } from '../api';
import { Episode, ResourceState, ResourceFlag, ScanCandidateResult, scanResultKey } from '../types';
import { INITIAL_SELECTION_WAIT_MS, initialCandidate, isMeaningfulUpgrade, qualifiedRecommendations, displayRecommendations } from '../utils/autoSelection';
import { compareRecommended, fmtRes, isMobileDevice } from '../utils/scanFormat';
import { referenceDurationSeconds } from '../utils/referenceDuration';
import { prepareMedia, playbackHlsConfig, isFileMedia, missingFragment, gapNeedsHandoff, bufferedAhead, type WarmMedia } from '../utils/mediaHandoff';
import { lockOrientation, unlockOrientation, type OrientationLock } from '../utils/orientation';
import { getSessionLineFailure, markSessionLineFailure, useSessionLineFailures } from '../utils/sessionLineFailures';
import { SourcePickerModal } from '../components/SourcePickerModal';
import { MetricBadges } from '../components/MetricBadges';
import Hls, { type ErrorData } from 'hls.js';
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
  Download,
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

type PlayerResponse = Awaited<ReturnType<typeof api.player>>;
type PreparedPlayer = { key: string; data: PlayerResponse };
type UpgradeAttempt = {
  stage: 'during' | 'final'; key: string; committed: boolean; cancelled?: boolean;
  previous: { resource: ResourceState; episode: Episode | null; position: number; paused: boolean; player?: PreparedPlayer };
  timer?: ReturnType<typeof setTimeout>;
};

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
  const refDurationS = referenceDurationSeconds(movie?.duration);
  const movieId = movie?.id || selectedMovieId || '';
  const resource = movieResources[movieId];
  const activeLine = currentEpisodes(movieId);
  const episodes = activeLine?.episodes || [];
  const selectedMatch = resource?.selected;
  const scan = resource?.scan;
  const sessionFailures = useSessionLineFailures();
  const lineFailure = (siteKey: string, vodId: string, flag?: string) => getSessionLineFailure(movieId, siteKey, vodId, flag);
  const selectableResults = (scan?.results || []).filter((r) => !lineFailure(r.siteKey, r.vodId, r.flag));
  const sessionFailureRows = [...sessionFailures.values()].filter((failure) => failure.movieId === movieId);
  // 未探测线路的切换也可能失败，补上仅用于界面展示的记录，不污染服务端探测结果。
  const pickerResults = [...(scan?.results || []), ...sessionFailureRows.filter((failure) => failure.flag
    && !scan?.results.some((r) => r.siteKey === failure.siteKey && r.vodId === failure.vodId && r.flag === failure.flag))
    .map((failure): ScanCandidateResult => ({ ...failure, siteName: resource?.matches.find((m) => m.siteKey === failure.siteKey)?.siteName || failure.siteKey,
      status: 'fail', error: failure.reason }))];
  const automaticScanFinished = resource?.automaticScanComplete === true && resource.searchEnded === true
    && scan?.status === 'done' && !scan.extending && !scan.error;
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
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [switchingTarget, setSwitchingTarget] = useState<{ request: number; label: string; siteKey: string; flag?: string; ready?: boolean; awaitingPlayback?: boolean } | null>(null);
  const [activeSlot, setActiveSlot] = useState(0);
  const activeSlotRef = useRef(0);
  const videoSlotsRef = useRef<(HTMLVideoElement | null)[]>([null, null]);
  const standbyAbortRef = useRef<AbortController | null>(null);
  const promotedKeyRef = useRef('');
  const skipHistoryResumeRef = useRef(false);
  const handoffPlayingRef = useRef<() => void>(() => {});
  const currentFailureRef = useRef<{ video: HTMLVideoElement; start: number; reason: string } | null>(null);
  const activeHlsErrorRef = useRef<(hls: Hls, video: HTMLVideoElement, data: ErrorData, missing?: { url: string; start: number }) => void>(() => {});
  const bindActiveHls = (hls: Hls, video: HTMLVideoElement) => {
    const attempts = new Map<string, number>();
    hls.on(Hls.Events.ERROR, (_event, data) => activeHlsErrorRef.current(hls, video, data, missingFragment(data, attempts)));
  };
  const [dismissedSuggestions, setDismissedSuggestions] = useState<Set<string>>(new Set());
  const [suggestionPendingKey, setSuggestionPendingKey] = useState<string | null>(null);
  const suggestionDeadlinesRef = useRef(new Map<string, number>());
  const [stalled, setStalled] = useState(false);
  const [clockNow, setClockNow] = useState(Date.now);
  const enteredRef = useRef({ movieId, at: Date.now() });
  if (enteredRef.current.movieId !== movieId) enteredRef.current = { movieId, at: Date.now() };
  const initialPending = !!(resource?.initialAutoPlayPending ?? resource?.awaitScan)
    && !resource?.autoUserPicked && !resource?.restoredPick;
  const waitRemaining = Math.max(0, INITIAL_SELECTION_WAIT_MS - (clockNow - enteredRef.current.at));
  const sourceRequestRef = useRef(0);
  const manualSelectionRef = useRef(false);
  const hasPlayedRef = useRef(false);
  const initialBusyRef = useRef(false);
  const failedUpgradesRef = useRef(new Set<string>());
  const upgradeQuotaRef = useRef({ during: false, final: false });
  const pendingUpgradeRef = useRef<UpgradeAttempt | null>(null);
  const preparedPlayerRef = useRef<PreparedPlayer | undefined>(undefined);
  const loadedPlayerRef = useRef<PreparedPlayer | undefined>(undefined);
  const keepPausedRef = useRef(false);
  const rollbackUpgradeRef = useRef<() => boolean>(() => false);
  const upgradeSourceRef = useRef<(stage: 'during' | 'final', candidate: ScanCandidateResult) => void>(() => {});

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
  const recoveryGenerationRef = useRef(0);
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
  const latestSelectionRef = useRef({ movieId, resource, currentEpisode });
  latestSelectionRef.current = { movieId, resource, currentEpisode };

  useEffect(() => {
    setClockNow(Date.now());
    if (Date.now() - enteredRef.current.at >= INITIAL_SELECTION_WAIT_MS) return;
    const timer = setInterval(() => {
      setClockNow(Date.now());
      if (Date.now() - enteredRef.current.at >= INITIAL_SELECTION_WAIT_MS) clearInterval(timer);
    }, 250);
    return () => clearInterval(timer);
  }, [movieId]);

  useEffect(() => {
    recoveryGenerationRef.current++;
    recoveryBusyRef.current = false;
    sourceRequestRef.current++;
    standbyAbortRef.current?.abort();
    currentFailureRef.current = null;
    promotedKeyRef.current = '';
    setSwitchingTarget(null);
    manualSelectionRef.current = false;
    initialBusyRef.current = false;
    failedUpgradesRef.current.clear();
    upgradeQuotaRef.current = { during: false, final: false };
    if (pendingUpgradeRef.current?.timer) clearTimeout(pendingUpgradeRef.current.timer);
    pendingUpgradeRef.current = null;
    preparedPlayerRef.current = undefined;
    loadedPlayerRef.current = undefined;
    keepPausedRef.current = false;
    hasPlayedRef.current = false;
    setSelectionBusy(false);
    setDismissedSuggestions(new Set());
    suggestionDeadlinesRef.current.clear();
    setSuggestionPendingKey(null);
    return () => {
      recoveryGenerationRef.current++;
      recoveryBusyRef.current = false;
      sourceRequestRef.current++;
      standbyAbortRef.current?.abort();
      if (pendingUpgradeRef.current?.timer) clearTimeout(pendingUpgradeRef.current.timer);
      pendingUpgradeRef.current = null;
    };
  }, [movieId, resource?.searchStartedAt]);

  useEffect(() => {
    setStalled(false);
    if (!buffering || !hasPlayedRef.current || pendingUpgradeRef.current) return;
    const timer = setTimeout(() => setStalled(true), 8000);
    return () => clearTimeout(timer);
  }, [buffering, selectedMatch?.siteKey, activeLine?.flag]);

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

  // 异步选线统一经过请求版本检查，防止旧准备结果覆盖新的用户选择。
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

  // 从进入播放页计时；到 12 秒才允许自动起播，不因搜索/探测提前完成而跳过等待。
  useEffect(() => {
    if (!initialPending || waitRemaining > 0 || resource?.status !== 'ready' || initialBusyRef.current || manualSelectionRef.current) return;
    const available = selectableResults.filter((r) => !failedUpgradesRef.current.has(scanResultKey(r)));
    const best = initialCandidate(available, clockNow - enteredRef.current.at, refDurationS);
    if (!best && scan?.status !== 'done' && resource.awaitScan !== false) return;
    if (!best || (best.siteKey === selectedMatch?.siteKey && best.flag === activeLine?.flag)) {
      patchResource(movieId, { initialAutoPlayPending: false, awaitScan: false, provisional: true });
      return;
    }
    initialBusyRef.current = true;
    setSelectionBusy(true);
    const run = resource.searchStartedAt;
    void applySourceRef.current(best.siteKey, best.flag, false).then((ok) => {
      if (latestSelectionRef.current.movieId !== movieId || latestSelectionRef.current.resource?.searchStartedAt !== run) return;
      if (ok) patchResource(movieId, { initialAutoPlayPending: false, awaitScan: false, provisional: true });
      else failedUpgradesRef.current.add(scanResultKey(best));
    }).finally(() => {
      if (latestSelectionRef.current.movieId !== movieId || latestSelectionRef.current.resource?.searchStartedAt !== run) return;
      initialBusyRef.current = false;
      setSelectionBusy(false);
    });
  }, [clockNow, initialPending, waitRemaining, resource?.status, scan?.results, scan?.status, selectionBusy, movieId, refDurationS, sessionFailures]);

  // 用户开始手动补测时，尚未交接的自动质量升级也停止，继续保留当前播放。
  useEffect(() => {
    if (!resource?.manualProbeStarted || !pendingUpgradeRef.current || pendingUpgradeRef.current.committed) return;
    pendingUpgradeRef.current.cancelled = true;
    pendingUpgradeRef.current = null;
    sourceRequestRef.current++;
    standbyAbortRef.current?.abort();
    setSwitchingTarget(null);
    setSelectionBusy(false);
  }, [resource?.manualProbeStarted]);

  // 自动升级每阶段最多成功一次；手动探测结果只用于展示与提示。
  useEffect(() => {
    if (!resource?.autoUpgradeEligible || initialPending || !hasPlayedRef.current || !isPlaying
        || resource.manualProbeStarted || resource.autoUserPicked || resource.restoredPick || resource.restorePending || scan?.userPicked
        || manualSelectionRef.current || pendingUpgradeRef.current || selectionBusy || autoRecovering
        || recoveryBusyRef.current || resource.status !== 'ready' || !selectedMatch || !activeLine) return;
    const recommendations = qualifiedRecommendations(selectableResults, refDurationS);
    const best = recommendations[0];
    if (!best || failedUpgradesRef.current.has(scanResultKey(best))) return;
    if (best.siteKey === selectedMatch.siteKey && best.flag === activeLine.flag) return;
    const current = scan?.results.find((r) => r.siteKey === selectedMatch.siteKey && r.flag === activeLine.flag);
    if (!isMeaningfulUpgrade(best, current, stalled, refDurationS)) return;
    if (automaticScanFinished) {
      if (!resource.autoFinalDone && !upgradeQuotaRef.current.final) upgradeSourceRef.current('final', best);
    } else if (recommendations.length >= 3 && !resource.autoDuringDone && !upgradeQuotaRef.current.during) {
      upgradeSourceRef.current('during', best);
    }
  }, [resource, scan, isPlaying, initialPending, selectionBusy, autoRecovering, stalled, movieId, refDurationS, automaticScanFinished, sessionFailures]);

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
  }, []);

  const handleResearch = useCallback(async () => {
    if (researching) return;
    recoveryGenerationRef.current++;
    recoveryBusyRef.current = false;
    sourceRequestRef.current++;
    standbyAbortRef.current?.abort();
    setSwitchingTarget(null);
    if (pendingUpgradeRef.current?.timer) clearTimeout(pendingUpgradeRef.current.timer);
    pendingUpgradeRef.current = null;
    preparedPlayerRef.current = undefined;
    keepPausedRef.current = false;
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

  // 首播门控（布尔值，只在等待和初选结束后翻转一次；
  // 不能直接依赖 scan 状态，否则扫描完成会触发播放器重载，把续播进度清掉）
  const scanGateOpen =
    !initialPending;

  // 拉取播放地址并挂载到 <video>（m3u8 用 hls.js）
  useEffect(() => {
    if (resource?.status !== 'ready' || !currentEpisode || !selectedMatch || !activeLine) {
      // 站点就绪但没有任何可用选集（站点失效）：清掉起播 loading，别永远"正在解析"
      if (resource?.status === 'ready' && !currentEpisode) setPlayerLoading(false);
      return;
    }
    // 首次加载且无历史偏好：等入页满 12 秒并完成初选后再起播。
    if (!scanGateOpen) return;
    const video = videoRef.current;
    if (!video) return;
    const expectedKey = `${selectedMatch.siteKey}::${activeLine.flag}::${currentEpisode.id}`;
    if (promotedKeyRef.current === expectedKey) {
      promotedKeyRef.current = '';
      setPlayerLoading(false);
      setBuffering(false);
      handoffPlayingRef.current();
      return;
    }
    if (lineFailure(selectedMatch.siteKey, selectedMatch.vodId, activeLine.flag)) {
      setPlayerLoading(false);
      void autoRecoverRef.current('该线路在本次会话中不可用', false);
      return;
    }
    let cancelled = false;

    (async () => {
      setPlayerLoading(true);
      setPlayerError('');
      setBuffering(true);
      setBufferedEnd(0);
      destroyHls();
      try {
        const playerKey = `${selectedMatch.siteKey}::${activeLine.flag}::${currentEpisode.id}`;
        const prepared = preparedPlayerRef.current;
        if (prepared?.key === playerKey) preparedPlayerRef.current = undefined;
        const res = prepared?.key === playerKey ? prepared.data
          : await api.player(selectedMatch.siteKey, activeLine.flag, currentEpisode.id);
        if (cancelled) return;
        if (res.error) throw new Error(res.error);
        const src = res.play || res.url;
        if (!src) throw new Error('未获取到播放地址');
        loadedPlayerRef.current = { key: playerKey, data: res };
        // 判定反转：只排除明确的文件直链（mp4/mkv 等），其余一律走 hls.js——大量线路入口是
        // php/无后缀地址（如 m3u8.meilinvps.com/m3u8/32641）302 到 CDN m3u8，后端按后缀
        // 误判 hls=false 后经 video.src 原生挂载，Chromium 不支持原生 HLS 会永远卡加载。
        // 扩展名藏在 query 里的直链（网盘/对象存储签名 URL 的 filename*=...mp4，
        // 或实际为 MP4 却标成 filename*=...iso）也算文件：
        // 喂给 hls.js 会把整个文件当清单下载，永远进不了帧
        const isFile = isFileMedia(res, activeProbeKind);
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
          const hls = new Hls(playbackHlsConfig());
          hlsRef.current = hls;
          bindActiveHls(hls, video);
          hls.loadSource(src);
          hls.attachMedia(video);
          armWatchdog();
        } else {
          video.src = src;
          armWatchdog();
        }
        if (!keepPausedRef.current) video.play().then(() => setIsPlaying(true)).catch(() => {});
      } catch (e: any) {
        if (!cancelled) {
          if (rollbackUpgradeRef.current()) return;
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
                  failedSourceKeysRef.current.add(`${selectedMatch.siteKey}::${selectedMatch.vodId}::${activeLine.flag}::${currentEpisode?.number || 1}`);
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

  useEffect(() => {
    const videos = [...videoSlotsRef.current];
    return () => {
      standbyAbortRef.current?.abort();
      destroyHls();
      videos.forEach((video) => { if (video) { video.pause(); video.removeAttribute('src'); video.load(); } });
    };
  }, [destroyHls]);

  // Resume progress from history if available（换源后集 id 会变，按集数号兜底匹配）
  useEffect(() => {
    if (skipHistoryResumeRef.current) { skipHistoryResumeRef.current = false; return; }
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
  }, [movieId, currentEpisode?.id, selectedMatch?.siteKey, activeLine?.flag]);

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
      // 仅大屏左右并排时齐高；移动端信息区在播放器上方独立成块，清掉内联高度防误压缩
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
      keepPausedRef.current = false;
      videoRef.current.play().then(() => setIsPlaying(true)).catch(() => {});
    } else {
      keepPausedRef.current = true;
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
      if (resume > 0 && isFinite(videoRef.current.duration) && videoRef.current.duration > 0) {
        const position = Math.min(resume, Math.max(0, videoRef.current.duration - 0.1));
        videoRef.current.currentTime = position;
        setCurrentTime(position);
      }
      resumeRef.current = 0;
      if (keepPausedRef.current) videoRef.current.pause();
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
    recoveryGenerationRef.current++;
    recoveryBusyRef.current = false;
    sourceRequestRef.current++;
    standbyAbortRef.current?.abort();
    currentFailureRef.current = null;
    setSwitchingTarget(null);
    setAutoRecovering(false);
    setRecoveryPending('');
    if (pendingUpgradeRef.current?.timer) clearTimeout(pendingUpgradeRef.current.timer);
    pendingUpgradeRef.current = null;
    setSelectionBusy(false);
    keepPausedRef.current = false;
    resumeRef.current = 0;
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

  // 推荐卡片允许展示尚无片长核验信息的可用线路，严格升级条件只用于自动选择和升级提示。
  // 不排除当前线路——它排进前 3 时在卡片右侧标记已选择
  const topLines = displayRecommendations(selectableResults, refDurationS).slice(0, 3);
  const bestUpgrade = qualifiedRecommendations(selectableResults, refDurationS)[0];

  // 手动选线/历史续播只提示，不自动接管；关闭后本轮不重复提示同一对线路。
  const preferredSource = resource?.manualProbeStarted || resource?.autoUserPicked || scan?.userPicked || resource?.restoredPick
    || resource?.restorePending || resource?.autoUpgradeEligible === false;
  const currentResult = activeLine ? flagResult(activeLine.flag) : undefined;
  const betterLine = preferredSource && automaticScanFinished && resource?.status === 'ready'
    && !initialPending && !autoRecovering && !recoveryPending && selectedMatch && activeLine
    && bestUpgrade && isMeaningfulUpgrade(bestUpgrade, currentResult, stalled, refDurationS)
    ? bestUpgrade : undefined;
  const suggestionKey = betterLine
    ? JSON.stringify([movieId, resource?.searchStartedAt, selectedMatch?.siteKey, activeLine?.flag, scanResultKey(betterLine)]) : '';
  const suggestedLine = betterLine && !dismissedSuggestions.has(suggestionKey)
    && (!selectionBusy || suggestionPendingKey === suggestionKey) ? betterLine : undefined;
  const visibleSuggestionKey = suggestedLine && !controlsLocked ? suggestionKey : '';

  // 浮层从首次展示起最多保留 10 秒；重新渲染、暂停或临时隐藏均不延长时限。
  // 只关闭浮层，线路卡片下方的文字提示仍由 betterLine 独立控制。
  useEffect(() => {
    if (!visibleSuggestionKey) return;
    const deadline = suggestionDeadlinesRef.current.get(visibleSuggestionKey) ?? Date.now() + 10_000;
    suggestionDeadlinesRef.current.set(visibleSuggestionKey, deadline);
    const timer = setTimeout(() => {
      setDismissedSuggestions((prev) => new Set(prev).add(visibleSuggestionKey));
    }, Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [visibleSuggestionKey]);

  // 播放器下方加载提示：聚合所有进行中的加载动作（搜索站点/获取选集/智能测速/补充探测/
  // 懒补测/解析播放地址），逐条展示动画与友好文案，用户始终知道系统在忙什么
  const busyHints: string[] = [];
  if (initialPending) busyHints.push(waitRemaining > 0
    ? `正在为您比较片源，${Math.ceil(waitRemaining / 1000)} 秒后优先播放推荐线路…`
    : '正在选择可用线路，找到合适片源后自动播放…');
  // 已选源/开始播放时 SSE 仍可能继续返回站点，搜索提示必须跟随搜索流而非选源状态。
  const searchingSites = resource?.searchEnded === false
    || (resource?.searchEnded === undefined && resource?.status === 'searching');
  if (searchingSites) busyHints.push(
    resource?.status === 'ready'
      ? '仍在搜索其他站点，您可以继续观看，更多片源会自动补充…'
      : resource?.matches.length
      ? '已找到部分片源，正在继续搜索其他站点，结果会陆续补充…'
      : '正在各个站点寻找片源，部分站点响应较慢，请稍候…'
  );
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
  if (autoRecovering && !switchingTarget) busyHints.push('当前线路失效，正在自动寻找可用线路…');

  const applySource = async (siteKey: string, flag: string | undefined, manual = true, recovery = false): Promise<boolean> => {
    const original = latestSelectionRef.current.resource;
    if (!original) return false;
    const targetMatch = original.matches.find((m) => m.siteKey === siteKey);
    if (targetMatch && lineFailure(siteKey, targetMatch.vodId, flag)) return false;
    standbyAbortRef.current?.abort();
    const controller = new AbortController();
    standbyAbortRef.current = controller;
    if (manual) {
      recoveryGenerationRef.current++;
      recoveryBusyRef.current = false;
      setAutoRecovering(false);
      setRecoveryPending('');
      manualSelectionRef.current = true;
      if (pendingUpgradeRef.current?.timer) clearTimeout(pendingUpgradeRef.current.timer);
      pendingUpgradeRef.current = null;
      setSelectionBusy(true);
    }
    const request = ++sourceRequestRef.current;
    const automaticUpgrade = !manual && !recovery && !!pendingUpgradeRef.current;
    const run = original.searchStartedAt;
    const valid = () => request === sourceRequestRef.current && latestSelectionRef.current.movieId === movieId
      && latestSelectionRef.current.resource?.searchStartedAt === run
      && (!automaticUpgrade || !latestSelectionRef.current.resource?.manualProbeStarted)
      && (manual || recovery || (!manualSelectionRef.current && !latestSelectionRef.current.resource?.autoUserPicked));
    const match = original.matches.find((m) => m.siteKey === siteKey);
    const oldVideo = videoRef.current;
    const warmSwitch = !!oldVideo && (hasPlayedRef.current || recovery);
    if (warmSwitch) setSelectionBusy(true);
    setSwitchingTarget({ request, siteKey, flag, label: `${match?.siteName || siteKey} · ${flag || '线路'}` });
    let committed = false;
    let targetFlag = flag || '';
    let failureReason = '';
    const fail = (reason: string) => { failureReason = reason; return false; };
    let warmed: WarmMedia | undefined;
    try {
      if (!match) return false;
      // 先取得目标详情和播放地址，再一次性提交站点/线路/选集，准备期间保留当前播放。
      let flags: ResourceFlag[] = siteKey === original.selected?.siteKey ? original.flags : [];
      if (!flags.length || (flag !== undefined && !flags.some((f) => f.flag === flag))) {
        const data = await api.siteDetail(match.siteKey, match.vodId);
        if (!valid()) return false;
        if (data.error) return fail(data.error);
        flags = (data.flags || []).map((f) => ({ flag: f.flag, episodes: (f.episodes || []).map((ep, index) => ({
          id: ep.url, number: index + 1, title: ep.name || `第${index + 1}集`, duration: data.remarks || '',
          previewUrl: '', videoUrl: '',
        })) })).filter((f) => f.episodes.length > 0);
      }
      const index = flag === undefined ? flags.findIndex((f) => !lineFailure(siteKey, match.vodId, f.flag)) : flags.findIndex((f) => f.flag === flag);
      if (index < 0 || !flags[index]) return fail('该线路已无可用选集');
      targetFlag = flags[index].flag;
      setSwitchingTarget((target) => target?.request === request ? { ...target, flag: targetFlag, label: `${match.siteName} · ${targetFlag}` } : target);
      if (lineFailure(siteKey, match.vodId, targetFlag)) return false;
      const previousEpisode = latestSelectionRef.current.currentEpisode;
      const episode = previousEpisode
        ? flags[index].episodes.find((ep) => ep.number === previousEpisode.number)
        : flags[index].episodes[0];
      if (!episode) return fail('该线路缺少当前选集'); // 不能在换源时把用户正在看的后续集数退回第一集。
      const data = await api.player(siteKey, flags[index].flag, episode.id);
      if (!valid()) return false;
      if (data.error || !(data.play || data.url)) return fail(data.error || '未获取到播放地址');
      if (pendingUpgradeRef.current && videoRef.current?.paused) {
        pendingUpgradeRef.current.cancelled = true;
        return false;
      }
      if (warmSwitch && oldVideo) {
        const nextVideo = videoSlotsRef.current[1 - activeSlotRef.current];
        if (!nextVideo) return false;
        const kind = latestSelectionRef.current.resource?.scan?.results.find((r) => r.siteKey === siteKey && r.flag === flags[index].flag)?.metrics?.kind;
        warmed = await prepareMedia(nextVideo, data, {
          kind, signal: controller.signal, valid: () => valid() && videoRef.current === oldVideo,
          position: () => oldVideo.currentTime || 0,
          paused: () => oldVideo.paused,
          rate: () => oldVideo.playbackRate,
          canCommit: () => !recovery || currentFailureRef.current?.video !== oldVideo
            || gapNeedsHandoff(oldVideo, currentFailureRef.current.start),
          onReady: () => setSwitchingTarget((target) => target?.request === request ? { ...target, ready: true } : target),
        });
        if (!valid()) return false;
        if (pendingUpgradeRef.current && oldVideo.paused) {
          pendingUpgradeRef.current.cancelled = true;
          return false;
        }
      }
      const position = videoRef.current?.currentTime || 0;
      const paused = hasPlayedRef.current && (keepPausedRef.current || !!videoRef.current?.paused);
      resumeRef.current = position;
      keepPausedRef.current = paused;
      const pending = pendingUpgradeRef.current;
      if (pending) {
        pending.previous.position = position;
        pending.previous.paused = paused;
        pending.committed = true;
      }
      const prepared = { key: `${siteKey}::${flags[index].flag}::${episode.id}`, data };
      if (warmed && oldVideo) {
        const oldHls = hlsRef.current;
        const nextSlot = 1 - activeSlotRef.current;
        const nextVideo = warmed.video;
        // 使用已解码的同一个 video/MSE 实例接替，绝不重新设置 src 或重新下载。
        videoRef.current = nextVideo;
        hlsRef.current = warmed.hls || null;
        activeSlotRef.current = nextSlot;
        if (warmed.hls) {
          Object.assign(warmed.hls.config, { maxBufferLength: 300, maxMaxBufferLength: 600,
            maxBufferSize: 300 * 1000 * 1000, backBufferLength: 300 });
          bindActiveHls(warmed.hls, nextVideo);
        }
        const muted = oldVideo.muted;
        nextVideo.volume = oldVideo.volume;
        if (paused) nextVideo.pause();
        oldVideo.muted = true;
        oldVideo.pause();
        nextVideo.muted = muted;
        oldHls?.destroy();
        oldVideo.removeAttribute('src');
        oldVideo.load();
        currentFailureRef.current = null;
        loadedPlayerRef.current = prepared;
        preparedPlayerRef.current = undefined;
        promotedKeyRef.current = prepared.key;
        skipHistoryResumeRef.current = true;
        resumeRef.current = 0;
        setActiveSlot(nextSlot);
        setCurrentTime(nextVideo.currentTime);
        setDuration(nextVideo.duration);
        setIsPlaying(!paused);
        setBuffering(false);
        setPlayerLoading(false);
      } else preparedPlayerRef.current = prepared;
      patchResource(movieId, { status: 'ready', selected: match, flags, activeFlagIndex: index,
        restorePending: undefined, restoredPick: undefined, error: undefined,
        ...(manual ? { autoUserPicked: true, initialAutoPlayPending: false, awaitScan: false } : {}) });
      if (manual) patchScan(movieId, { userPicked: true });
      setCurrentEpisode(episode);
      setPlayerError('');
      committed = true;
      return true;
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError'))
        failureReason = error instanceof Error ? error.message : '该线路未能正常起播';
      return false;
    } finally {
      if (!committed && failureReason && valid() && !controller.signal.aborted && match && !pendingUpgradeRef.current?.cancelled)
        markSessionLineFailure({ movieId, siteKey, vodId: match.vodId, flag: targetFlag, reason: failureReason });
      if (!committed) warmed?.destroy();
      if (standbyAbortRef.current === controller) standbyAbortRef.current = null;
      setSwitchingTarget((target) => target?.request === request
        ? (committed && !warmSwitch ? { ...target, awaitingPlayback: true } : null) : target);
      if (valid() && warmSwitch) setSelectionBusy(false);
      if (manual && valid()) {
        setSelectionBusy(false);
        if (!committed) {
          manualSelectionRef.current = false;
          showToast('目标线路无法播放，已标记本次会话不可用，当前播放保留', 'warning');
          if (currentFailureRef.current?.video === videoRef.current)
            void autoRecoverRef.current(currentFailureRef.current.reason);
        }
      }
    }
  };
  applySourceRef.current = applySource;

  const acceptSuggestedLine = async () => {
    if (!suggestedLine || selectionBusy || suggestionPendingKey) return;
    const key = suggestionKey;
    setSuggestionPendingKey(key);
    try {
      // 与手动换线共用路径：先准备地址，再携带当前集数、进度和暂停状态提交。
      await applySource(suggestedLine.siteKey, suggestedLine.flag, true);
    } finally {
      setSuggestionPendingKey((pending) => pending === key ? null : pending);
    }
  };

  const rollbackUpgrade = (): boolean => {
    const pending = pendingUpgradeRef.current;
    if (!pending) return false;
    recoveryGenerationRef.current++;
    recoveryBusyRef.current = false;
    sourceRequestRef.current++;
    standbyAbortRef.current?.abort();
    setSwitchingTarget(null);
    if (pending.timer) clearTimeout(pending.timer);
    pendingUpgradeRef.current = null;
    failedUpgradesRef.current.add(pending.key);
    setSelectionBusy(false);
    if (!pending.committed) return false;
    const old = pending.previous;
    preparedPlayerRef.current = old.player;
    resumeRef.current = old.position;
    keepPausedRef.current = old.paused || keepPausedRef.current;
    patchResource(movieId, { status: 'ready', selected: old.resource.selected, flags: old.resource.flags,
      activeFlagIndex: old.resource.activeFlagIndex, initialAutoPlayPending: false, awaitScan: false, error: undefined });
    setCurrentEpisode(old.episode);
    setPlayNonce((n) => n + 1);
    setPlayerError('');
    showToast('新线路未能正常起播，已返回原线路继续观看', 'info');
    return true;
  };
  rollbackUpgradeRef.current = rollbackUpgrade;

  upgradeSourceRef.current = (stage, candidate) => {
    if (!resource || pendingUpgradeRef.current) return;
    const pending: UpgradeAttempt = { stage, key: scanResultKey(candidate), committed: false,
      previous: { resource, episode: currentEpisode, position: videoRef.current?.currentTime || 0,
        paused: !!videoRef.current?.paused, player: loadedPlayerRef.current } };
    pendingUpgradeRef.current = pending;
    setSelectionBusy(true);
    void applySource(candidate.siteKey, candidate.flag, false).then((ok) => {
      if (pendingUpgradeRef.current !== pending) return;
      if (!ok) {
        if (!pending.cancelled) failedUpgradesRef.current.add(pending.key);
        pendingUpgradeRef.current = null;
        setSelectionBusy(false);
        if (currentFailureRef.current?.video === videoRef.current) void autoRecoverRef.current(currentFailureRef.current.reason);
        return;
      }
      // 提交后由播放器 effect 确认交接成功；定时器仅兜底状态未能完成提交的情况。
      pending.timer = setTimeout(() => rollbackUpgradeRef.current(), 30_000);
    });
  };

  // 播放失败自动自愈：按推荐顺序逐个验证已探测候选（单轮最多 4 条）；扫描尚未
  // 产出候选则等待，候选耗尽后仅强制实时重搜一次，防止坏源造成无限循环。
  const autoRecover = async (reason: string, markCurrent = true): Promise<boolean> => {
    setSwitchingTarget((target) => target?.awaitingPlayback ? null : target);
    if (standbyAbortRef.current && manualSelectionRef.current) return true;
    // 主线路失效时若更优线路已经在准备，继续完成这次准备，不把备用播放器误当坏线回滚。
    if (pendingUpgradeRef.current && !pendingUpgradeRef.current.committed) {
      if (resource?.selected && activeLine) markSessionLineFailure({ movieId, siteKey: resource.selected.siteKey, vodId: resource.selected.vodId, flag: activeLine.flag, reason });
      return true;
    }
    if (rollbackUpgradeRef.current()) return true;
    if (recoveryBusyRef.current || !resource) return recoveryBusyRef.current;
    const generation = recoveryGenerationRef.current;
    const run = resource.searchStartedAt;
    const validRecovery = () => generation === recoveryGenerationRef.current
      && latestSelectionRef.current.movieId === movieId && latestSelectionRef.current.resource?.searchStartedAt === run;
    const selected = resource.selected;
    const line = resource.flags[resource.activeFlagIndex] || resource.flags[0];
    if (markCurrent && selected && line) {
      markSessionLineFailure({ movieId, siteKey: selected.siteKey, vodId: selected.vodId, flag: line.flag, reason });
      failedSourceKeysRef.current.add(`${selected.siteKey}::${selected.vodId}::${line.flag}::${currentEpisode?.number || 1}`);
    }
    const pos = videoRef.current?.currentTime || currentTime;
    if (pos >= 0) resumeRef.current = pos;
    patchResource(movieId, { restorePending: undefined, restoredPick: undefined });
    patchScan(movieId, { switched: true });
    setPlayerError('');

    const candidates = (scan?.results || [])
      .filter((r) => !lineFailure(r.siteKey, r.vodId, r.flag))
      .filter((r) => r.status === 'ok' && r.flag && r.metrics)
      .sort(compareRecommended)
      .filter((r) => !failedSourceKeysRef.current.has(`${r.siteKey}::${r.vodId}::${r.flag}::${currentEpisode?.number || 1}`))
      .slice(0, 4);

    if (candidates.length) {
      recoveryBusyRef.current = true;
      setAutoRecovering(true);
      setRecoveryPending('');
      try {
        for (const candidate of candidates) {
          const ok = await applySource(candidate.siteKey, candidate.flag, false, true);
          if (!validRecovery()) return true;
          if (ok) {
            patchResource(movieId, { provisional: scan?.status === 'running' || undefined });
            showToast(`当前线路失效，已自动切换：${candidate.siteName} · ${candidate.flag}`, 'info');
            return true;
          }
          failedSourceKeysRef.current.add(`${candidate.siteKey}::${candidate.vodId}::${candidate.flag}::${currentEpisode?.number || 1}`);
        }
      } finally {
        if (validRecovery()) recoveryBusyRef.current = false;
      }
    }

    if (scan?.status === 'running') {
      setRecoveryPending(reason || '当前线路失效');
      setAutoRecovering(true);
      return true;
    }

    // 备用候选暂时都不可用时，继续消费主线路的现有缓冲；不要用重搜状态打断仍可播的画面。
    const currentVideo = videoRef.current;
    if (currentFailureRef.current?.video === currentVideo && currentVideo
        && currentVideo.readyState >= 3 && bufferedAhead(currentVideo) > 0.5) {
      setRecoveryPending(reason);
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
        if (validRecovery()) {
          recoveryBusyRef.current = false;
          setAutoRecovering(false);
        }
      }
    }

    setAutoRecovering(false);
    setRecoveryPending('');
    return false;
  };
  autoRecoverRef.current = autoRecover;

  activeHlsErrorRef.current = (hls, video, data, missing) => {
    if (hlsRef.current !== hls || videoRef.current !== video) return;
    const missingStatus = data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR && [404, 410].includes(data.response?.code || 0);
    if (missingStatus && !missing) return; // 首次失败留一次重试，第二次开始准备备用。
    if (!missing && !data.fatal) return;
    if (currentFailureRef.current?.video === video) return; // 同一故障的后续 fatal 事件不覆盖已知缺口位置。
    hls.stopLoad(); // 保留已缓冲内容，不再重复请求同一个确定缺失的分片。
    const reason = missing ? '当前线路视频分片已失效' : '当前线路视频加载失败';
    currentFailureRef.current = { video, start: missing?.start ?? Number.NaN, reason };
    void autoRecoverRef.current(reason).then((recovered) => {
      if (!recovered && videoRef.current === video) setPlayerError(`${reason}，请在推荐线路中更换`);
    });
  };

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

  useEffect(() => {
    if (!recoveryPending) return;
    const timer = setInterval(() => {
      const video = videoRef.current;
      if (!recoveryBusyRef.current && video && currentFailureRef.current?.video === video
          && (video.readyState < 3 || bufferedAhead(video) <= 0.5)) {
        void autoRecoverRef.current(recoveryPending, false).then((recovered) => {
          if (!recovered && videoRef.current === video)
            setPlayerError(`${recoveryPending}，且未找到其它可用线路`);
        });
      }
    }, 500);
    return () => clearInterval(timer);
  }, [recoveryPending]);

  const handlePlaying = () => {
    setSwitchingTarget((target) => target?.awaitingPlayback && target.siteKey === selectedMatch?.siteKey && target.flag === activeLine?.flag ? null : target);
    hasPlayedRef.current = true;
    setIsPlaying(!videoRef.current?.paused);
    setBuffering(false);
    if (currentFailureRef.current?.video !== videoRef.current) {
      setAutoRecovering(false);
      setRecoveryPending('');
    }
    const selected = resource?.selected;
    if (selected && activeLine) {
      const pending = pendingUpgradeRef.current;
      if (pending?.committed && pending.key === `${selected.siteKey}::${activeLine.flag}`
          && loadedPlayerRef.current?.key.startsWith(`${pending.key}::`)) {
        if (pending.timer) clearTimeout(pending.timer);
        pendingUpgradeRef.current = null;
        upgradeQuotaRef.current[pending.stage] = true;
        patchResource(movieId, pending.stage === 'during' ? { autoDuringDone: true } : { autoFinalDone: true, provisional: false });
        setSelectionBusy(false);
        showToast(`${pending.stage === 'during' ? '已升级推荐线路' : '探测完成，已升级最终推荐线路'}：${selected.siteName} · ${activeLine.flag}`, 'success');
      }
      if (currentFailureRef.current?.video !== videoRef.current)
        failedSourceKeysRef.current.delete(`${selected.siteKey}::${selected.vodId}::${activeLine.flag}::${currentEpisode?.number || 1}`);
      const restoreKey = `${selected.siteKey}::${selected.vodId}::${activeLine.flag}`;
      if (resource?.restorePending && restoreConfirmedKeyRef.current !== restoreKey) {
        restoreConfirmedKeyRef.current = restoreKey;
        confirmRestoredSource(movieId);
        showToast('已恢复上次观看的来源和线路', 'info');
      }
    }
  };
  handoffPlayingRef.current = handlePlaying;

  const handleVideoError = () => {
    const video = videoRef.current;
    if (!video?.currentSrc || recoveryBusyRef.current) return;
    const message = video.error?.message || '该线路媒体加载失败';
    currentFailureRef.current = { video, start: Number.NaN, reason: message };
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
    if (initialPending && waitRemaining > 0 && !['error', 'offline', 'noresult'].includes(resource?.status || '')) {
      return (
        <div className="absolute inset-0 z-20 bg-black/70 flex flex-col items-center justify-center gap-3 px-6 text-center" role="status">
          <Loader2 className="w-12 h-12 text-emerald-400 animate-spin" />
          <p className="text-sm text-zinc-200">正在为您比较片源，优先选择更好的画质</p>
          <p className="text-xs text-zinc-400">再等 {Math.ceil(waitRemaining / 1000)} 秒，优先播放推荐线路</p>
        </div>
      );
    }
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
    if (autoRecovering && !switchingTarget && (!hasPlayedRef.current || buffering)) {
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
          {/* Video Title & Primary Info（移动端置顶，大屏在播放器右侧且齐高） */}
          <aside
            ref={infoRef}
            aria-label="影片资料"
            className="w-full lg:order-last lg:w-72 xl:w-80 lg:shrink-0 lg:sticky lg:top-20 rounded-3xl bg-zinc-900/60 border border-zinc-800 p-4 sm:p-5 flex flex-col gap-4 lg:overflow-hidden"
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
                onClick={() => showToast('离线缓存暂未开放', 'info')}
                title="缓存"
                className="flex items-center gap-1.5 px-4 py-2 rounded-full bg-zinc-800 hover:bg-zinc-700 text-zinc-300 text-xs font-semibold whitespace-nowrap shrink-0 border border-zinc-700 transition-colors"
              >
                <Download className="w-3.5 h-3.5" />
                <span>缓存</span>
              </button>
            </div>
          </aside>

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
            {[0, 1].map((slot) => <video
              key={slot}
              ref={(node) => { videoSlotsRef.current[slot] = node; if (slot === activeSlotRef.current) videoRef.current = node; }}
              data-active={activeSlot === slot ? 'true' : 'false'}
              aria-hidden={activeSlot !== slot}
              muted={activeSlot !== slot || isMuted}
              poster={movie.backdrop || movie.cover}
              onClick={(e) => { if (e.currentTarget === videoRef.current) handlePlayerSurfaceClick(); }}
              onTimeUpdate={(e) => { if (e.currentTarget === videoRef.current) handleTimeUpdate(); }}
              onProgress={(e) => { if (e.currentTarget === videoRef.current) handleProgress(); }}
              onLoadedMetadata={(e) => { if (e.currentTarget === videoRef.current) handleLoadedMetadata(); }}
              onError={(e) => { if (e.currentTarget === videoRef.current) handleVideoError(); }}
              onWaiting={(e) => { if (e.currentTarget === videoRef.current) setBuffering(true); }}
              onPlaying={(e) => { if (e.currentTarget === videoRef.current) handlePlaying(); }}
              onCanPlay={(e) => { if (e.currentTarget === videoRef.current) setBuffering(false); }}
              onPause={(e) => { if (e.currentTarget === videoRef.current) setIsPlaying(false); }}
              onSeeking={(e) => { if (e.currentTarget === videoRef.current) setBuffering(true); }}
              onSeeked={(e) => { if (e.currentTarget === videoRef.current) setBuffering(false); }}
              onEnded={(e) => { if (e.currentTarget === videoRef.current) handleEnded(); }}
              playsInline
              className={`absolute inset-0 w-full h-full object-contain bg-black ${activeSlot === slot ? 'opacity-100 cursor-pointer' : 'opacity-0 pointer-events-none'}`}
            />)}

            {/* Dynamic status overlays */}
            {renderPlayerOverlay()}

            {switchingTarget && !controlsLocked && (
              <div role="status" aria-label="线路切换进度" aria-live="polite"
                className="absolute right-3 top-3 z-30 w-48 max-w-[calc(100%-1.5rem)] rounded-lg border border-emerald-400/30 bg-zinc-950/90 px-3 py-2 text-left shadow-lg">
                <p className="flex items-center gap-1.5 text-xs leading-5 text-emerald-300">
                  <Loader2 className="h-3 w-3 animate-spin shrink-0" />
                  {switchingTarget.ready ? '备用已就绪' : '正在加载新线路'}
                </p>
                <p className="truncate text-[11px] leading-5 text-zinc-300" title={switchingTarget.label}>{switchingTarget.label}</p>
              </div>
            )}
            {suggestedLine && !switchingTarget && !controlsLocked && (
              <div
                role="status"
                aria-label="更优线路提示"
                aria-live="polite"
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                className="absolute right-3 top-3 z-30 w-64 max-w-[calc(100%-1.5rem)] rounded-lg border border-emerald-400/30 bg-zinc-950/90 px-3 py-2 text-left shadow-lg"
              >
                <div className="flex h-5 items-center justify-between gap-2">
                  <p className="flex items-center gap-1.5 text-xs font-semibold text-emerald-300">
                    <Zap className="h-3.5 w-3.5 shrink-0" />发现更优线路
                  </p>
                  <button
                    type="button"
                    aria-label="关闭更优线路提示"
                    disabled={!!suggestionPendingKey}
                    onClick={() => setDismissedSuggestions((prev) => new Set(prev).add(suggestionKey))}
                    className="-m-1 rounded p-1 text-zinc-400 hover:text-white disabled:opacity-40"
                  ><X className="h-4 w-4" /></button>
                </div>
                <div className="flex h-6 items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[11px] text-zinc-200" title={`${suggestedLine.siteName} · ${suggestedLine.flag}`}>
                      {suggestedLine.siteName} · {suggestedLine.flag} · {fmtRes(suggestedLine.metrics?.height)}
                    </p>
                  </div>
                  <button
                    type="button"
                    aria-label="切换到更优线路"
                    disabled={selectionBusy || !!suggestionPendingKey}
                    onClick={() => void acceptSuggestedLine()}
                    className="shrink-0 rounded bg-emerald-500 px-2 py-0.5 text-[11px] font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-70"
                  >
                    切换
                  </button>
                </div>
              </div>
            )}

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


        </div>

        {/* 加载状态汇总（播放器正下方）：任何进行中的加载动作都在这里展示动画与友好提示，
            测速/补充探测进行中附带进度条 */}
        {busyHints.length > 0 && (
          <div role="status" aria-live="polite" className="rounded-2xl border border-emerald-500/25 bg-emerald-500/[0.06] px-4 py-3 space-y-2.5">
            {busyHints.map((h) => (
              <div key={h} className="flex items-center gap-2.5 min-w-0">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-400 shrink-0" />
                <p className="text-xs text-zinc-300 leading-relaxed break-words">{h}</p>
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
                aria-label="查看全部线路"
                className="relative w-full flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 rounded-2xl border border-zinc-700/80 bg-zinc-800/60 hover:bg-zinc-700/60 hover:border-zinc-600 pl-4 pr-12 py-3 transition-colors text-left"
              >
                <span className="min-w-0 max-w-full block text-sm font-bold text-zinc-100 truncate">
                  {selectedMatch
                    ? `${selectedMatch.siteName}${activeLine?.flag ? ` · ${activeLine.flag}` : ' 选择线路'}`
                    : resource?.matches?.length
                      ? `已找到 ${resource.matches.length} 个来源，点击查看`
                      : '正在搜索来源…'}
                </span>
                <span className="flex min-w-0 max-w-full items-center gap-2.5 sm:justify-end">
                  {(() => {
                    const r = flagResult(activeLine?.flag || '');
                    const unavailable = selectedMatch && lineFailure(selectedMatch.siteKey, selectedMatch.vodId, activeLine?.flag);
                    if (unavailable) return <span className="text-[10px] text-zinc-500">本次会话不可用</span>;
                    if (r && r.status === 'ok' && r.metrics) return <MetricBadges metrics={r.metrics} />;
                    if (r?.status === 'fail') return <span className="text-[10px] font-bold text-rose-400/90">✕ 探测失败</span>;
                    return scan?.status === 'running' ? (
                      <span className="flex items-center gap-1 text-[10px] text-zinc-500 whitespace-nowrap">
                        <Loader2 className="w-3 h-3 animate-spin shrink-0" /> 待测速
                      </span>
                    ) : null;
                  })()}
                </span>
                <ListVideo aria-hidden="true" className="absolute right-4 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400 shrink-0" />
              </button>

              {betterLine && (
                <p
                  role="status"
                  aria-label="线路升级建议"
                  className="flex items-start gap-1.5 rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] leading-relaxed text-emerald-300/90"
                >
                  <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block truncate">发现更优线路：{betterLine.siteName} · {betterLine.flag} · {fmtRes(betterLine.metrics?.height)}</span>
                    <span className="block text-zinc-400">请在推荐线路中选择，切换保留进度。</span>
                  </span>
                </p>
              )}

              {/* 扫描进度与选集获取提示已上移到播放器下方的加载状态条 */}
              {scan && scan.status === 'done' && (
                <div className="flex items-center justify-between gap-2 text-[11px] px-1">
                  <span className="text-zinc-500 shrink-0">
                    {scan.stoppedEarly ? '测速完成 · 已锁定高质量线路' : '测速完成'}
                  </span>
                  <span className="text-zinc-400 truncate">
                    已测 {scan.results.length} 条，{selectableResults.filter((r) => r.status === 'ok' && r.flag).length} 条可用
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
                      : `已验证优先 · 共 ${selectableResults.filter((r) => r.status === 'ok' && r.flag).length} 条可用`}
                  </span>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-1.5">
                  {topLines.map((r, i) => {
                    const active = r.siteKey === selectedMatch?.siteKey && r.flag === activeLine?.flag;
                    const unavailable = lineFailure(r.siteKey, r.vodId, r.flag);
                    const loading = switchingTarget?.siteKey === r.siteKey && switchingTarget.flag === r.flag;
                    return (
                      <button
                        key={scanResultKey(r)}
                        disabled={!!unavailable || loading}
                        aria-busy={loading}
                        onClick={() => !active && !unavailable && applySource(r.siteKey, r.flag)}
                        title={unavailable ? `本次会话不可用：${r.siteName} · ${r.flag}（${unavailable.reason}）` : active ? `当前线路：${r.siteName} · ${r.flag}` : `切换到 ${r.siteName} · ${r.flag}${i === 0 ? '（综合最佳）' : ''}`}
                        className={`flex items-center gap-2 px-2.5 py-2 rounded-xl border transition-colors text-left ${
                          unavailable ? 'bg-zinc-900/50 border-zinc-800 opacity-50 grayscale cursor-not-allowed' : active
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
                          {unavailable ? <span className="text-[10px] text-zinc-400">本次会话不可用</span> : <MetricBadges metrics={r.metrics!} />}
                        </span>
                        {loading && <Loader2 role="status" aria-label="正在加载该线路" className="w-4 h-4 text-emerald-400 animate-spin shrink-0" />}
                        {active && !unavailable && !loading && (
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
        scan={scan ? { ...scan, results: pickerResults } : undefined}
        lineFailure={(siteKey, vodId, flag) => lineFailure(siteKey, vodId, flag)?.reason}
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
