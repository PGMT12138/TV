"""互联网版桥接（服务端）。

设备（App 内 Bridge.java）主动连到 /ws 建立长连接；CINE（/cine）与移动网页端
调用的 /api/* 由本模块经 WebSocket 转发给设备执行，视频流经 /stream 代理：
- 直连源站（via=0）：服务端用 httpx 回源并带上设备给出的请求头；
- 经设备转发（via=1）：地址是设备本地代理（如爬虫的 /proxy）时，fetch 命令发到设备，
  设备回传 meta / 二进制分块（4 字节请求 id + 数据）/ end 帧，本端转成 HTTP 流式响应。

多设备：连接首帧 hello 携带设备唯一 id，在线设备进运行时注册表 _devices，
历史身份落 devices 表；搜索/解析/取流统一走管理端选定的 active 设备
（settings.active_device_id，未设置时首台连上的设备自动当选）。
"""
import asyncio
import base64
import itertools
import json
import os
import shutil
import subprocess
from collections import OrderedDict
from http import HTTPStatus
from urllib.parse import quote, urljoin, urlparse

import httpx
from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

import database

router = APIRouter()

BRIDGE_TOKEN = os.environ.get("BRIDGE_TOKEN", "")  # 为空则不校验（本机测试）
TIMEOUT_CMD = 90.0  # playerContent 可能很慢（网盘转存等）
TIMEOUT_EVENT_IDLE = 40.0  # 批量搜索每站 30s 超时；连续 40s 无任何事件视为设备异常
CHUNK = 65536
HELLO_TIMEOUT = 10.0  # 等待连接首帧 hello 的超时

# ---------------- EAC3/AC3 音频转码（服务端兜底，让无 Dolby 解码的浏览器也能播） ----------------
# 浏览器 MSE 对 EAC3 支持参差（专利原因 Chromium 不内置、委托系统解码，IAB/Electron 常缺失）。
# ts 分片代理时轻量探测音频流：发现 eac3/ac3 就挂 ffmpeg 流式管道只转音频（-c:v copy 视频
# 零转码，实测 60s 分片 ~0.9s 转完，CPU 占用可忽略）；判定结果按分片 URL 记忆避免每个分片重复探测。
FFMPEG = shutil.which("ffmpeg")
AUDIO_TRANSCODE_PROBE = 256 * 1024      # 探测头部字节数：TS 包 188B 对齐 + PAT/PMT/首 PES，足够 ffprobe 识别流
_TRANSCODE_CACHE_MAX = 4096
_transcode_cache: "OrderedDict[str, bool]" = OrderedDict()  # 分片 URL → 是否需要转音频（LRU）


def _need_audio_transcode(url: str) -> bool:
    cached = _transcode_cache.get(url)
    if cached is not None:
        _transcode_cache.move_to_end(url)
        return cached
    return False  # 未探测过的分片默认不转，由 _sniff_audio_transcode 探测后回填


def _mark_audio_transcode(url: str, needed: bool):
    _transcode_cache[url] = needed
    _transcode_cache.move_to_end(url)
    while len(_transcode_cache) > _TRANSCODE_CACHE_MAX:
        _transcode_cache.popitem(last=False)


def _sniff_audio_transcode(data: bytes) -> bool:
    """ffprobe 读头部字节判断是否含 EAC3/AC3 音频流（数据不足/探测失败一律按不转处理）。"""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe or len(data) < 4096:
        return False
    path = os.path.join(os.environ.get("TEMP", "/tmp"), f"sniff_{next(_ids)}.bin")
    try:
        with open(path, "wb") as f:
            f.write(data)
        out = subprocess.run(
            [ffprobe, "-v", "quiet", "-print_format", "json",
             "-show_entries", "stream=codec_name,codec_type", path],
            capture_output=True, timeout=10).stdout
        for st in (json.loads(out or b"{}").get("streams") or []):
            if st.get("codec_type") == "audio" and str(st.get("codec_name") or "").lower() in ("eac3", "ac3"):
                return True
    except Exception:
        return False
    finally:
        try:
            os.remove(path)
        except OSError:
            pass
    return False


