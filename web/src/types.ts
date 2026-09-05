export type MediaType = 'movie' | 'series' | 'anime' | 'doc';

export interface Episode {
  id: string;          // 资源集数播放地址（encodeURIComponent 后传给 /api/player）
  number: number;
  title: string;
  duration: string;
  previewUrl: string;
  videoUrl: string;
}

export interface CastMember {
  name: string;
  role: string;
  avatar: string;
}

export interface MovieItem {
  id: string;
  title: string;
  originalTitle: string;
  type: MediaType;
  cover: string; // 3:5 portrait poster
  backdrop: string; // 16:9 landscape backdrop
  rating: number;
  year: number;
  duration: string;
  genres: string[];
  region: string;
  quality: '4K HDR' | 'Dolby Vision' | '1080P Ultra';
  tagline: string;
  description: string;
  director: string;
  cast: CastMember[];
  episodes: Episode[];
  trailerVideoUrl: string;
  accentColor: 'emerald' | 'indigo' | 'purple' | 'cyan' | 'amber' | 'rose';
  isFeatured?: boolean;
  isTrending?: boolean;
  ranking?: number;
  source?: 'douban' | 'resource';
}

export interface WatchHistoryItem {
  id: string;
  movieId: string;
  episodeId: string;
  episodeNumber: number;
  episodeTitle: string;
  movieTitle: string;
  cover: string;
  backdrop: string;
  watchedSeconds: number;
  totalSeconds: number;
  progressPercent: number;
  lastWatchedAt: number; // timestamp
  siteKey?: string;      // 最后选择的来源站点（重新进入时优先恢复）
  flag?: string;         // 最后选择的线路
}

export interface UserProfile {
  id: string;
  name: string;
  watchTimeHours: number;
  joinedDate: string;
}

export type PageView = 'home' | 'search' | 'detail' | 'watch' | 'history' | 'favorites' | 'live';

// ---------------- 直播 ----------------

export interface LiveChannel {
  name: string;
  number: string;
  logo: string;
  lines: number;   // 线路数（同频道的多个播放地址）
  epg: boolean;    // 是否有节目单数据
}

export interface LiveGroup {
  name: string;
  channels: LiveChannel[];
}

export interface LiveSourceRef {
  name: string;
  activated?: boolean;
}

export interface LiveListData {
  name: string;
  groups: LiveGroup[];
  lives: LiveSourceRef[];
  deviceOnline?: boolean;
  error?: string;
}

export interface LivePlayData {
  url: string;
  play: string;            // 实际使用地址（直连原始 url 或服务端代理）
  proxy: string;           // 服务端代理地址（直连失败时回退用）
  direct: boolean;         // 是否浏览器直连
  hls: boolean;
  flv: boolean;
  local: boolean;          // 设备本地代理地址（经设备转发）
  protocol: string;        // http/https/rtmp/rtsp/...
  headers: Record<string, string>;
  error?: string;
}

export interface LiveEpgItem {
  title: string;
  start: string;
  end: string;
  startTime: number;       // epoch ms
  endTime: number;
  selected: boolean;       // 当前时段
}

export interface LiveEpgData {
  date: string;
  list: LiveEpgItem[];
  error?: string;
}

export interface LiveFavoriteItem {
  liveName: string;
  groupName: string;
  channelName: string;
  line: number;
  logo: string;
}

export interface LiveHistoryItem {
  liveName: string;
  groupName: string;
  channelName: string;
  line: number;
  logo: string;
  updatedAt: string; // 最后观看时间（服务端本地时间 ISO）
}

// ---- 直播体检（线路测速/清晰度/可用性探测） ----

export interface LiveProbeMetrics {
  kind?: 'hls' | 'flv' | 'raw';
  url?: string;
  openMs?: number;
  ttfbS?: number;
  firstFrameS?: number;
  throughputMbps?: number;
  width?: number;
  height?: number;
  codec?: string;
  scores?: { speed: number; quality: number; total: number };
}

export interface LiveProbeResult {
  group: string;
  channel: string;
  line: number;
  status: 'ok' | 'fail';
  error?: string;
  metrics?: LiveProbeMetrics;
}

