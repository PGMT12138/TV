"""智能选源探测引擎。

对「站点×线路」候选逐个轻量探测，量化四个维度：
- 速度：playerContent 解析耗时 + 播放列表首字节时间 + 首个分片吞吐，合成首帧估计；
- 清晰度：m3u8 master 的 RESOLUTION 优先，否则下载首个分片用 ffprobe 读宽高（未装 ffprobe 则未知）；
- 广告：前置贴片 + 中段拼接启发式（前/中部分片时长离群聚类、首段异域、DISCONTINUITY 拼接缝、
  重定向广告域、双帧角标静止检测），输出 clean / suspect / dirty 三级 + 证据文案，只标记不剥离；
- 时长：m3u8 分片 EXTINF 求和，与片库片长（ref_s）交叉比对，短/长异常参与评分。

取流走与 /stream 相同的两条路径（httpx 直连回源 / 经设备 fetch 转发），探测出的速度即网页观看的真实速度。
每次探测滚动写入 site_stats，站点历史广告率作为排序先验；探测结果不做缓存，每次扫描逐线实测。
"""
import asyncio
import collections
import json
import os
import re
import secrets
import shutil
import subprocess
import time
from urllib.parse import urljoin, urlparse

import httpx

from database import get_conn, record_site_probe_duration, get_line_probe_averages
from bridge import active_device, call_device, _ids

PLAYER_TIMEOUT = 25.0         # playerContent 最长等待（含 WebView 嗅探/网盘转存）
FETCH_TIMEOUT = 15.0
DETAIL_TIMEOUT = 20.0
DETAIL_CONCURRENCY = 3        # 并发过高会压垮设备爬虫（QuickJS/Chaquopy 高负载）导致桥接心跳超时断开
PROBE_CONCURRENCY = 4
RECONNECT_WAIT = 90.0         # 设备掉线后等待桥接重连的上限（App 侧重连退避最长 60s）
FLAGS_PER_SITE = 8            # 每站点最多探测的线路数（同站线路多为同一上游，全探浪费且压垮设备爬虫）

# ---------------- 智能扫描（优先线路全量实测 + 普通线路达标即停） ----------------
# 优先批次：名字带 4K/蓝光/超清等关键词的线路先全部实测（全局 ≤50 条），不受达标即停限制，
# 探完再进入普通线路流程；关键词线路不足 30 条时（冷门片常见），从普通批次按排序规则
# 提级补齐到 50 条保证探测覆盖面；超额时按"站点历史先验 + 关键词规格"全局择优取优质线路。
# 普通线路按"可能好的"先探，探到足够多的好线路立即收工，余下留给选源弹窗的懒补测；
# 冷门片找不到达标线路时自然退化为全量扫描，探测预算自动花在需要的地方。
SCAN_SITES_CAP = 60           # 扫描站点上限：与前端 matches 上限 60 对齐——命中站点一个不丢，
                              # 探测规模由"全局优先额度 50 + 每站 8 条 + 达标即停"约束（曾为 30，
                              # 超出站点的优先线会被无感丢弃，玩具总动员5 实测漏了剧圈影视 BB蓝光1）
PRIORITY_LINES_CAP = 50       # 优先线路（4K/蓝光/超清等）实测条数上限：全部探完才进入普通线路流程
PRIORITY_FILL_MIN = 30        # 优先批次条数下限：不足时从普通批次按排序提级补齐到优先额度
GOOD_LINES_TARGET = 3         # 达标线路数目标：探到这么多条"够好"的即提前结束
GOOD_MIN_MBPS = 3.0           # 够好线路的首分片吞吐下限
HIGH_MIN_HEIGHT = 1080        # 达标条件之一：至少一条线路清晰度 ≥ 此值
TRAILER_MAX_S = 120           # 时长绝对下限：片库无片长可比对时，正片（电影/单集）不可能
                              # 只有 2 分钟以内——这几乎必是预告片/花絮（玩具总动员5 4K 宣传片实例）
# 线路名只是营销话术（"4K"线实测可能 1616p），但只用于探测排序不影响结果，零风险
FLAG_GOOD_HINTS = ("4k", "蓝光", "超清", "hdr", "1080", "2160", "杜比", "原盘")
FLAG_LATE_HINTS = ("爱奇艺", "优酷", "腾讯", "mgtv", "bilibili", "哔哩", "vip",
                   "解析", "花絮", "预告", "可下载", "备用", "有广告")
PLAYLIST_CAP = 2 * 1024 * 1024
SEGMENT_CAP = 1536 * 1024
FILE_FFPROBE_CAP = 16 * 1024 * 1024  # MP4 直链补读上限：网盘转存文件的 moov 盒可远超 2MB（实测夸克 4K 线 5.7MB）
TAIL_FFPROBE_CAP = 6 * 1024 * 1024   # moov 在文件尾时的 Range 后缀回读上限（剧集单集 moov 实测数 MB 内）
TMP_DIR = os.path.join(os.path.dirname(__file__), "data", "tmp")

FFPROBE = shutil.which("ffprobe")
FFMPEG = shutil.which("ffmpeg")

# 广告/统计域特征（hostname 子串匹配，仅作为信号之一，单信号只判 suspect）
AD_HOST_TOKENS = ("doubleclick", "googlesyndication", "popads", "cnzz", "umeng", "51.la",
                  "adserver", "adsystem", "adplus", "tracking", "analytics", "beacon")

AD_RANK = {"clean": 0, "suspect": 1, "dirty": 2}
FILE_EXTS = (".mp4", ".mkv", ".flv", ".avi", ".mov", ".m4v", ".ts", ".mp3", ".m4a")

_ATTR_RE = re.compile(r"([A-Z0-9-]+)=(\"[^\"]*\"|[^,]*)")


class ScanTask:
    """一次扫描：events 为已产生事件（SSE 重连重放用，消费端按 key 幂等合并），queue 供实时消费。"""

    def __init__(self):
        self.events: list[dict] = []
        self.queue: asyncio.Queue = asyncio.Queue()
        self.done = False
        self.created = time.time()


_scans: dict[str, ScanTask] = {}
_client = None


def _emit(task: ScanTask, ev: dict):
    task.events.append(ev)
    task.queue.put_nowait(ev)


def _cleanup_scans():
    for sid in [k for k, v in _scans.items() if time.time() - v.created > 1800]:
        _scans.pop(sid, None)


async def _call_device_wait(action: str, params: dict, timeout: float) -> dict:
    """设备掉线（爬虫高负载下桥接可能闪断重连）时等它回来再重试一次。"""
    for attempt in range(2):
        try:
            return await call_device(action, params, timeout=timeout)
        except RuntimeError as e:
            if attempt or "设备未连接" not in str(e):
                raise
            deadline = time.monotonic() + RECONNECT_WAIT
            dev = active_device()
            while time.monotonic() < deadline and (dev is None or not dev.online):
                await asyncio.sleep(5)
                dev = active_device()
            if dev is None or not dev.online:
                raise


