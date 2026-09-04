"""直播线路体检引擎。

对「直播源 × 分组 × 频道 × 线路」逐个轻量探测，量化三个维度：
- 可用性：livePlay 解析 + 播放列表/分片实际可达（HTTP 状态 + 内容形态）；
- 速度：首分片有界下载吞吐，合成首帧估计（解析耗时 + 首字节 + 首分片）；
- 清晰度：m3u8 master 的 RESOLUTION 优先，否则 ffprobe 读首分片宽高（flv 头自带宽高）。

与影片探测（probe.py）同构但去掉广告/时长维度（直播天然短分片、无固定片长，两者均无意义）。
取流复用 probe._fetch（httpx 直连 / 经设备 fetch 双路径），探测出的速度即网页观看的真实速度。
结果落 live_probe 表（TTL 3h，直播源比采集站更易失效），失败也缓存以免每次进页重扫死源。
"""
import asyncio
import json
import secrets
import time
from urllib.parse import urljoin

from database import get_conn
from probe import (_call_device_wait, _emit, _fetch, _ffprobe,
                   _is_local, _parse_playlist, ScanTask, PLAYLIST_CAP)

LIVE_PROBE_TTL = 3 * 3600        # 探测结果缓存时长
LIVE_PLAY_TIMEOUT = 30.0         # livePlay 最长等待（parse=1 线路设备端 WebView 嗅探最长 25s）
LIVE_CHANNEL_CONCURRENCY = 6     # 同时探测的频道数；同频道线路必须串行——设备端 setIndex 改共享状态，并发同频道会竞态。
                                 # 设备只承担毫秒级 livePlay RPC，下载压力在服务端，可比影片探测（4）更宽
LIVE_SEG_CAP = 768 * 1024        # 首分片测速上限（比影片小，频道多、总量省）
LIVE_GROUP_CHANNEL_CAP = 10      # 每分组只探测前 N 个频道（分组内按频道表顺序取样）
LIVE_CHANNEL_LINE_CAP = 2        # 每频道只探测前 N 条线路（探测是抽检健康度，非全量体检）

_scans: dict[str, ScanTask] = {}
_runners: dict[str, asyncio.Task] = {}  # scan_id → 扫描协程任务，取消时直接 cancel 掐断在飞探测


def _cleanup_live_scans():
    for sid in [k for k, v in _scans.items() if time.time() - v.created > 1800]:
        _scans.pop(sid, None)
        _runners.pop(sid, None)


def get_live_scan(scan_id: str) -> ScanTask | None:
    return _scans.get(scan_id)


# ---------------- live_probe 缓存 ----------------

