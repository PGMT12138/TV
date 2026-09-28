import React, { useEffect, useState } from 'react';
import { X, Download, Loader2 } from 'lucide-react';
import { api, downloadBase } from '../api';
import { activeDownload, downloadStates, formatBytes, retryDownload, type DownloadSource, type DownloadTask, type DownloadConfig } from '../downloadTypes';

export function DownloadPanel({ source, onClose, onConfig }: {
  source?: DownloadSource; onClose: () => void; onConfig: (config: DownloadConfig) => void;
}) {
  const [items, setItems] = useState<DownloadTask[]>([]);
  const [config, setConfig] = useState<DownloadConfig>();
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [busy, setBusy] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let disposed = false, timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const settings = await api.downloadConfig();
        if (disposed) return;
        setConfig(settings); onConfig(settings);
        const data = await api.downloads(offset);
        if (disposed) return;
        setItems(data.items); setTotal(data.total); setLoaded(true); setReadError('');
      } catch (e: any) { if (!disposed) { setReadError(e.message); setLoaded(false); } }
      finally { if (!disposed) timer = setTimeout(refresh, 2000); }
    };
    void refresh();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => { disposed = true; clearTimeout(timer); document.removeEventListener('keydown', onKey, true); };
  }, [offset, onConfig, onClose]);
  const act = async (key: string, action: () => Promise<unknown>) => {
    setBusy(key); setError('');
    try { await action(); const data = await api.downloads(offset); setItems(data.items); setTotal(data.total); }
    catch (e: any) { setError(e.message); }
    finally { setBusy(''); }
  };
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/75 p-3" onClick={onClose}>
    <section role="dialog" aria-modal="true" aria-label="影片下载" className="w-full max-w-xl max-h-[88dvh] overflow-y-auto rounded-2xl border border-zinc-700 bg-zinc-950 p-5 text-zinc-100 shadow-2xl" onClick={e => e.stopPropagation()} onKeyDown={e => e.stopPropagation()}>
      <header className="flex items-center justify-between mb-4"><h2 className="text-lg font-semibold">影片下载</h2><button autoFocus aria-label="关闭下载面板" onClick={onClose} className="p-1.5 rounded-full border border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white hover:bg-zinc-700 transition-colors"><X className="w-4 h-4" /></button></header>
      <p className="text-xs text-zinc-400 mb-4">服务器准备完整视频后，点击保存到本机。准备期间可以继续观看或关闭页面；服务器文件保留 {config?.retentionHours ?? 24} 小时。</p>
      {config && !config.enabled && <p className="text-amber-300 text-sm mb-4" role="status">管理员已关闭影片缓存，已有文件仍可保存。</p>}
      {config && !config.available && <p className="text-amber-300 text-sm mb-4">服务器尚未配置视频下载工具。</p>}
      {source && <div className="bg-zinc-900 rounded-xl p-3 mb-4 text-sm">
        <div className="font-medium break-words">{source.title} · {source.episodeName}</div>
        <p className="text-xs text-zinc-400 my-2">{source.siteName} · {source.flag} · 完整视频</p>
        <button disabled={!config?.enabled || !config.available || !loaded || !!busy} onClick={() => act('create', () => api.createDownload(source))}
          className="flex items-center gap-2 rounded-lg border border-emerald-500 bg-emerald-600 px-3 py-2 hover:bg-emerald-500 transition-colors disabled:opacity-40 disabled:pointer-events-none">
          {busy === 'create' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}缓存当前影片 / 集数
        </button>
      </div>}
      {(error || readError) && <p role="alert" className="text-sm text-red-300 mb-4">{error || readError}</p>}
      <h3 className="text-sm font-semibold mb-3">我的下载记录</h3>
      {loaded && !items.length && <p className="text-sm text-zinc-500">暂无下载记录</p>}
      <div className="space-y-3">{items.map(task => {
        const progress = task.segments_total ? task.segments_done / task.segments_total : task.bytes_total ? task.bytes_done / task.bytes_total : 0;
        return <article key={task.id} className="border border-zinc-800 rounded-xl p-3 text-sm">
          <div className="font-medium break-words">{task.source.title} · {task.source.episodeName}</div>
          <div className="text-xs text-zinc-400 my-2">{task.source.siteName} · {task.source.flag}</div>
          <div className="flex justify-between gap-2 text-xs"><span>{downloadStates[task.status] || task.status}</span><span>{formatBytes(task.size || task.bytes_done)}{task.bytes_total ? ` / ${formatBytes(task.bytes_total)}` : ''}</span></div>
          {task.status === 'downloading' && <><progress aria-label="服务器下载进度" className="w-full h-2 my-2 accent-emerald-400" max="1" {...(progress ? { value: Math.min(progress, 1) } : {})} />{task.segments_total > 0 && <p className="text-xs text-zinc-500">分片 {task.segments_done} / {task.segments_total}</p>}</>}
          {task.error && <p className="text-xs text-amber-300 my-2">{task.error}</p>}
          {task.status === 'completed' && !task.file_available && <p className="text-xs text-amber-300 my-2">服务器文件已不存在</p>}
          {task.file_available && <p className="text-xs text-zinc-500 my-2">保留至 {new Date(task.expires_at * 1000).toLocaleString()}</p>}
          <div className="flex flex-wrap gap-2 mt-3 text-xs">
            {task.file_available && <a href={`${downloadBase}/${task.id}/file`} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1.5 text-emerald-300 hover:bg-emerald-500/25 transition-colors"><Download className="w-3.5 h-3.5" />保存到本机</a>}
            {activeDownload(task.status) && <button disabled={!!busy} onClick={() => act(task.id, () => api.cancelDownload(task.id))} className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:pointer-events-none">取消任务</button>}
            {retryDownload(task.status) && <button disabled={!!busy || !config?.enabled} className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:pointer-events-none" onClick={() => act(task.id, () => api.retryDownload(task.id))}>从头重试</button>}
            {!activeDownload(task.status) && task.status !== 'deleted' && <button disabled={!!busy} className="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-rose-300 hover:bg-rose-500/20 transition-colors disabled:opacity-40 disabled:pointer-events-none" onClick={() => { if (window.confirm('删除此任务的服务端文件？本机已下载文件不受影响。')) void act(task.id, () => api.deleteDownload(task.id)); }}>删除服务端文件</button>}
          </div>
        </article>;
      })}</div>
      {total > 100 && <div className="flex items-center justify-between mt-4 text-sm"><button disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 100))} className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:pointer-events-none">上一页</button><span className="text-xs text-zinc-400">{offset + 1}–{Math.min(offset + 100, total)} / {total}</span><button disabled={offset + 100 >= total} onClick={() => setOffset(offset + 100)} className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 transition-colors disabled:opacity-40 disabled:pointer-events-none">下一页</button></div>}
    </section>
  </div>;
}