async def start_scan(matches: list[dict], ref_s: float | None = None, fresh: bool = False,
                     prior: list[dict] | None = None) -> str:
    """matches: [{key, id, name}]，已按匹配分排序、按站点去重；ref_s 为片库片长（秒），供时长交叉比对。
    fresh=True 为手动重探：不做"达标即停"早停（用户要求全量重测）。
    prior 为本片此前各轮扫描已实测的线路结果（前端合并扫描状态，含 metrics）：
    ① 优先批次的 PRIORITY_LINES_CAP 上限跨扫描累计封顶；② 早停条件与最终推荐键按
    "历史 + 本轮"全局口径评估——否则补充扫描自身凑不齐达标条件时，普通批次会对已达标的片继续空转。"""
    scan_id = secrets.token_hex(8)
    task = ScanTask()
    _scans[scan_id] = task
    _cleanup_scans()
    asyncio.get_event_loop().create_task(_run_scan(task, matches, ref_s, fresh, prior))
    return scan_id


def get_scan(scan_id: str) -> ScanTask | None:
    return _scans.get(scan_id)


# ---------------- 取流（与 /stream 同路径：直连 / 经设备） ----------------

def _is_local(url: str) -> bool:
    try:
        return (urlparse(url).hostname or "") in ("127.0.0.1", "localhost")
    except Exception:
        return False


def _http_client() -> httpx.AsyncClient:
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(12.0, read=20.0),
                                    limits=httpx.Limits(max_connections=PROBE_CONCURRENCY * 2))
    return _client


async def _fetch(url: str, headers: dict, cap: int, local: bool = False,
                 timeout: float = FETCH_TIMEOUT) -> dict:
    """有界下载，客户端读满 cap 即断开。返回 {status, ctype, data, ttfb, elapsed, redirects, url}，
    url 为跟随重定向后的最终地址——播放列表内的相对路径必须以它为基准拼接（php 入口 302 到 CDN
    时用入口地址作基准必 404）。直连路径不发 Range 头：直播 CDN（如咪咕 gslb）对 Range 请求回
    502，且播放列表/直播流是动态内容本无 Range 语义，有界统一由客户端断流保证；经设备路径保留
    range 参数（设备端无客户端截断，靠它限制设备侧下载量）。"""
    if local:
        dev = active_device()
        if dev is None or not dev.online:
            raise RuntimeError("设备未连接")
        rid = next(_ids)
        q: asyncio.Queue = asyncio.Queue()
        dev.streams[rid] = q
        try:
            t0 = time.monotonic()
            await dev.ws.send_json({"id": rid, "action": "fetch", "params": {
                "url": url, "headers": headers,
                "range": f"bytes=0-{cap - 1}" if cap else ""}})
            meta = await asyncio.wait_for(q.get(), timeout=timeout)
            if not isinstance(meta, dict) or meta.get("type") != "meta":
                raise RuntimeError(meta.get("error", "设备取流失败") if isinstance(meta, dict) else "设备取流失败")
            ttfb = time.monotonic() - t0
            status = int(meta.get("status", 200))
            mh = meta.get("headers") or {}
            ctype = mh.get("Content-Type") or mh.get("content-type") or ""
            parts, total = [], 0
            while total < cap:
                item = await asyncio.wait_for(q.get(), timeout=timeout)
                if item is None or isinstance(item, dict):
                    break
                parts.append(item)
                total += len(item)
            return {"status": status, "ctype": ctype, "data": b"".join(parts)[:cap],
                    "ttfb": ttfb, "elapsed": time.monotonic() - t0, "redirects": [],
                    "url": meta.get("url") or url}
        finally:
            dev.streams.pop(rid, None)
    client = _http_client()
    t0 = time.monotonic()
    resp = await client.send(client.build_request("GET", url, headers=dict(headers)), stream=True)
    try:
        ttfb = time.monotonic() - t0
        parts, total = [], 0
        async for chunk in resp.aiter_bytes(65536):
            parts.append(chunk)
            total += len(chunk)
            if total >= cap:
                break
        return {"status": resp.status_code, "ctype": resp.headers.get("content-type", ""),
                "data": b"".join(parts)[:cap], "ttfb": ttfb, "elapsed": time.monotonic() - t0,
                "redirects": [str(r.url.host) for r in resp.history], "url": str(resp.url)}
    finally:
        await resp.aclose()


# ---------------- m3u8 解析与广告启发式 ----------------

def _parse_playlist(text: str):
    """返回 (variants, segments)。variant: {url, bandwidth, resolution}；segment: {url, duration, disc}。"""
    variants, segments = [], []
    pending_dur, pending_variant, disc = None, None, False
    for raw in text.split("\n"):
        line = raw.strip()
        if not line:
            continue
        if line.startswith("#EXT-X-STREAM-INF"):
            attrs = {k: v.strip('"') for k, v in _ATTR_RE.findall(line)}
            pending_variant = {"bandwidth": int(attrs.get("BANDWIDTH") or 0),
                               "resolution": attrs.get("RESOLUTION", "")}
        elif line.startswith("#EXTINF:"):
            try:
                pending_dur = float(line.split(":", 1)[1].split(",", 1)[0])
            except ValueError:
                pending_dur = None
        elif line.startswith("#EXT-X-DISCONTINUITY"):
            disc = True
        elif line.startswith("#"):
            continue
        elif pending_variant is not None:
            pending_variant["url"] = line
            variants.append(pending_variant)
            pending_variant = None
        else:
            segments.append({"url": line, "duration": pending_dur or 0.0, "disc": disc})
            disc, pending_dur = False, None
    return variants, segments


def _host(url: str) -> str:
    try:
        return (urlparse(url).hostname or "").lower()
    except Exception:
        return ""


def _ad_level(signals: list[str]) -> str:
    """≥2 个信号判 dirty，1 个判 suspect，否则 clean。"""
    return "dirty" if len(signals) >= 2 else ("suspect" if signals else "clean")