def _cache_set(live: str, group: str, channel: str, line: int, metrics: dict):
    try:
        conn = get_conn()
        conn.execute("INSERT OR REPLACE INTO live_probe (live_name, group_name, channel_name, line, metrics, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     (live, group, channel, line, json.dumps(metrics, ensure_ascii=False), time.time()))
        conn.commit()
        conn.close()
    except Exception:
        pass


def get_live_probe_results(live: str) -> list[dict]:
    """当前源全部新鲜探测结果（含失败）。行结构与 SSE result 事件一致：
    {group, channel, line, status, error?, metrics:{...}}——metrics 嵌套，前端统一消费。"""
    try:
        conn = get_conn()
        rows = conn.execute("SELECT group_name, channel_name, line, metrics, created_at FROM live_probe "
                            "WHERE live_name=? AND created_at > ?", (live, time.time() - LIVE_PROBE_TTL)).fetchall()
        conn.close()
        out = []
        for r in rows:
            m = json.loads(r["metrics"])
            metrics = {k: v for k, v in m.items() if k not in ("status", "error")}
            out.append({"group": r["group_name"], "channel": r["channel_name"], "line": r["line"],
                        "status": m.get("status", "fail"), "error": m.get("error"),
                        "metrics": metrics or None})
        return out
    except Exception:
        return []


def clean_live_probe(keep_seconds: float = 7 * 86400):
    """过期行清理，由路由低概率触发。"""
    try:
        conn = get_conn()
        conn.execute("DELETE FROM live_probe WHERE created_at < ?", (time.time() - keep_seconds,))
        conn.commit()
        conn.close()
    except Exception:
        pass


# ---------------- 评分 ----------------

def _score(first_frame_s: float, mbps: float, height: int | None) -> dict:
    speed = 0.6 * min(mbps / 25.0, 1.0) + 0.4 * max(0.0, min(1.0, (6.0 - first_frame_s) / 5.5))
    quality = min((height or 720) / 1080.0, 1.0)
    return {"speed": round(speed, 3), "quality": round(quality, 3),
            "total": round(0.5 * speed + 0.5 * quality, 3)}


# ---------------- 单线路探测 ----------------

def _ok(group: str, channel: str, line: int, metrics: dict) -> dict:
    return {"group": group, "channel": channel, "line": line, "status": "ok", "metrics": metrics}


def _fail(group: str, channel: str, line: int, error: str) -> dict:
    return {"group": group, "channel": channel, "line": line, "status": "fail", "error": error[:80]}


def _err(e: Exception) -> str:
    return str(e) or type(e).__name__  # httpx 超时类异常 str 为空，兜底用类名


async def _fetch_retry(url: str, headers: dict, cap: int, local: bool = False) -> dict:
    """取流失败重试一次：直播 CDN 常见瞬态故障——咪咕 gslb 节点随机 502（调度落点随机，
    稍候重试大概率换到健康节点）、突发限流超时；播放端 hls.js 本就自动重试+换线路，
    探测不重试会把这类线路误判为不可用。5xx/网络异常才重试，4xx 是确定性失败。"""
    pl = None
    for attempt in range(2):
        try:
            pl = await _fetch(url, headers, cap, local=local)
            if pl["status"] < 500 or attempt:
                break
        except Exception:
            if attempt:
                raise
        await asyncio.sleep(0.5)
    return pl


def _cache_row(live: str, res: dict):
    """把一条探测结果（含失败）写入 live_probe；metrics 与行字段合并存储。"""
    m = {**(res.get("metrics") or {}), "status": res["status"], "error": res.get("error")}
    _cache_set(live, res["group"], res["channel"], res["line"], m)


async def probe_line(live: str, group: str, channel: str, line: int) -> dict:
    """探测一条线路并落缓存。返回 SSE result 事件的结构。"""
    t0 = time.monotonic()
    data, err = None, None
    for attempt in range(2):
        # 设备端偶发无消息异常（Bridge.java 对 getMessage 为空的异常回字面量 "error"，
        # 源站瞬态 502 时解析器就会这样抛），重试一次与播放端行为一致
        try:
            data = await _call_device_wait("livePlay",
                                           {"live": live, "group": group, "channel": channel, "line": line},
                                           timeout=LIVE_PLAY_TIMEOUT)
            break
        except Exception as e:
            err = e
            if attempt or str(e) != "error":
                break
            await asyncio.sleep(1)
    if data is None:
        return _fail(group, channel, line, f"解析失败: {_err(err)}")
    open_ms = round((time.monotonic() - t0) * 1000)
    url = (data.get("url") or "").strip()
    headers = data.get("headers") or {}
    if not url:
        return _fail(group, channel, line, "播放地址为空")
    if not url.startswith(("http://", "https://")):
        return _fail(group, channel, line,
                     f"{data.get('protocol') or url.split(':', 1)[0]} 协议，浏览器暂不支持")
    local = bool(data.get("local"))
    flv = bool(data.get("flv")) or ".flv" in url.lower()

    try:
        if flv:
            return await _probe_flv(group, channel, line, url, headers, local, open_ms)
        pl = await _fetch_retry(url, headers, PLAYLIST_CAP, local=local)
        if pl["status"] >= 400:
            return _fail(group, channel, line, f"源站返回 HTTP {pl['status']}")
        body, ctype = pl["data"], (pl["ctype"] or "").lower()
        final = pl.get("url") or url
        if body[:7] == b"#EXTM3U" or "mpegurl" in ctype or ".m3u8" in url.lower() or ".m3u8" in final.lower():
            return await _probe_hls(group, channel, line, url, headers, local, pl, open_ms)
        # 302 到裸流（ts/未标类型）：按已下载字节测速，清晰度交给 ffprobe
        return await _probe_raw(group, channel, line, pl, open_ms)
    except Exception as e:
        return _fail(group, channel, line, f"探测失败: {_err(e)}")


def _finish_ok(group: str, channel: str, line: int, metrics: dict) -> dict:
    metrics["status"] = "ok"
    metrics["scores"] = _score(metrics["firstFrameS"], metrics["throughputMbps"], metrics.get("height"))
    return _ok(group, channel, line, metrics)


async def _probe_flv(group: str, channel: str, line: int, url: str, headers: dict,
                     local: bool, open_ms: int) -> dict:
    sg = await _fetch_retry(url, headers, LIVE_SEG_CAP, local=local)
    if sg["status"] >= 400:
        return _fail(group, channel, line, f"源站返回 HTTP {sg['status']}")
    if not sg["data"]:
        return _fail(group, channel, line, "FLV 流无数据")
    mbps = round(len(sg["data"]) * 8 / sg["elapsed"] / 1e6, 2) if sg["elapsed"] > 0.05 else 0.0
    info = await _ffprobe(sg["data"]) or {}  # flv 头自带宽高，ffprobe 读前几 KB 即可
    return _finish_ok(group, channel, line, {
        "kind": "flv", "url": url, "openMs": open_ms, "ttfbS": round(sg["ttfb"], 3),
        "firstFrameS": round(open_ms / 1000 + sg["elapsed"], 2), "throughputMbps": mbps,
        "width": info.get("width"), "height": info.get("height"), "codec": info.get("codec"),
    })


async def _probe_hls(group: str, channel: str, line: int, url: str, headers: dict,
                     local: bool, pl: dict, open_ms: int) -> dict:
    text = pl["data"].decode("utf-8", "replace")
    url = pl.get("url") or url  # 同 probe._probe_hls：分片拼接基准用 302 后最终地址，入口地址可能是带鉴权的跳转壳
    variants, segments = _parse_playlist(text)
    master_wh = None
    ttfb = round(pl["ttfb"], 3)
    if variants:
        best = max(variants, key=lambda v: v["bandwidth"])
        if best.get("resolution") and "x" in best["resolution"]:
            try:
                w, h = best["resolution"].lower().split("x")
                master_wh = (int(w), int(h))
            except ValueError:
                master_wh = None
        var_url = urljoin(pl.get("url") or url, best["url"])
        pl2 = await _fetch_retry(var_url, headers, PLAYLIST_CAP, local=_is_local(var_url) or local)
        if pl2["status"] >= 400:
            return _fail(group, channel, line, f"子播放列表 HTTP {pl2['status']}")
        _, segments = _parse_playlist(pl2["data"].decode("utf-8", "replace"))
        url, ttfb = (pl2.get("url") or var_url), round(pl2["ttfb"], 3)
    if not segments:
        return _fail(group, channel, line, "播放列表无分片")
    seg_url = urljoin(url, segments[0]["url"])
    sg = await _fetch_retry(seg_url, headers, LIVE_SEG_CAP, local=_is_local(seg_url) or local)
    if sg["status"] >= 400:
        return _fail(group, channel, line, f"分片 HTTP {sg['status']}")
    seg_time = round(sg["elapsed"], 3)
    mbps = round(len(sg["data"]) * 8 / sg["elapsed"] / 1e6, 2) if sg["elapsed"] > 0.05 else 0.0
    info = await _ffprobe(sg["data"]) or {}
    return _finish_ok(group, channel, line, {
        "kind": "hls", "url": url, "openMs": open_ms, "ttfbS": ttfb,
        "firstFrameS": round(open_ms / 1000 + ttfb + seg_time, 2), "throughputMbps": mbps,
        "width": master_wh[0] if master_wh else info.get("width"),
        "height": master_wh[1] if master_wh else info.get("height"),
        "codec": info.get("codec"),
    })


async def _probe_raw(group: str, channel: str, line: int, pl: dict, open_ms: int) -> dict:
    if not pl["data"]:
        return _fail(group, channel, line, f"非媒体地址({pl['ctype'] or '未知类型'})")
    mbps = round(len(pl["data"]) * 8 / pl["elapsed"] / 1e6, 2) if pl["elapsed"] > 0.05 else 0.0
    info = await _ffprobe(pl["data"]) or {}
    return _finish_ok(group, channel, line, {
        "kind": "raw", "url": "", "openMs": open_ms, "ttfbS": round(pl["ttfb"], 3),
        "firstFrameS": round(open_ms / 1000 + pl["elapsed"], 2), "throughputMbps": mbps,
        "width": info.get("width"), "height": info.get("height"), "codec": info.get("codec"),
    })


# ---------------- 扫描编排 ----------------

def plan_channels(table: dict, group: str = "") -> list[tuple[str, str, int]]:
    """按分组顺序展开 (group, channel, lines) 的抽样探测计划：每分组只取前
    LIVE_GROUP_CHANNEL_CAP 个频道、每频道只取前 LIVE_CHANNEL_LINE_CAP 条线路
    （前 N 频道按频道表顺序即台号序；抽样后的徽章/最优线路对全量频道依然成立，
    未探测线路无徽章而已）。group 非空时只探测该分组（手动体检按当前分组发起）。"""
    out: list[tuple[str, str, int]] = []
    for g in (table.get("groups") or []):
        if group and g.get("name") != group:
            continue
        for c in (g.get("channels") or [])[:LIVE_GROUP_CHANNEL_CAP]:
            n = min(int(c.get("lines") or 1), LIVE_CHANNEL_LINE_CAP)
            out.append((g.get("name") or "", c.get("name") or "", n))
    return out


async def start_live_scan(live: str, table: dict, group: str = "") -> str:
    """live 为已解析的源名；table 为 liveList 结果；
    group 非空时只探测该分组（手动体检按当前分组发起）。"""
    scan_id = secrets.token_hex(8)
    task = ScanTask()
    task.cancelled = False
    _scans[scan_id] = task
    _cleanup_live_scans()
    _runners[scan_id] = asyncio.get_event_loop().create_task(_run_live_scan(task, live, table, group))
    return scan_id


def cancel_live_scan(scan_id: str) -> bool:
    """请求取消：除置标志位外直接 cancel 扫描协程，在飞的设备 RPC/分片下载在 await 点立即中断，
    已发起但未完成的线路不计结果；done 事件带 cancelled 标记。"""
    task = _scans.get(scan_id)
    if task is None or task.done:
        return False
    task.cancelled = True
    runner = _runners.get(scan_id)
    if runner is not None and not runner.done():
        runner.cancel()
    return True


async def _run_live_scan(task: ScanTask, live: str, table: dict, group: str = ""):
    channels = plan_channels(table, group)
    total = sum(n for _, _, n in channels)
    _emit(task, {"type": "meta", "total": total, "channels": len(channels), "group": group})
    if not channels:
        _emit(task, {"type": "done", "total": 0, "ok": 0, "perGroup": {}})
        task.done = True
        return

    sem = asyncio.Semaphore(LIVE_CHANNEL_CONCURRENCY)
    per_group: dict[str, dict] = {}
    ok_count = 0
    aborted = False

    async def one_channel(group: str, channel: str, nlines: int):
        nonlocal aborted, ok_count
        async with sem:
            for li in range(nlines):
                if aborted or getattr(task, "cancelled", False):
                    return
                res = await probe_line(live, group, channel, li)
                _cache_row(live, res)
                g = per_group.setdefault(group, {"ok": 0, "total": 0})
                g["total"] += 1
                if res["status"] == "ok":
                    ok_count += 1
                    g["ok"] += 1
                _emit(task, {"type": "result", "result": res})
                # 设备掉线：等一轮桥接重连退避，仍不在线则中止，避免刷大量重复失败
                if not aborted and res["status"] == "fail" and "设备未连接" in (res.get("error") or ""):
                    await asyncio.sleep(15)
                    from bridge import active_device
                    dev = active_device()
                    if dev is None or not dev.online:
                        aborted = True
                        _emit(task, {"type": "done", "error": "设备连接中断，部分线路未完成探测"})

    try:
        await asyncio.gather(*[one_channel(g, c, n) for g, c, n in channels])
        if not aborted:
            _emit(task, {"type": "done", "total": total, "ok": ok_count, "perGroup": per_group,
                         "cancelled": bool(getattr(task, "cancelled", False))})
    except asyncio.CancelledError:
        # 外部取消：gather 已把 CancelledError 传导给所有在飞线路，立即汇报后保持任务取消态
        _emit(task, {"type": "done", "total": total, "ok": ok_count, "perGroup": per_group, "cancelled": True})
        raise
    except Exception as e:
        _emit(task, {"type": "done", "error": str(e)[:120]})
    finally:
        task.done = True
        cur = asyncio.current_task()
        for sid in [s for s, r in _runners.items() if r is cur]:
            _runners.pop(sid, None)
