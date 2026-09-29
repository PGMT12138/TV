import Hls, { type ErrorData, type HlsConfig } from 'hls.js';

export function playbackHlsConfig(warm = false, startPosition = -1): Partial<HlsConfig> {
  const policy = Hls.DefaultConfig.fragLoadPolicy.default;
  return {
    startPosition,
    // 前向缓冲 3 分钟：maxBufferSize 同步放大否则高码率下会先被字节数截断；
    // backBufferLength 限制已播部分留存，避免长片整个留在内存里
    maxBufferLength: warm ? 15 : 180,
    maxMaxBufferLength: warm ? 30 : 360,
    maxBufferSize: (warm ? 30 : 180) * 1000 * 1000,
    backBufferLength: warm ? 10 : 180,
    fragLoadPolicy: { default: { ...policy, errorRetry: {
      ...policy.errorRetry!,
      shouldRetry: (config, count, timeout, response, retry) =>
        response?.code === 404 || response?.code === 410 ? count < 1 : retry,
    } } },
  };
}

export function isFileMedia(source: { play?: string; url?: string }, kind?: string): boolean {
  const ext = /\.(mp4|mkv|flv|avi|mov|webm|m4s|iso)(?=[?&#]|$)/i;
  const fileish = (value?: string) => {
    if (!value) return false;
    try { return ext.test(value) || ext.test(decodeURIComponent(value)); } catch { return ext.test(value); }
  };
  return kind === 'file' || fileish(source.play) || fileish(source.url);
}

export function missingFragment(data: ErrorData, attempts: Map<string, number>): { url: string; start: number } | undefined {
  // 403 一并计入：mgtv 等 CDN 分片签名过期回 403（对象清理后回 404），同属分片失效
  if (data.details !== Hls.ErrorDetails.FRAG_LOAD_ERROR || ![403, 404, 410].includes(data.response?.code || 0)) return;
  const url = data.frag?.url || data.response?.url || '';
  const count = (attempts.get(url) || 0) + 1;
  attempts.set(url, count);
  if (count < 2 && !data.fatal) return;
  return { url, start: data.frag?.start ?? Number.NaN };
}

export function bufferedAhead(video: HTMLVideoElement): number {
  for (let i = 0; i < video.buffered.length; i++) {
    if (video.buffered.start(i) <= video.currentTime + 0.1 && video.buffered.end(i) > video.currentTime)
      return video.buffered.end(i) - video.currentTime;
  }
  return 0;
}

/** 后面的坏分片尚未影响播放时只准备备用；接近缺口或已无可播数据才接替。 */
export function gapNeedsHandoff(video: HTMLVideoElement, start: number): boolean {
  return !Number.isFinite(start) || video.currentTime >= start - 5
    || (!video.paused && video.readyState < 3 && bufferedAhead(video) < 3);
}

export type WarmMedia = { video: HTMLVideoElement; hls?: Hls; destroy: () => void };

/** 在真实备用 video 中下载、seek、解码；主播放器在此期间完全不动。
 *  目标进度持续跟随主播放器，必须有对应缓冲和可呈现画面才可交接。
 */
export function prepareMedia(
  video: HTMLVideoElement,
  source: { play?: string; url?: string },
  options: {
    kind?: string;
    signal: AbortSignal;
    valid: () => boolean;
    position: () => number;
    paused: () => boolean;
    rate: () => number;
    canCommit?: () => boolean;
    onReady?: () => void;
    timeoutMs?: number;
  },
): Promise<WarmMedia> {
  return new Promise((resolve, reject) => {
    let hls: Hls | undefined;
    let finished = false;
    let playing = false;
    let decodedAt = -1;
    let frameId: number | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    let lastReadyAt = Date.now();
    let lastProgress = { readyState: 0, time: -1 };
    let announcedReady = false;
    let playRequested = false;
    const attempts = new Map<string, number>();
    const hasFrameCallback = typeof video.requestVideoFrameCallback === 'function';
    const destroy = () => {
      hls?.destroy();
      video.pause();
      video.removeAttribute('src');
      video.load();
    };
    const cleanup = () => {
      if (timer) clearInterval(timer);
      if (frameId !== undefined) video.cancelVideoFrameCallback?.(frameId);
      options.signal.removeEventListener('abort', abort);
      for (const event of ['loadedmetadata', 'canplay', 'seeked', 'timeupdate']) video.removeEventListener(event, check);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('seeking', onSeeking);
      video.removeEventListener('error', onError);
      hls?.off(Hls.Events.ERROR, onHlsError);
    };
    const fail = (error: Error) => {
      if (finished) return;
      finished = true;
      cleanup();
      destroy();
      reject(error);
    };
    const abort = () => fail(new DOMException('选线请求已取消', 'AbortError'));
    const onError = () => fail(new Error(video.error?.message || '备用线路无法解码'));
    const onSeeking = () => { decodedAt = -1; };
    const onPlaying = () => { playing = true; playRequested = false; check(); };
    const onHlsError = (_event: unknown, data: ErrorData) => {
      if (missingFragment(data, attempts) || data.fatal) fail(new Error(`备用线路加载失败：${data.response?.code || data.details}`));
    };
    const play = () => {
      if (playRequested || !video.paused) return;
      playRequested = true;
      video.play().then(() => { playRequested = false; }).catch((error) => fail(error));
    };
    const captureFrame = (_now: number, metadata: VideoFrameCallbackMetadata) => {
      decodedAt = metadata.mediaTime;
      check();
      if (!finished) frameId = video.requestVideoFrameCallback(captureFrame);
    };
    function check() {
      if (finished) return;
      if (options.signal.aborted || !options.valid()) { abort(); return; }
      // 预算 60s：4K 线路首分片大（实测伪装图床分片 1.2~1.5MB）且慢节点 TTFB 高，
      // 30s 内未就绪就判死会把仍在加载的站点误标记为会话不可用
      if (Date.now() - lastReadyAt > (options.timeoutMs || 60_000)) {
        fail(new Error('备用线路在目标进度未能起播')); return;
      }
      if (video.readyState < 1) return;
      // 有实质进展（缓冲层级提升 / 画面位置推进）就续预算：判死条件是"持续 60s 无任何进展"，
      // 而不是"启动后 60s 内没就绪"——慢站点加载中不该被标记会话不可用
      if (video.readyState > lastProgress.readyState || Math.abs(video.currentTime - lastProgress.time) > 0.25) {
        lastProgress = { readyState: video.readyState, time: video.currentTime };
        lastReadyAt = Date.now();
      }
      const target = Math.max(0, options.position());
      if (Number.isFinite(video.duration) && target >= video.duration) {
        fail(new Error('备用线路不包含当前播放位置')); return;
      }
      video.playbackRate = options.rate();
      if (Math.abs(video.currentTime - target) > 0.5 && !video.seeking) {
        decodedAt = -1;
        video.currentTime = target;
      }
      const aligned = !video.seeking && Math.abs(video.currentTime - target) <= 0.5;
      const framed = hasFrameCallback ? decodedAt >= 0 && Math.abs(decodedAt - target) <= 0.75 : playing;
      const needed = Number.isFinite(video.duration) ? Math.min(0.5, video.duration - target) : 0.5;
      const ready = aligned && framed && video.readyState >= 3 && bufferedAhead(video) >= needed;
      if (ready) {
        lastReadyAt = Date.now();
        if (!announcedReady) { announcedReady = true; options.onReady?.(); }
        if (!options.canCommit || options.canCommit()) {
          finished = true;
          cleanup();
          resolve({ video, hls, destroy });
          return;
        }
        // 预加载缺口尚远，保持同步；暂停时不让备用播放器在后台越播越远。
        if (options.paused()) video.pause(); else play();
      } else play();
    }
    video.muted = true;
    video.preload = 'auto';
    video.playsInline = true;
    options.signal.addEventListener('abort', abort, { once: true });
    for (const event of ['loadedmetadata', 'canplay', 'seeked', 'timeupdate']) video.addEventListener(event, check);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('seeking', onSeeking);
    video.addEventListener('error', onError);
    if (options.signal.aborted) { abort(); return; }
    if (hasFrameCallback) frameId = video.requestVideoFrameCallback(captureFrame);
    try {
      const src = source.play || source.url;
      if (!src) throw new Error('未获取到播放地址');
      if (!isFileMedia(source, options.kind) && Hls.isSupported()) {
        hls = new Hls(playbackHlsConfig(true, Math.max(0, options.position())));
        hls.on(Hls.Events.ERROR, onHlsError);
        hls.attachMedia(video);
        hls.loadSource(src);
      } else video.src = src;
      timer = setInterval(check, 100);
      check();
    } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
  });
}