def _midroll_blocks(segments: list[dict], med: float, hosts_all: list[str]) -> list[dict]:
    """中部疑似广告块：连续短分片聚类成块，需（时长离群 / 与主流分片异域 / 块边界有拼接缝）至少命中两项。

    med 为全列表分片时长中位数；分片太少或整体粒度偏短（med<20s，天然短分片源）时不判。
    """
    n = len(segments)
    if n < 10 or med < 20:
        return []
    # 主流域名 = 覆盖 ≥25% 分片的域；整个列表只有两三个域时，占比小的就是外链块
    counts = collections.Counter(h for h in hosts_all if h)
    main_hosts = {h for h, c in counts.items() if c >= max(3, int(n * 0.25))}

    def short(i: int) -> bool:
        d = segments[i]["duration"]
        return 0 < d <= min(18, 0.6 * med)

    blocks = []
    i = 1  # 0 号分片归前置贴片逻辑
    while i < n - 1:
        if not short(i):
            i += 1
            continue
        j = i
        while j < n - 1 and (short(j) or segments[j]["disc"]):
            j += 1
        block_hosts = {hosts_all[k] for k in range(i, j) if hosts_all[k]}
        evid = 1  # 时长离群由聚类前提保证
        if block_hosts and not (block_hosts & main_hosts):
            evid += 1
        if segments[i]["disc"] or segments[j]["disc"]:
            evid += 1
        secs = sum(segments[k]["duration"] for k in range(i, j))
        if evid >= 2 and 0 < secs <= 300:  # 广告块按常识不超过 5 分钟
            blocks.append({"from": i, "to": j, "secs": secs})
        i = j
    # 相邻块间隔 ≤2 个正常分片时合并（同一广告被 DISCONTINUITY 切开的情况）
    merged: list[dict] = []
    for b in blocks:
        if merged and b["from"] - merged[-1]["to"] <= 2:
            merged[-1]["to"] = b["to"]
            merged[-1]["secs"] += b["secs"]
        else:
            merged.append(b)
    return merged


