export interface DownloadSource {
  movieId: string; title: string; siteKey: string; siteName: string; vodId: string;
  flag: string; episodeId: string; episodeName: string; episodeNumber: number;
}
export interface DownloadConfig { enabled: boolean; available: boolean; retentionHours: number }
export interface DownloadTask {
  id: string; status: string; source: Pick<DownloadSource, 'movieId' | 'title' | 'siteName' | 'flag' | 'episodeName' | 'episodeNumber'>;
  bytes_done: number; bytes_total: number; segments_done: number; segments_total: number;
  filename: string; size: number; duration: number; error: string; expires_at: number; file_available: boolean;
}
export const downloadStates: Record<string, string> = {
  queued: '排队中', resolving: '解析来源', downloading: '下载到服务器', muxing: '封装视频', verifying: '校验文件',
  completed: '文件已就绪', failed: '下载失败', cancelled: '已取消', interrupted: '已中断', expired: '已到期', deleted: '已删除', missing: '文件不存在',
};
export const activeDownload = (status: string) => ['queued', 'resolving', 'downloading', 'muxing', 'verifying'].includes(status);
export const retryDownload = (status: string) => ['failed', 'cancelled', 'interrupted', 'expired', 'missing'].includes(status);
export function formatBytes(value: number) {
  if (!value) return '0 B';
  const index = Math.min(3, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${['B', 'KB', 'MB', 'GB'][index]}`;
}