def _ffmpeg_audio_pipe() -> subprocess.Popen | None:
    """起 ffmpeg：TS 从 stdin 读，视频 copy 音频转 AAC 写 stdout（流式，边下边转边出）。
    -copyts 必须加：mpegts muxer 默认把输出时间戳平移到 ~0 起，而分片是各自独立转码的，
    平移后跨分片 PTS 全部跳回起点，hls.js 的连续化处理失效（缓冲倒退卡住）；保留源时间轴
    （源分片间本就连续）则与不转码时行为一致。muxdelay/muxpreload 归零避免 muxer 加偏移。
    失败返回 None（调用方回退透传）。"""
    if not FFMPEG:
        return None
    try:
        return subprocess.Popen(
            [FFMPEG, "-v", "error", "-i", "pipe:0",
             "-c:v", "copy", "-c:a", "aac", "-b:a", "256k",
             "-copyts", "-muxdelay", "0", "-muxpreload", "0",
             "-f", "mpegts", "pipe:1"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            bufsize=0)
    except Exception:
        return None

_ids = itertools.count(1)


class Device:
    def __init__(self, device_id: str):
        self.id = device_id
        self.ws = None
        self.name = "device"
        self.version = ""
        self.pending: dict[int, asyncio.Future] = {}
        self.streams: dict[int, asyncio.Queue] = {}
        self.events: dict[int, asyncio.Queue] = {}

    @property
    def online(self):
        return self.ws is not None

    async def close(self):
        for fut in self.pending.values():
            if not fut.done():
                fut.set_exception(RuntimeError("device offline"))
        for q in self.streams.values():
            await q.put(None)
        for q in self.events.values():
            await q.put(None)
        self.pending.clear()
        self.streams.clear()
        self.events.clear()
        self.ws = None


# 在线设备注册表（id -> Device）；历史设备见 devices 表
_devices: dict[str, Device] = {}


def active_device() -> Device | None:
    """管理端选定的搜索解析来源设备；未选择或离线时为 None。"""
    device_id = database.get_setting("active_device_id")
    if not device_id:
        return None
    return _devices.get(device_id)


def _clear_sites_cache():
    """切换来源设备后让 CINE 的站点列表缓存失效（懒加载避免循环导入）。"""
    try:
        import cine
        cine.clear_sites_cache()
    except Exception:
        pass


@router.websocket("/ws")
async def device_ws(ws: WebSocket):
    token = ws.query_params.get("token", "")
    if BRIDGE_TOKEN and token != BRIDGE_TOKEN:
        await ws.close(code=4001, reason="bad token")
        return
    await ws.accept()
    try:
        first = await asyncio.wait_for(ws.receive_text(), timeout=HELLO_TIMEOUT)
        hello = json.loads(first)
    except (asyncio.TimeoutError, WebSocketDisconnect, ValueError):
        try:
            await ws.close(code=4002, reason="hello expected")
        except Exception:
            pass
        return
    if not isinstance(hello, dict) or hello.get("type") != "hello":
        try:
            await ws.close(code=4002, reason="hello expected")
        except Exception:
            pass
        return
    device_id = str(hello.get("id") or f"legacy:{hello.get('device') or 'device'}")
    name = hello.get("device") or "device"
    version = hello.get("version") or ""
    dev = _devices.get(device_id)
    if dev is None:
        dev = Device(device_id)
        _devices[device_id] = dev
    replaced = dev.ws
    dev.ws = ws
    dev.name = name
    dev.version = version
    if replaced is not None and replaced is not ws:  # 同设备重连，踢掉旧连接
        try:
            await replaced.close(code=4000, reason="replaced")
        except Exception:
            pass
    database.upsert_device(device_id, name, version)
    if not database.get_setting("active_device_id"):  # 首台连上的设备自动成为来源
        database.set_setting("active_device_id", device_id)
    print(f"[bridge] device connected: {name} ({device_id[:8]}) v{version}", flush=True)
    try:
        while True:
            msg = await ws.receive()
            if msg["type"] == "websocket.disconnect":
                break
            if "text" in msg and msg["text"] is not None:
                _on_device_text(dev, json.loads(msg["text"]))
            elif "bytes" in msg and msg["bytes"] is not None:
                _on_device_bytes(dev, msg["bytes"])
    except WebSocketDisconnect:
        pass
    finally:
        if dev.ws is ws:  # 仍是本连接持有设备时才注销（旧连接被替换时不清理）
            await dev.close()
            _devices.pop(device_id, None)
            database.touch_device(device_id)
            print(f"[bridge] device disconnected: {name} ({device_id[:8]})", flush=True)


def _on_device_text(dev: Device, msg: dict):
    rid = msg.get("id")
    if rid is None:
        return
    event_q = dev.events.get(rid)
    if event_q is not None:
        event_q.put_nowait(msg)
        return
    if msg.get("type") in ("meta", "end", "error"):  # fetch 流控制帧
        q = dev.streams.get(rid)
        if q is not None:
            q.put_nowait(msg)
        return
    fut = dev.pending.get(rid)
    if fut is not None and not fut.done():
        if msg.get("ok"):
            fut.set_result(msg.get("data"))
        else:
            fut.set_exception(RuntimeError(msg.get("error") or "device error"))


def _on_device_bytes(dev: Device, data: bytes):
    rid = int.from_bytes(data[:4], "big")
    q = dev.streams.get(rid)
    if q is not None:
        q.put_nowait(data[4:])


async def call_device(action: str, params: dict, timeout: float = TIMEOUT_CMD) -> dict:
    dev = active_device()
    if dev is None or not dev.online:
        raise RuntimeError("设备未连接")
    rid = next(_ids)
    fut = asyncio.get_event_loop().create_future()
    dev.pending[rid] = fut
    try:
        await dev.ws.send_json({"id": rid, "action": action, "params": params})
        return await asyncio.wait_for(fut, timeout)
    finally:
        dev.pending.pop(rid, None)


async def stream_device_events(action: str, params: dict, idle_timeout: float = TIMEOUT_EVENT_IDLE):
    """向设备发送一次命令并消费同一请求 id 的多条 JSON 事件，直到 done。

    消费方提前断开时向 App 发送 cancelSearch，批量搜索不会继续占用设备线程池。
    """
    dev = active_device()
    if dev is None or not dev.online:
        raise RuntimeError("设备未连接")
    rid = next(_ids)
    q: asyncio.Queue = asyncio.Queue()
    dev.events[rid] = q
    finished = False
    try:
        await dev.ws.send_json({"id": rid, "action": action, "params": params})
        while True:
            try:
                msg = await asyncio.wait_for(q.get(), idle_timeout)
            except asyncio.TimeoutError as e:
                raise RuntimeError("设备批量搜索响应超时") from e
            if msg is None:
                raise RuntimeError("设备已离线")
            if msg.get("ok") is False:
                raise RuntimeError(msg.get("error") or "device error")
            if msg.get("type") == "error":
                raise RuntimeError(msg.get("error") or "device error")
            yield msg
            if msg.get("type") == "done":
                finished = True
                return
    finally:
        dev.events.pop(rid, None)
        if not finished and dev.online and dev.ws is not None:
            try:
                await dev.ws.send_json({
                    "id": next(_ids),
                    "action": "cancelSearch",
                    "params": {"searchId": rid},
                })
            except Exception:
                pass


@router.get("/api/device")
async def device_status():
    active_id = database.get_setting("active_device_id")
    dev = _devices.get(active_id) if active_id else None
    if dev is not None and dev.online:
        return {"online": True, "name": dev.name, "version": dev.version, "id": dev.id}
    if active_id:
        for d in database.list_devices():  # 离线时仍回显身份
            if d["id"] == active_id:
                return {"online": False, "name": d["name"], "version": d["version"], "id": active_id}
    return {"online": False, "name": "", "version": "", "id": active_id or ""}


@router.get("/api/detail")
async def api_detail(key: str, id: str):
    try:
        return await call_device("detail", {"key": key, "id": id})
    except RuntimeError as e:
        return {"error": str(e)}


@router.get("/api/player")
async def api_player(request: Request, key: str, flag: str = "", id: str = ""):
    try:
        data = await call_device("player", {"key": key, "flag": flag, "id": id})
    except RuntimeError as e:
        return {"error": str(e)}
    url = (data.get("url") or "").strip()
    if not url.startswith(("http://", "https://")):
        # 部分采集站选集 playUrl 带时效 token，过期后设备会把原始 id 原样透传当 url；
        # 喂给 /stream 必失败，按解析失败处理（前端会自动重拉详情换新 token 重试）
        return {"error": "线路解析失败，选集令牌可能已过期"}
    prefix = request.scope.get("root_path", "")
    headers = data.get("headers") or {}
    h64 = base64.b64encode(json.dumps(headers).encode()).decode()
    via = 1 if data.get("local") else 0
    data["play"] = f"{prefix}/stream?url={quote(data.get('url', ''), safe='')}&h={quote(h64, safe='')}&via={via}"
    data["direct"] = False
    return data


# ---------------- 流代理 ----------------

def _decode_h(h: str) -> dict:
    if not h:
        return {}
    try:
        return json.loads(base64.b64decode(h))
    except Exception:
        return {}


def _rewrite_m3u8(request: Request, base_url: str, h: str, via: int, body: bytes) -> bytes:
    """把 m3u8 里的分片/密钥地址改写成服务端 /stream 代理地址（沿用入口请求头与 via）。"""
    prefix = request.scope.get("root_path", "")
    text = body.decode("utf-8", "replace")
    out = []
    for line in text.split("\n"):
        line = line.rstrip("\r")
        stripped = line.strip()
        if stripped.startswith("#"):
            if "URI=\"" in stripped:
                # 仅改写 EXT-X-KEY / EXT-X-MAP 等带 URI= 的行
                parts = stripped.split("URI=\"", 1)
                tail = parts[1].split("\"", 1)
                abs_url = tail[0] if tail[0].startswith("http") else urljoin(base_url, tail[0])
                seg_via = 1 if _is_device_local(abs_url) else via
                line = parts[0] + "URI=\"" + _stream_url(prefix, abs_url, h, seg_via) + "\"" + (tail[1] if len(tail) > 1 else "")
            out.append(line)
        elif stripped:
            abs_url = stripped if stripped.startswith("http") else urljoin(base_url, stripped)
            seg_via = 1 if _is_device_local(abs_url) else via
            out.append(_stream_url(prefix, abs_url, h, seg_via))
        else:
            out.append(line)
    return "\n".join(out).encode()


def _is_device_local(url: str) -> bool:
    try:
        host = urlparse(url).hostname or ""
        return host in ("127.0.0.1", "localhost")
    except Exception:
        return False


def _stream_url(prefix: str, url: str, h: str, via: int) -> str:
    q = f"{prefix}/stream?url={quote(url, safe='')}"
    if h:
        q += f"&h={quote(h, safe='')}"
    return q + (f"&via={via}" if via else "")


def _safe_status(code: int) -> int:
    """部分 CDN 会回私有状态码（如实测遇到的 602），uvicorn h11 层没有对应 reason phrase
    会直接抛 KeyError 杀死整个服务进程——非标准码统一转 502，让前端走换线路逻辑。"""
    try:
        HTTPStatus(code)
        return code
    except ValueError:
        return 502


@router.get("/stream")
async def stream(request: Request, url: str, h: str = "", via: int = 0):
    headers = _decode_h(h)
    if "Range" in request.headers:
        headers["Range"] = request.headers["Range"]
    if via:
        return await _stream_via_device(request, url, headers, h)
    return await _stream_direct(request, url, headers, h)


async def _stream_direct(request: Request, url: str, headers: dict, h: str):
    client = httpx.AsyncClient(follow_redirects=True, timeout=httpx.Timeout(15.0, read=60.0))
    try:
        req = client.build_request("GET", url, headers=headers)
        resp = await client.send(req, stream=True)
    except Exception:
        await client.aclose()
        return JSONResponse({"error": "源站连接失败"}, status_code=502)
    content_type = resp.headers.get("content-type", "application/octet-stream")
    # 跟随重定向后以最终地址判断类型/做相对路径解析（直播源常见 php 入口 302 到 CDN m3u8）
    final_url = str(resp.url)
    is_m3u8 = ".m3u8" in final_url or "mpegurl" in content_type
    if is_m3u8:
        body = await resp.aread()
        await resp.aclose()
        await client.aclose()
        # 源站错误状态/空列表一律回 502，不包装成 200：列表轮询拿到 200 空 body 时 hls.js 会把
        # 直播判成"已结束"而静默停载（实测咪咕 CDN 偶发，画面冻住不报错），转 502 让它按标准
        # 错误自动重试自愈；顺带修掉 m3u8 路径原本吞掉源站 4xx/5xx 状态码的问题
        if resp.status_code >= 400:
            return JSONResponse({"error": f"源站返回 HTTP {resp.status_code}"}, status_code=502)
        if not body.strip():
            return JSONResponse({"error": "源站返回空播放列表"}, status_code=502)
        rewritten = _rewrite_m3u8(request, final_url, h, 0, body)
        return StreamingResponse(iter([rewritten]), status_code=200, media_type="application/vnd.apple.mpegurl",
                                 headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"})
    out_headers = {"Access-Control-Allow-Origin": "*"}
    for name in ("Content-Length", "Content-Range", "Accept-Ranges"):
        if name in resp.headers:
            out_headers[name] = resp.headers[name]

    # ---- EAC3/AC3 音频兜底转码（仅 ts 分片，m3u8 上面已返回）----
    # 已知要转：直接挂 ffmpeg 流式管道；未探测过：先读头部若干字节给 ffprobe 识别，
    # 结论记 LRU（同分片下次直接走对应分支），不需要转则把头部字节原样续传零开销。
    # 注意 CDN 常把 .ts 302 到无后缀地址（实测 meilinvps /dsp-file-xxx + binary/octet-stream），
    # 所以原始 url 和最终地址都要看
    content_type_lower = content_type.lower()
    looks_like_ts = ("mp2t" in content_type_lower
                     or ".ts" in urlparse(url).path or ".ts" in urlparse(final_url).path)
    transcode = False
    head_chunk = b""
    seg_iter = None
    if looks_like_ts and not ("Content-Range" in out_headers or "Range" in (request.headers or {})):
        if _need_audio_transcode(final_url):
            transcode = True
        else:
            # httpx 的 aiter_bytes 每响应只能消费一次（二次调用抛 StreamConsumed）——
            # 探测与后续转码泵必须共用同一个迭代器
            seg_iter = resp.aiter_bytes(chunk_size=CHUNK)
            try:
                while len(head_chunk) < AUDIO_TRANSCODE_PROBE:
                    try:
                        head_chunk += await asyncio.wait_for(seg_iter.__anext__(), timeout=15)
                    except StopAsyncIteration:
                        break
            except Exception:
                head_chunk = b""
            if head_chunk:
                transcode = _sniff_audio_transcode(head_chunk)
                _mark_audio_transcode(final_url, transcode)

    if transcode:
        proc = _ffmpeg_audio_pipe()
        if proc is not None:
            async def gen_transcode():
                loop = asyncio.get_running_loop()
                proc_stdin = proc.stdin
                proc_stdout = proc.stdout
                assert proc_stdin and proc_stdout

                # 源读取在 httpx 异步栈，ffmpeg 写入用线程池搬运（Popen 的 stdin/stdout 是阻塞 IO）；
                # seg_iter 非空说明探测阶段已消费过流，继续用它（httpx 流只能消费一次），
                # 为空（缓存命中直接转码）则从响应开头取新迭代器
                async def pump():
                    try:
                        nonlocal seg_iter
                        if head_chunk:
                            await loop.run_in_executor(None, proc_stdin.write, head_chunk)
                        if seg_iter is None:
                            seg_iter = resp.aiter_bytes(chunk_size=CHUNK)
                        async for chunk in seg_iter:
                            await loop.run_in_executor(None, proc_stdin.write, chunk)
                    except Exception:
                        pass
                    finally:
                        try:
                            await loop.run_in_executor(None, proc_stdin.close)
                        except Exception:
                            pass

                pump_task = asyncio.create_task(pump())
                try:
                    while True:
                        out = await loop.run_in_executor(None, proc_stdout.read, 65536)
                        if not out:
                            break
                        yield out
                finally:
                    pump_task.cancel()
                    for f in (proc_stdin, proc_stdout):
                        try:
                            f.close()
                        except Exception:
                            pass
                    proc.kill()
                    await resp.aclose()
                    await client.aclose()

            out_headers.pop("Content-Length", None)  # 转码后长度不可预知
            out_headers["Cache-Control"] = "no-store"
            return StreamingResponse(gen_transcode(), status_code=_safe_status(resp.status_code),
                                     media_type="video/mp2t", headers=out_headers)

    async def gen():
        try:
            # 探测阶段读掉的头部字节必须先补回去（transcode=False 时走到这里），否则分片损坏；
            # 流可能已被探测消费过一部分，继续用 seg_iter 而不是再建 aiter_bytes（只能消费一次）
            if head_chunk:
                yield head_chunk
            if seg_iter is not None:
                async for chunk in seg_iter:
                    yield chunk
            else:
                async for chunk in resp.aiter_bytes(chunk_size=CHUNK):
                    yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(gen(), status_code=_safe_status(resp.status_code), media_type=content_type, headers=out_headers)


async def _stream_via_device(request: Request, url: str, headers: dict, h: str):
    dev = active_device()
    if dev is None or not dev.online:
        return JSONResponse({"error": "设备未连接"}, status_code=502)
    rid = next(_ids)
    q: asyncio.Queue = asyncio.Queue()
    dev.streams[rid] = q
    try:
        await dev.ws.send_json({"id": rid, "action": "fetch", "params": {"url": url, "headers": headers}})
        meta = await asyncio.wait_for(q.get(), timeout=TIMEOUT_CMD)
        if not isinstance(meta, dict) or meta.get("type") != "meta":
            raise RuntimeError(meta.get("error", "设备取流失败") if isinstance(meta, dict) else "设备取流失败")
        status = int(meta.get("status", 200))
        meta_headers = meta.get("headers") or {}
        content_type = meta_headers.get("Content-Type", "application/octet-stream")
        # 新版设备在 meta 里回传重定向后的最终地址，作为相对路径解析基准
        base = meta.get("url") or url
        is_m3u8 = ".m3u8" in base or "mpegurl" in content_type
        if is_m3u8:
            parts = []
            while True:
                item = await asyncio.wait_for(q.get(), timeout=TIMEOUT_CMD)
                if item is None or isinstance(item, dict):
                    break
                parts.append(item)
                if sum(len(p) for p in parts) > 4 * 1024 * 1024:
                    break
            if status >= 400:
                dev.streams.pop(rid, None)
                return JSONResponse({"error": f"源站返回 HTTP {status}"}, status_code=502)
            data = b"".join(parts)
            if not data.strip():  # 空列表同样转 502，理由同直连路径
                dev.streams.pop(rid, None)
                return JSONResponse({"error": "源站返回空播放列表"}, status_code=502)
            dev.streams.pop(rid, None)
            rewritten = _rewrite_m3u8(request, base, h, 1, data)
            return StreamingResponse(iter([rewritten]), status_code=200, media_type="application/vnd.apple.mpegurl",
                                     headers={"Access-Control-Allow-Origin": "*", "Cache-Control": "no-cache"})
        out_headers = {"Access-Control-Allow-Origin": "*"}
        for name in ("Content-Length", "Content-Range", "Accept-Ranges"):
            if name in meta_headers:
                out_headers[name] = meta_headers[name]

        # ---- EAC3/AC3 音频兜底转码（设备路径，仅 ts 分片）----
        # 队列里拿头部探测字节（不足则多取几块），判定与直连路径同一份 LRU；
        # 原始 url 与最终地址 base 都查 .ts（CDN 302 会丢后缀）
        ct_lower = content_type.lower()
        looks_like_ts = ("mp2t" in ct_lower
                         or ".ts" in urlparse(url).path or ".ts" in urlparse(base).path)
        transcode = False
        head_chunk = b""
        if looks_like_ts:
            if _need_audio_transcode(base):
                transcode = True
            else:
                try:
                    while len(head_chunk) < AUDIO_TRANSCODE_PROBE:
                        item = await asyncio.wait_for(q.get(), timeout=TIMEOUT_CMD)
                        if item is None or isinstance(item, dict):
                            break
                        head_chunk += item
                except asyncio.TimeoutError:
                    head_chunk = b""
                if head_chunk:
                    transcode = _sniff_audio_transcode(head_chunk)
                    _mark_audio_transcode(base, transcode)

        if transcode:
            proc = _ffmpeg_audio_pipe()
            if proc is not None:
                async def gen_transcode_dev():
                    loop = asyncio.get_running_loop()
                    proc_stdin = proc.stdin
                    proc_stdout = proc.stdout
                    assert proc_stdin and proc_stdout

                    async def pump():
                        try:
                            if head_chunk:
                                await loop.run_in_executor(None, proc_stdin.write, head_chunk)
                            while True:
                                item = await q.get()
                                if item is None or isinstance(item, dict):
                                    return
                                await loop.run_in_executor(None, proc_stdin.write, item)
                        except Exception:
                            pass
                        finally:
                            try:
                                await loop.run_in_executor(None, proc_stdin.close)
                            except Exception:
                                pass

                    pump_task = asyncio.create_task(pump())
                    try:
                        while True:
                            out = await loop.run_in_executor(None, proc_stdout.read, 65536)
                            if not out:
                                break
                            yield out
                    finally:
                        pump_task.cancel()
                        for f in (proc_stdin, proc_stdout):
                            try:
                                f.close()
                            except Exception:
                                pass
                        proc.kill()
                        dev.streams.pop(rid, None)

                out_headers.pop("Content-Length", None)
                out_headers["Cache-Control"] = "no-store"
                return StreamingResponse(gen_transcode_dev(), status_code=_safe_status(status),
                                         media_type="video/mp2t", headers=out_headers)

        async def gen():
            try:
                # 探测阶段消费掉的头部字节先补回（transcode=False 走到这里），否则分片损坏
                if head_chunk:
                    yield head_chunk
                while True:
                    item = await q.get()
                    if item is None or isinstance(item, dict):  # 断开 / end / error
                        return
                    yield item
            finally:
                dev.streams.pop(rid, None)

        return StreamingResponse(gen(), status_code=_safe_status(status), media_type=content_type, headers=out_headers)
    except (asyncio.TimeoutError, RuntimeError) as e:
        dev.streams.pop(rid, None)
        return JSONResponse({"error": f"设备取流失败: {e}"}, status_code=502)


# ---------------- 管理端：设备与搜索站点 ----------------

class SelectBody(BaseModel):
    id: str


class SiteDisableBody(BaseModel):
    site_keys: list[str] | None = None  # 为空时作用于全部站点
    disabled: bool


class LiveDisableBody(BaseModel):
    names: list[str] | None = None  # 为空时作用于全部直播源
    disabled: bool


@router.get("/api/devices")
async def api_devices():
    devices = database.list_devices()
    for d in devices:
        dev = _devices.get(d["id"])
        d["online"] = dev is not None and dev.online
    devices.sort(key=lambda d: not d["online"])  # 在线优先，组内保持最近连接在前
    return {"devices": devices, "active_id": database.get_setting("active_device_id")}


@router.post("/api/devices/select")
async def api_select_device(body: SelectBody):
    dev = _devices.get(body.id)
    if dev is None or not dev.online:
        return {"error": "设备不在线，只能选择已连接的 APP 端"}
    database.set_setting("active_device_id", body.id)
    _clear_sites_cache()
    print(f"[bridge] active device -> {dev.name} ({dev.id[:8]})", flush=True)
    return {"ok": True, "active_id": body.id}


@router.get("/api/search-sites")
async def api_search_sites():
    return {"sites": database.list_search_sites()}


@router.post("/api/search-sites/set")
async def api_set_search_site(body: SiteDisableBody):
    database.set_search_site_disabled(body.site_keys, body.disabled)
    return {"ok": True}


@router.get("/api/live-sources")
async def api_live_sources():
    """直播源登记清单（/cine liveList 自动登记），禁用后视频网站不再展示该源。"""
    return {"sources": database.list_live_sources()}


@router.post("/api/live-sources/set")
async def api_set_live_source(body: LiveDisableBody):
    database.set_live_source_disabled(body.names, body.disabled)
    return {"ok": True}