def _detect_ads(segments: list[dict], redirect_hosts: list[str]) -> tuple[str, list[str]]:
    """广告启发式：前置贴片 + 中段拼接，信号数分级（见 _ad_level）。"""
    signals = []
    # ---- 前置贴片 ----
    if any(s["disc"] for s in segments[:6]):
        signals.append("前部存在流拼接")
    if len(segments) >= 4:
        head = segments[0]["duration"]
        rest = sorted(s["duration"] for s in segments[1:] if s["duration"] > 0)
        if head > 0 and rest:
            med_rest = rest[len(rest) // 2]
            if med_rest >= 20 and head <= 18 and head < 0.6 * med_rest:
                signals.append(f"首段时长异常({head:.0f}s/{med_rest:.0f}s)")
    hosts = [_host(s["url"]) for s in segments[2:10] if s["url"]]
    hosts = [h for h in hosts if h]
    first = _host(segments[0]["url"]) if segments else ""
    if first and hosts and first not in hosts:
        signals.append("首段与后续分片不同域")
    for h in redirect_hosts:
        if any(tok in h for tok in AD_HOST_TOKENS):
            signals.append("重定向经过广告域")
            break
    # ---- 中段拼接广告 ----
    durs = [s["duration"] for s in segments if s["duration"] > 0]
    med = sorted(durs)[len(durs) // 2] if durs else 0
    hosts_all = [_host(s["url"]) for s in segments]
    blocks = _midroll_blocks(segments, med, hosts_all)
    if blocks:
        total = sum(b["secs"] for b in blocks)
        pos = blocks[0]["from"]
        signals.append(f"中部疑似广告{len(blocks)}段(约{total:.0f}s,第{pos + 1}片起)")
        if len(blocks) >= 2:
            signals.append(f"正片被拼接为{len(blocks) + 1}段")
    return _ad_level(signals), signals


# ---------------- ffprobe ----------------

def _ffprobe_sync(data: bytes) -> dict | None:
    path = os.path.join(TMP_DIR, f"p{os.getpid()}_{next(_ids)}.bin")
    try:
        os.makedirs(TMP_DIR, exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
        out = subprocess.run(
            [FFPROBE, "-v", "quiet", "-print_format", "json",
             "-show_entries", "stream=codec_type,codec_name,width,height:format=duration", path],
            capture_output=True, timeout=10).stdout
        parsed = json.loads(out or b"{}")
        info: dict = {}
        for st in (parsed.get("streams") or []):
            if st.get("codec_type") == "video" and "codec" not in info:
                info.update(width=st.get("width"), height=st.get("height"), codec=st.get("codec_name"))
            elif st.get("codec_type") == "audio" and "acodec" not in info:
                # 音频编码浏览器 MSE 支持参差（EAC3/AC3 常缺），前端播不了判定要用
                info["acodec"] = st.get("codec_name")
        # 容器总时长（HLS 分片文件是单分片时长、不消费；MP4 直链靠它做正片/预告片比对）
        try:
            info["duration"] = round(float((parsed.get("format") or {}).get("duration") or 0), 1) or None
        except (TypeError, ValueError):
            info["duration"] = None
        return info or None
    except Exception:
        return None
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return None


async def _ffprobe(data: bytes) -> dict | None:
    if not FFPROBE or len(data) < 4096:
        return None
    return await asyncio.to_thread(_ffprobe_sync, data)


# ---------------- 角标静止检测（双帧比对） ----------------

FRAME_W, FRAME_H = 480, 270  # 抽帧统一缩放尺寸（rgb24，固定大小便于逐像素比对）


def _frame_sync(data: bytes) -> bytes | None:
    """从媒体数据抽首帧并缩放为固定尺寸 rgb24，失败返回 None。"""
    try:
        out = subprocess.run(
            [FFMPEG, "-v", "error", "-i", "pipe:0", "-frames:v", "1",
             "-vf", f"scale={FRAME_W}:{FRAME_H}", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
            input=data, capture_output=True, timeout=10).stdout
        return out if len(out) >= FRAME_W * FRAME_H * 3 else None
    except Exception:
        return None


async def _frame(data: bytes) -> bytes | None:
    if not FFMPEG or len(data) < 4096:
        return None
    return await asyncio.to_thread(_frame_sync, data)


def _region_diff(a: bytes, b: bytes, x: int, y: int, w: int, h: int) -> float:
    """两帧同区域平均逐字节差（0~255）。"""
    total = 0
    for row in range(h):
        off = ((y + row) * FRAME_W + x) * 3
        ra, rb = a[off:off + w * 3], b[off:off + w * 3]
        total += sum(abs(p - q) for p, q in zip(ra, rb))
    return total / (h * w * 3)


def _static_corner(fa: bytes, fb: bytes, x: int, y: int, w: int, h: int) -> bool:
    """角落切 4x4 子块取最小差：水印只盖住角落局部时也能命中（整角均值会被背景噪声淹没）。"""
    cw, ch = max(8, w // 4), max(8, h // 4)
    for r in range(4):
        for c in range(4):
            if _region_diff(fa, fb, x + c * cw, y + r * ch, cw, ch) < 25:
                return True
    return False


def _watermark_signal(fa: bytes | None, fb: bytes | None) -> str | None:
    """画面主体已变而某角几乎不变 → 疑似烧录角标（台标同理，只作 suspect 级信号）。"""
    if not fa or not fb:
        return None
    cw, ch = 108, 54
    corners = {"左上": (0, 0), "右上": (FRAME_W - cw, 0),
               "左下": (0, FRAME_H - ch), "右下": (FRAME_W - cw, FRAME_H - ch)}
    center = _region_diff(fa, fb, FRAME_W // 2 - cw // 2, FRAME_H // 2 - ch // 2, cw, ch)
    if center < 22:  # 两帧画面几乎相同，静止角标无从分辨
        return None
    hits = [name for name, (x, y) in corners.items() if _static_corner(fa, fb, x, y, cw, ch)]
    if hits:
        return f"疑似水印角标({'、'.join(hits)})"
    return None


# ---------------- 站点统计 ----------------

def _stats_insert(site_key: str, ok: bool, ad_level: str, speed: float | None, height: int | None):
    try:
        conn = get_conn()
        conn.execute("INSERT INTO site_stats (site_key, ok, ad_level, speed_mbps, height, created_at) "
                     "VALUES (?, ?, ?, ?, ?, ?)",
                     (site_key, 1 if ok else 0, ad_level if ok else "", speed, height, time.time()))
        conn.commit()
        conn.close()
    except Exception:
        pass


def _site_ad_rate(site_key: str) -> float:
    """站点最近 50 次探测的广告率（dirty=1/suspect=0.5），0~1，作排序先验。"""
    try:
        conn = get_conn()
        rows = conn.execute("SELECT ad_level FROM site_stats WHERE site_key=? AND ok=1 "
                            "ORDER BY id DESC LIMIT 50", (site_key,)).fetchall()
        conn.close()
        if not rows:
            return 0.0
        score = sum({"dirty": 1.0, "suspect": 0.5}.get(r["ad_level"], 0.0) for r in rows)
        return score / len(rows)
    except Exception:
        return 0.0


def _site_prior(site_key: str) -> float | None:
    """站点历史质量先验（0~1，探测前排序用）：成功率 + 清晰度 + 速度 - 广告率。
    取最近 100 次而非近期均值，弱化设备过载夜的大批假失败对成功率的影响；无历史返回 None（中性）。"""
    try:
        conn = get_conn()
        rows = conn.execute("SELECT ok, ad_level, speed_mbps, height FROM site_stats "
                            "WHERE site_key=? ORDER BY id DESC LIMIT 100", (site_key,)).fetchall()
        conn.close()
        if not rows:
            return None
        ok_rows = [r for r in rows if r["ok"]]
        if not ok_rows:
            return 0.05
        ok_rate = len(ok_rows) / len(rows)
        avg_h = sum(r["height"] or 720 for r in ok_rows) / len(ok_rows)
        avg_s = sum(r["speed_mbps"] or 0.0 for r in ok_rows) / len(ok_rows)
        ad = sum({"dirty": 1.0, "suspect": 0.5}.get(r["ad_level"], 0.0) for r in ok_rows) / len(ok_rows)
        return max(0.0, min(1.0, 0.5 * ok_rate + 0.25 * min(avg_h / 1080.0, 1.0)
                            + 0.25 * min(avg_s / 25.0, 1.0) - 0.3 * ad))
    except Exception:
        return None


def _flag_rank(flag: str) -> int:
    """线路名排序：质量关键词在前、VIP 解析/花絮类在后，其余居中（稳定排序保持原序）。"""
    f = (flag or "").lower()
    if any(t in f for t in FLAG_GOOD_HINTS):
        return 0
    if any(t in f for t in FLAG_LATE_HINTS):
        return 2
    return 1


# 同为优质关键词（rank 0），名字承诺的规格也有高低：原盘/杜比 > 2160/4K > HDR > 蓝光 >
# 超清 > 1080。只作优先额度内线路排序的次级信号，站点历史先验为主（0.5 先验站的原盘
# 线不会越过 0.8 先验站的 1080 线）——线路名是营销话术，站点实测历史可信得多
FLAG_QUALITY_BONUS = (("原盘", 0.06), ("杜比", 0.06), ("2160", 0.05), ("4k", 0.05),
                      ("hdr", 0.03), ("蓝光", 0.02), ("超清", 0.01))


def _flag_quality_bonus(flag: str) -> float:
    f = (flag or "").lower()
    return next((b for tok, b in FLAG_QUALITY_BONUS if tok in f), 0.0)


def _duration_abnormal(metrics: dict | None) -> bool:
    """时长明显偏短或偏长的线路必须与正常线路分层，不能靠其他指标翻盘。"""
    return bool(metrics and (0 < (metrics.get("durationS") or 0) < 600
                             or metrics.get("durationMatch") in ("short", "long")))


def _recommendation_sort_key(r: dict) -> tuple:
    """最终推荐排序：时长、速度先把关，清晰度优先于广告，同清晰度再比较广告和评分。"""
    metrics = r.get("metrics") or {}
    total = (metrics.get("scores") or {}).get("total") or 0.0
    adjusted = total - 0.06 * _site_ad_rate(r.get("siteKey") or "")
    return (1 if _duration_abnormal(metrics) else 0,
            1 if (metrics.get("throughputMbps") or 0) < GOOD_MIN_MBPS else 0,
            -(metrics.get("height") or 0),
            AD_RANK.get(metrics.get("adLevel"), len(AD_RANK)),
            -adjusted)


def _line_good(r: dict) -> bool:
    """达标线路：可用、无确认广告、时长比对正常、吞吐达标。"""
    if r.get("status") != "ok" or not r.get("metrics"):
        return False
    m = r["metrics"]
    return (m.get("adLevel") != "dirty" and not _duration_abnormal(m)
            and (m.get("throughputMbps") or 0.0) >= GOOD_MIN_MBPS)


def _line_high(r: dict) -> bool:
    """高质量线路：达标且清晰度 ≥ HIGH_MIN_HEIGHT。"""
    return _line_good(r) and (r["metrics"].get("height") or 0) >= HIGH_MIN_HEIGHT


# ---------------- 单候选探测 ----------------

def _fail(cand: dict, error: str) -> dict:
    return {"siteKey": cand["siteKey"], "siteName": cand["siteName"], "vodId": cand["vodId"],
            "flag": cand["flag"], "status": "fail", "error": error[:80]}


async def probe_candidate(cand: dict, ref_s: float | None = None) -> dict:
    """服务端记录单条线路从解析播放地址到媒体探测完成的耗时，不含扫描排队及详情请求。"""
    started = time.monotonic()
    cancelled = False
    result = None
    try:
        result = await _probe_candidate(cand, ref_s)
        return result
    except asyncio.CancelledError:
        cancelled = True
        raise
    finally:
        if not cancelled:
            elapsed_ms = (time.monotonic() - started) * 1000
            try:
                record_site_probe_duration({"key": cand["siteKey"], "name": cand.get("siteName", "")},
                                           elapsed_ms, flag=cand.get("flag", ""),
                                           success=isinstance(result, dict) and result.get("status") == "ok")
            except Exception:
                pass  # 统计落库失败不影响探测结果


async def _probe_candidate(cand: dict, ref_s: float | None = None) -> dict:
    site_key, flag, episode_id = cand["siteKey"], cand["flag"], cand["episodeId"]
    t0 = time.monotonic()
    try:
        data = await _call_device_wait("player", {"key": site_key, "flag": flag, "id": episode_id},
                                       timeout=PLAYER_TIMEOUT)
    except Exception as e:
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, f"解析失败: {e}")
    open_ms = round((time.monotonic() - t0) * 1000)
    url = (data.get("url") or "").strip()
    headers = data.get("headers") or {}
    if not url:
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, "播放地址为空")
    if not url.startswith(("http://", "https://")):
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, f"不支持的地址 {url[:36]}")
    local = bool(data.get("local"))

    try:
        pl = await _fetch(url, headers, PLAYLIST_CAP, local=local)
    except Exception as e:
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, f"取流失败: {e}")
    if pl["status"] >= 400:
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, f"源站返回 HTTP {pl['status']}")

    body, ctype = pl["data"], (pl["ctype"] or "").lower()
    ttfb = round(pl["ttfb"], 3)
    redirects = pl["redirects"]
    try:
        if (body[:7] == b"#EXTM3U" or "mpegurl" in ctype or ".m3u8" in url.lower()
                or ".m3u8" in (pl.get("url") or url).lower()):
            return await _probe_hls(cand, url, headers, local, pl, open_ms, ref_s)
        if ctype.startswith(("video/", "audio/")) or any(ext in url.lower() for ext in FILE_EXTS):
            return await _probe_file(cand, url, headers, local, pl, open_ms, redirects, ref_s)
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, f"非媒体地址({pl['ctype'] or '未知类型'})")
    except Exception as e:
        _stats_insert(site_key, False, "", None, None)
        return _fail(cand, f"探测失败: {e}")