export interface LiveScanState {
  status: 'running' | 'done';
  total: number;
  finished: number;
  error?: string;
}

/** 豆瓣榜单板块（首页策展专栏 Tab 数据源） */
export interface CatalogSection {
  key: string;
  title: string;
  ids: string[];
}

export interface FilterState {
  type: string;
  genre: string;
  region: string;
  year: string;
  sort: 'trending' | 'rating' | 'newest';
  query: string;
}

// ---------------- 播放资源（设备站点搜索结果） ----------------

export interface ResourceMatch {
  title: string;
  siteKey: string;
  siteName: string;
  vodId: string;
  pic: string;
  remarks: string;
  typeName: string;
  score: number;
}

export interface ResourceFlag {
  flag: string;          // 线路名
  episodes: Episode[];   // 该线路下的选集
}

export type ResourceStatus = 'idle' | 'searching' | 'selecting' | 'ready' | 'noresult' | 'offline' | 'error';

export interface ResourceState {
  status: ResourceStatus;
  matches: ResourceMatch[];
  selected?: ResourceMatch;      // 当前选中的来源站点
  flags: ResourceFlag[];         // 选中来源的线路与选集
  activeFlagIndex: number;
  error?: string;
  scan?: ScanState;              // 智能选源扫描（进入播放页自动触发）
  restoredPick?: boolean;        // 已从历史恢复用户上次的站点/线路，扫描不再自动切源
  awaitScan?: boolean;           // 首次加载且无历史偏好：等扫描出现可用线路再起播
  provisional?: boolean;         // 起播用的是扫描中的临时较优线路，全部完成后自动切最优
  searchEnded?: boolean;         // 聚合搜索 SSE 已结束（matches 已齐；冷搜渐进合并时扫描可能只覆盖了部分站点）
}

// ---------------- 智能选源（线路测速/清晰度/广告探测） ----------------

export type AdLevel = 'clean' | 'suspect' | 'dirty';

export interface ScanMetrics {
  openMs: number;             // playerContent 解析耗时
  ttfbS: number;              // 播放列表首字节
  firstFrameS: number;        // 首帧估计（解析+列表+首分片）
  throughputMbps: number;     // 首分片吞吐
  width?: number;
  height?: number;
  codec?: string;
  acodec?: string;           // 音频编码（eac3/ac3 的 MSE 支持参差，参与"播不了"判定）
  moovEnd?: boolean;         // MP4 索引在文件尾：手机浏览器顺序下载起播极慢，参与降权
  bitrateKbps?: number;
  durationS?: number;         // 正片总时长（m3u8 分片时长求和；mp4/未知为空）
  durationMatch?: 'short' | 'ok' | 'long';  // 与片库片长比对：short 疑似预告/假资源，long 疑似拼接广告
  durationDeltaS?: number;    // 与片库片长的差值（秒）
  adLevel: AdLevel;
  adSignals: string[];
  kind?: 'hls' | 'file';
  scores: { speed: number; quality: number; total: number };
}

export interface ScanCandidateResult {
  siteKey: string;
  siteName: string;
  vodId: string;
  flag: string;               // 站点级失败时为空
  status: 'ok' | 'fail';
  error?: string;
  metrics?: ScanMetrics;
  prio?: boolean;             // 优先批次实测标记：补充扫描回传 prior 时后端按此扣减优先额度
}

export interface ScanState {
  scanId: string;
  status: 'running' | 'done';
  total: number;
  finished: number;
  results: ScanCandidateResult[];
  stoppedEarly?: boolean;     // 达标即停：已锁定足够高质量线路，剩余站点未探测（选源弹窗可懒补测）
  extending?: boolean;        // 补充扫描进行中（聚合搜索结束后对其余站点再探一轮），提示文案区分用
  userPicked?: boolean;       // 用户手动换源后本影片不再自动切
  switched?: boolean;         // 已执行过自动切换
  recommendedKey?: string;    // `${siteKey}::${flag}`
  fastestKey?: string;
  highestKey?: string;
}

export const scanResultKey = (r: { siteKey: string; flag: string }) => `${r.siteKey}::${r.flag}`;