def _score(first_frame_s: float, mbps: float, height: int | None) -> dict:
    speed = 0.6 * min(mbps / 25.0, 1.0) + 0.4 * max(0.0, min(1.0, (6.0 - first_frame_s) / 5.5))
    quality = min((height or 720) / 1080.0, 1.0)
    return {"speed": round(speed, 3), "quality": round(quality, 3)}


def _apply_duration_ref(metrics: dict, ref_s: float | None) -> None:
    """正片时长与片库片长交叉比对：远短疑似预告/假资源重罚，明显偏长疑似拼接广告轻罚。
    片库无片长（ref_s 空）时退化为绝对下限：正片不可能只有 TRAILER_MAX_S 秒以内，
    仍能识别预告片/花絮线路（玩具总动员5 的 4K 宣传片漏判即此处此前直接 return）。"""
    dur = metrics.get("durationS") or 0
    if not dur:
        return
    total = metrics["scores"]["total"]
    if dur < TRAILER_MAX_S or (ref_s and dur < ref_s * 0.6):
        metrics["durationMatch"] = "short"
        metrics["scores"]["total"] = round(max(0.0, total * 0.4), 3)
    elif ref_s:
        delta = dur - ref_s
        metrics["durationDeltaS"] = round(delta)
        if delta > max(600, ref_s * 0.15):
            metrics["durationMatch"] = "long"
            metrics["scores"]["total"] = round(max(0.0, total - 0.12), 3)
        else:
            metrics["durationMatch"] = "ok"


def _finish(cand: dict, metrics: dict, ref_s: float | None = None) -> dict:
    """统一算分并落统计。"""
    metrics["scores"] = _score(metrics["firstFrameS"], metrics["throughputMbps"], metrics.get("height"))
    total = 0.5 * metrics["scores"]["speed"] + 0.5 * metrics["scores"]["quality"]
    total -= {"clean": 0.0, "suspect": 0.1, "dirty": 0.4}[metrics["adLevel"]]
    metrics["scores"]["total"] = round(max(0.0, total), 3)
    _apply_duration_ref(metrics, ref_s)
    _stats_insert(cand["siteKey"], True, metrics["adLevel"], metrics["throughputMbps"], metrics.get("height"))
    return {**cand, "status": "ok", "metrics": metrics}


async def _probe_hls(cand: dict, url: str, headers: dict, local: bool, pl: dict,
                     open_ms: int, ref_s: float | None = None) -> dict:
    text = pl["data"].decode("utf-8", "replace")
    # 分片拼接基准必须用 302 后的最终地址：入口常是带 auth_key 的跳转壳（如 1ljx /cloud/flv→/ufile），
    # 相对分片拼回入口路径会被 CDN 鉴权拒绝（实测咖啡4K超清/玫瑰4K 分片 402）
    url = pl.get("url") or url
    variants, segments = _parse_playlist(text)
    master_wh = None
    ttfb = round(pl["ttfb"], 3)
    redirects = pl["redirects"]
    if variants:
        best = max(variants, key=lambda v: v["bandwidth"])
        if best.get("resolution") and "x" in best["resolution"]:
            try:
                w, h = best["resolution"].lower().split("x")
                master_wh = (int(w), int(h))
            except ValueError:
                master_wh = None
        var_url = urljoin(pl.get("url") or url, best["url"])
        pl2 = await _fetch(var_url, headers, PLAYLIST_CAP, local=_is_local(var_url) or local)
        if pl2["status"] >= 400:
            return _fail(cand, f"子播放列表 HTTP {pl2['status']}")
        text = pl2["data"].decode("utf-8", "replace")
        _, segments = _parse_playlist(text)
        url, ttfb = (pl2.get("url") or var_url), round(pl2["ttfb"], 3)
        redirects = redirects + pl2["redirects"]
    if not segments:
        return _fail(cand, "播放列表无分片")

    ad_level, signals = _detect_ads(segments, redirects)
    seg = segments[0]
    duration_s = round(sum(s["duration"] for s in segments), 1)  # 正片总时长（分片 EXTINF 求和），供前端判时长异常
    seg_url = urljoin(url, seg["url"])
    sg = await _fetch(seg_url, headers, SEGMENT_CAP, local=_is_local(seg_url) or local)
    if sg["status"] >= 400:
        return _fail(cand, f"分片 HTTP {sg['status']}")
    seg_time = round(sg["elapsed"], 3)
    mbps = round(len(sg["data"]) * 8 / sg["elapsed"] / 1e6, 2) if sg["elapsed"] > 0.05 else 0.0
    info = await _ffprobe(sg["data"]) or {}
    width = master_wh[0] if master_wh else info.get("width")
    height = master_wh[1] if master_wh else info.get("height")
    bitrate = round(len(sg["data"]) * 8 / seg["duration"] / 1000) if seg["duration"] > 0 else None

    # 角标静止检测：首分片帧 vs 约 15% 处分片帧（多下载一个分片；台标同样命中，仅 suspect 级）
    if FFMPEG and len(segments) > 8:
        mid = min(len(segments) - 1, max(6, int(len(segments) * 0.15)))
        if segments[mid]["url"]:
            try:
                mseg_url = urljoin(url, segments[mid]["url"])
                ms = await _fetch(mseg_url, headers, SEGMENT_CAP, local=_is_local(mseg_url) or local)
                if ms["status"] < 400:
                    fa, fb = await asyncio.gather(_frame(sg["data"]), _frame(ms["data"]))
                    wm = _watermark_signal(fa, fb)
                    if wm:
                        signals.append(wm)
                        ad_level = _ad_level(signals)
            except Exception:
                pass

    return _finish(cand, {
        "openMs": open_ms, "ttfbS": ttfb, "firstFrameS": round(open_ms / 1000 + ttfb + seg_time, 2),
        "throughputMbps": mbps, "width": width, "height": height,
        "codec": info.get("codec"), "acodec": info.get("acodec"), "bitrateKbps": bitrate,
        "durationS": duration_s, "adLevel": ad_level, "adSignals": signals, "kind": "hls",
    }, ref_s)


def _mp4_moov_end(data: bytes) -> int | None:
    """遍历顶层 box，返回 moov 盒结束偏移（faststart 文件 moov 在头部）。
    用于宽高补读：moov 在 mdat 之后（文件尾）或结构异常时返回 None。size=0/1 的非常规盒直接放弃。"""
    off = 0
    while off + 8 <= len(data):
        size = int.from_bytes(data[off:off + 4], "big")
        typ = data[off + 4:off + 8]
        if size == 0:
            break
        if size < 8:
            return None
        if typ == b"moov":
            return off + size
        if typ == b"mdat":
            return None
        off += size
    return None


def _mp4_moov_at_end(data: bytes) -> bool:
    """头部若干 MB 里先见 mdat 后未见 moov → moov 在文件尾（非 faststart）。
    这类大 MP4 浏览器必须先拿到尾部索引才能起播：桌面 Chromium 会发 suffix Range 直跳文件尾
    （秒起），不少手机内置浏览器只会顺序下载（GB 级文件 15s 内到不了 moov，表现为一直加载）。
    注意 64bit size 盒（size==1）：mdat 常用，需按 8 字节头跳过。"""
    off = 0
    while off + 8 <= len(data):
        size = int.from_bytes(data[off:off + 4], "big")
        typ = data[off + 4:off + 8]
        if size == 1:
            if off + 16 > len(data):
                return False
            size = int.from_bytes(data[off + 8:off + 16], "big")
            if size < 16:
                return False
        elif size == 0:
            return False  # size=0 表示直到文件尾，探测只下头部不该出现，放弃判定
        if size < 8:
            return False
        if typ == b"moov":
            return False
        if typ == b"mdat":
            return True
        off += size
    return False


async def _fetch_tail(url: str, headers: dict, cap: int) -> tuple[int, bytes] | None:
    """Range 后缀回读文件尾部（仅直连路径）。返回 (文件总长, 尾部字节)；
    源站不支持 Range（回 200 全量）或异常时返回 None。"""
    client = _http_client()
    try:
        resp = await client.send(client.build_request(
            "GET", url, headers={**dict(headers), "Range": f"bytes=-{cap}"}), stream=True)
    except Exception:
        return None
    try:
        if resp.status_code != 206:
            return None
        cr = resp.headers.get("content-range", "")
        total = int(cr.rsplit("/", 1)[-1]) if "/" in cr else 0
        parts, got = [], 0
        async for chunk in resp.aiter_bytes(65536):
            parts.append(chunk)
            got += len(chunk)
        return total, b"".join(parts)
    except Exception:
        return None
    finally:
        await resp.aclose()


def _tail_moov_synth(head: bytes, tail: bytes, total: int) -> bytes | None:
    """从尾部字节中解析末尾的 moov 顶层盒，与头部 ftyp 拼成最小可解析 MP4。
    校验盒大小与文件总长对齐（moov 为最后一盒，或其后仅挂 ≤64B 的 free 小盒），
    防止媒体数据里 'moov' 字样的误匹配。"""
    ftyp_size = int.from_bytes(head[:4], "big")
    if not 8 <= ftyp_size <= 64:
        return None
    pos = len(tail)
    while True:
        idx = tail.rfind(b"moov", 4, pos)
        if idx < 4:
            return None
        size = int.from_bytes(tail[idx - 4:idx], "big")
        start_in_file = total - len(tail) + idx - 4
        end = start_in_file + size
        if 8 <= size <= len(tail) and (end == total or 0 < total - end <= 64):
            return head[:ftyp_size] + tail[idx - 4:idx - 4 + size]
        pos = idx


async def _probe_file(cand: dict, url: str, headers: dict, local: bool, pl: dict, open_ms: int,
                      redirects: list[str], ref_s: float | None = None) -> dict:
    mbps = round(len(pl["data"]) * 8 / pl["elapsed"] / 1e6, 2) if pl["elapsed"] > 0.05 else 0.0
    info = await _ffprobe(pl["data"]) or {}
    if not info.get("height"):
        # 截断的 moov 让 ffprobe 报 Invalid data（宽高未知）。两种补救：
        # ① faststart：moov 在头部但超过 2MB 下载上限——按盒头读出结束位补下载；
        # ② moov 在文件尾（mdat 在前）：Range 后缀回读尾部，拼 ftyp+moov 合成最小 MP4 再读
        moov_end = _mp4_moov_end(pl["data"])
        if moov_end and len(pl["data"]) < moov_end <= FILE_FFPROBE_CAP:
            try:
                pl2 = await _fetch(url, headers, moov_end, local=local)
                if pl2["status"] < 400:
                    info = await _ffprobe(pl2["data"]) or info
            except Exception:
                pass
        elif not local and pl["data"][4:8] == b"ftyp":
            try:
                tail = await _fetch_tail(url, headers, TAIL_FFPROBE_CAP)
                if tail:
                    synth = _tail_moov_synth(pl["data"], tail[1], tail[0])
                    if synth:
                        info = await _ffprobe(synth) or info
            except Exception:
                pass
    return _finish(cand, {
        "openMs": open_ms, "ttfbS": round(pl["ttfb"], 3),
        "firstFrameS": round(open_ms / 1000 + pl["elapsed"], 2),
        "throughputMbps": mbps, "width": info.get("width"), "height": info.get("height"),
        "codec": info.get("codec"), "acodec": info.get("acodec"), "bitrateKbps": None,
        "durationS": info.get("duration"),  # MP4 直链此前不产出时长，预告片漏过交叉比对
        "moovEnd": _mp4_moov_at_end(pl["data"]),
        "adLevel": "clean", "adSignals": [], "kind": "file",
    }, ref_s)


# ---------------- 扫描编排 ----------------

async def _run_scan(task: ScanTask, matches: list[dict], ref_s: float | None = None,
                    fresh: bool = False, prior: list[dict] | None = None):
    results: list[dict] = []
    try:
        # 跨扫描先验（详情阶段前就要用）：优先额度与全局达标状态。
        # 详情获取失败的空 flag 条目不参与——它们没实测过线路。
        # 优先额度按上一轮 prio 标记（优先批次实测线路）统计：补齐逻辑会把普通线路提级进
        # 优先批次，它们同样消耗额度但线路名不是关键词——按 rank==0 数会漏掉（曾致
        # 玩具总动员5 首轮 50 条 + 补充扫描又拉满 29 条 = 79 条超额）；旧结果无 prio
        # 字段时回退按关键词线路名估算（过渡兼容，刷新重扫后即消失）
        prior = [p for p in (prior or []) if p.get("flag")]

        def _was_priority(p: dict) -> bool:
            return p["prio"] if "prio" in p else _flag_rank(p.get("flag") or "") == 0

        already_priority = sum(1 for p in prior if _was_priority(p))
        priority_cap = max(0, PRIORITY_LINES_CAP - already_priority)
        criteria_met = (sum(1 for p in prior if _line_good(p)) >= GOOD_LINES_TARGET
                        and any(_line_high(p) for p in prior))
        # 自动补充扫描无事可做：优先额度耗尽且全局已达标——跳过详情与探测直接按先验收工，
        # 白跑一轮详情请求只会压设备爬虫（手动补测/重探不带 prior，不会走到这里）
        if not fresh and criteria_met and priority_cap == 0:
            ok = [p for p in prior if p.get("status") == "ok" and p.get("flag")]

            def pkey(r: dict) -> str:
                return f"{r['siteKey']}::{r['flag']}"

            _emit(task, {"type": "meta", "total": 0})
            _emit(task, {"type": "done", "total": len(prior), "stoppedEarly": True,
                         "recommended": pkey(min(ok, key=_recommendation_sort_key)) if ok else None})
            return
        # 站点按历史质量先验排序（无历史给中性 0.5，匹配分名次只作微小修正防同分乱序）。
        # 前端会把当前/历史来源放在 matches 首位；同先验时保留该顺序，让它优先进入详情首批。
        site_priors = {m["key"]: _site_prior(m["key"]) for m in matches}
        try:
            line_averages = get_line_probe_averages([m["key"] for m in matches])
        except Exception:
            line_averages = {}  # 统计不可用时沿用原排序，不能阻断扫描。

        def probe_duration(cand: dict) -> float:
            # 同站同线路跨影片共享历史；无样本置后，0ms 是有效样本。
            return line_averages.get((cand["siteKey"], cand["flag"]), float("inf"))

        def site_order(idx_m: tuple[int, dict]) -> float:
            idx, m = idx_m
            if idx == 0:
                return -2.0  # 前端置顶的当前/历史来源（冷搜时为搜索首选）固定进入详情首批
            return -((0.5 if site_priors[m["key"]] is None else site_priors[m["key"]]) - 0.002 * idx)

        ordered_matches = [m for _, m in sorted(enumerate(matches), key=site_order)]

        def detail_candidates(m: dict, data: dict) -> tuple[list[dict], list[dict]]:
            """把一个站点详情拆成关键词优先线路和普通线路候选。"""
            priority_lines, normal_lines = [], []
            flags = sorted(data.get("flags") or [], key=lambda f: _flag_rank(f.get("flag") or ""))
            for f in flags:
                eps = f.get("episodes") or []
                if not eps or not eps[0].get("url"):
                    continue
                cand = {"siteKey": m["key"], "siteName": m.get("name") or m["key"],
                        "vodId": m["id"], "flag": f.get("flag", ""),
                        "episodeId": eps[0]["url"]}
                if _flag_rank(f.get("flag") or "") == 0:
                    priority_lines.append(cand)
                else:
                    normal_lines.append(cand)
            # 先按耗时排序再截本站额度，防止原顺序靠后的快速线路被提前丢弃。
            priority_lines.sort(key=probe_duration)
            normal_lines.sort(key=probe_duration)
            return priority_lines, normal_lines[:FLAGS_PER_SITE]

        sem = asyncio.Semaphore(DETAIL_CONCURRENCY)

        async def one_detail(m: dict):
            async with sem:
                try:
                    return m, await _call_device_wait("detail", {"key": m["key"], "id": m["id"]},
                                                      timeout=DETAIL_TIMEOUT)
                except Exception:
                    return m, None

        # 缓存命中会一次给到最多 60 个站点。旧实现 gather 全部详情后才发首条 result，
        # 3 并发 × 慢站点会让选源弹窗长时间空白。先处理排序最前的一批，并在首个可用
        # 详情完成时立即探测一条线路；其余详情随后仍按原全局排序/额度规则处理。
        pairs: list[tuple[dict, dict | None]] = []
        early_probe_keys: set[str] = set()
        early_priority_count = 0
        early_probe_done = False

        async def collect_details(items: list[dict], allow_early_probe: bool):
            nonlocal early_probe_done, early_priority_count
            tasks = [asyncio.create_task(one_detail(m)) for m in items]
            try:
                for future in asyncio.as_completed(tasks):
                    m, data = await future
                    pairs.append((m, data))
                    if data is None:
                        failure = {"siteKey": m["key"], "siteName": m.get("name") or m["key"],
                                   "vodId": m["id"], "flag": "", "status": "fail",
                                   "error": "详情获取失败"}
                        results.append(failure)
                        _emit(task, {"type": "result", "result": failure})
                        continue
                    if not allow_early_probe or early_probe_done:
                        continue
                    site_priority, site_normal = detail_candidates(m, data)
                    cand = (site_priority + site_normal)[0] if site_priority or site_normal else None
                    if cand is None:
                        continue
                    early_probe_done = True
                    result = await probe_candidate(cand, ref_s)
                    is_priority = _flag_rank(cand.get("flag") or "") == 0
                    result["prio"] = is_priority
                    results.append(result)
                    early_probe_keys.add(f"{cand['siteKey']}::{cand['flag']}")
                    if is_priority:
                        early_priority_count += 1
                    _emit(task, {"type": "result", "result": result})
            finally:
                for pending in tasks:
                    if not pending.done():
                        pending.cancel()

        await collect_details(ordered_matches[:DETAIL_CONCURRENCY], True)
        await collect_details(ordered_matches[DETAIL_CONCURRENCY:], False)

        # 线路按名字启发式分流：4K/蓝光/超清等进优先批次（全局 ≤PRIORITY_LINES_CAP 条全量实测，
        # 不足 PRIORITY_FILL_MIN 条时从普通批次按排序补齐，超额时先按历史探测耗时，
        # 再按"站点先验 + 关键词规格"
        # 全局择优），其余进普通批次（每站 ≤FLAGS_PER_SITE 条，达标即停）
        priority_cap = max(0, priority_cap - early_priority_count)
        prio_pool: list[dict] = []  # 全部关键词线路候选：全局排序后再截优先额度（超额择优）
        site_normals: dict[str, list[dict]] = {}  # 各站普通线路切片（站内已按线路名启发式排序）
        pair_by_key = {m["key"]: d for m, d in pairs}
        for m in ordered_matches:
            data = pair_by_key.get(m["key"])
            if data is None:
                continue
            site_priority, site_normal = detail_candidates(m, data)
            prio_pool.extend(c for c in site_priority
                             if f"{c['siteKey']}::{c['flag']}" not in early_probe_keys)
            site_normals[m["key"]] = [c for c in site_normal
                                      if f"{c['siteKey']}::{c['flag']}" not in early_probe_keys]
        # 关键词线路全局择优：超额（全网 4K/蓝光线 > 50 条）时不能"站点处理顺序先到先得"——
        # 按历史平均探测耗时升序取前 priority_cap 条，耗时相同/未知时沿用质量先验。
        prio_pool.sort(key=lambda c: (probe_duration(c),
                                     -((0.5 if site_priors[c["siteKey"]] is None else site_priors[c["siteKey"]])
                                       + _flag_quality_bonus(c["flag"]))))
        priority = prio_pool[:priority_cap]  # 优先线路：全部实测，不受达标即停限制
        # 额度外关键词线路回落普通批次，与本站普通线按耗时合并后再截取每站额度。
        overflow: dict[str, list[dict]] = {}
        for cand in prio_pool[priority_cap:]:
            overflow.setdefault(cand["siteKey"], []).append(cand)
        normal: list[dict] = []
        for m in ordered_matches:
            candidates = overflow.get(m["key"], []) + site_normals.get(m["key"], [])
            normal.extend(sorted(candidates, key=probe_duration)[:FLAGS_PER_SITE])
        normal.sort(key=probe_duration)
        # 优先批次不足 30 条（冷门片 4K/蓝光关键词线路少）：从普通批次头部（即排序规则下
        # 探测耗时最短的普通线路）提级补齐到本轮优先额度 ≤50 条，
        # 提级线路同样全量实测不受达标即停限制——否则优先线只有十几条、普通线又早早
        # 达标即停，本轮探测覆盖面太小
        if len(priority) < PRIORITY_FILL_MIN:
            take = min(priority_cap - len(priority), len(normal))
            priority.extend(normal[:take])
            del normal[:take]
        # 补齐进来的普通线路也按耗时与原优先线路一起排序。
        priority.sort(key=probe_duration)
        _emit(task, {"type": "meta", "total": len(priority) + len(normal) + len(results)})
        # 详情失败和首条快速探测结果已实时发出，不能在 meta 后重复推送。
        # 此前各轮结果并入全局评估基数（不重发事件，前端已持有）：早停条件与最终
        # 推荐键均按"历史 + 本轮"合并口径判定
        results.extend(prior)

        sem_probe = asyncio.Semaphore(PROBE_CONCURRENCY)
        aborted = False
        early_stop = False

        async def one_probe(cand: dict, prio: bool = False):
            nonlocal aborted, early_stop
            async with sem_probe:
                if aborted or (early_stop and not prio):
                    return
                res = await probe_candidate(cand, ref_s)
            res["prio"] = prio  # 优先批次标记：跨扫描优先额度封顶按此统计（提级线也占额度）
            results.append(res)
            _emit(task, {"type": "result", "result": res})
            # 设备掉线：等一轮桥接重连退避，仍不在线则中止扫描，避免刷几十条重复失败
            if not aborted and res["status"] == "fail" and "设备未连接" in (res.get("error") or ""):
                await asyncio.sleep(15)
                dev = active_device()
                if dev is None or not dev.online:
                    aborted = True
                    _emit(task, {"type": "done", "error": "设备连接中断，部分线路未完成探测"})
                    return
            # 达标即停：够好线路数达标且至少一条高清，剩余候选不再探测（在飞的探完自然并入）；
            # 达标状态照常累计——优先线路不因达标跳过（全量实测），但优先批次结束后若已达标，
            # 普通线路批次会整体跳过。手动重探（fresh）不做早停——用户明确要求全量重测
            if not fresh and not early_stop and sum(1 for r in results if _line_good(r)) >= GOOD_LINES_TARGET \
                    and any(_line_high(r) for r in results):
                early_stop = True

        # 优先批次：4K/蓝光/超清等线路全部探完（≤本轮优先额度）
        await asyncio.gather(*[one_probe(c, prio=True) for c in priority])
        if aborted:
            return
        # 优先批次结束：按全局口径（含此前各轮结果）显式评估一次达标即停——
        # 满足则普通批次整体跳过，不再发一条探测
        if not fresh and not early_stop and sum(1 for r in results if _line_good(r)) >= GOOD_LINES_TARGET \
                and any(_line_high(r) for r in results):
            early_stop = True
        # 普通批次：其余线路按原排序与达标即停流程探测
        await asyncio.gather(*[one_probe(c) for c in normal])
        if aborted:
            return

        ok = [r for r in results if r["status"] == "ok" and r.get("flag")]

        def key(r: dict) -> str:
            return f"{r['siteKey']}::{r['flag']}"

        _emit(task, {"type": "done", "total": len(results), "stoppedEarly": early_stop,
                     "recommended": key(min(ok, key=_recommendation_sort_key)) if ok else None,
                     "fastest": key(max(ok, key=lambda r: r["metrics"]["throughputMbps"])) if ok else None,
                     "highest": key(max(ok, key=lambda r: (r["metrics"].get("height") or 0,
                                                           r["metrics"].get("bitrateKbps") or 0))) if ok else None})
    except Exception as e:
        _emit(task, {"type": "done", "error": str(e)[:120]})
    finally:
        task.done = True
