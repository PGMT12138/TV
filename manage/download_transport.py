"""下载专用原始取流：DNS 固定、逐跳校验、设备固定及消费确认；不经过播放转码。"""
import asyncio
import ipaddress
import os
import socket
from contextlib import asynccontextmanager
from urllib.parse import urljoin, urlsplit

import httpx
import bridge


class DownloadError(Exception):
    pass


def device_local(url):
    return urlsplit(url).hostname in ("localhost", "127.0.0.1", "::1")


async def destination(url):
    parsed = urlsplit(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname or parsed.username or parsed.password:
        raise DownloadError("下载来源必须是有效的 HTTP(S) 地址")
    if any(c in url for c in ("\r", "\n", "\x00")):
        raise DownloadError("无效的来源地址")
    allowed = {h.strip().lower() for h in os.environ.get("DOWNLOAD_ALLOWED_HOSTS", "").split(",") if h.strip()}
    try:
        rows = await asyncio.get_running_loop().getaddrinfo(parsed.hostname, parsed.port or (443 if parsed.scheme == "https" else 80), type=socket.SOCK_STREAM)
    except OSError as e:
        raise DownloadError("无法解析视频源域名") from e
    ips = {row[4][0] for row in rows}
    if not ips or (parsed.hostname.lower() not in allowed and any(not ipaddress.ip_address(ip).is_global for ip in ips)):
        raise DownloadError("下载来源指向受限网络地址")
    return parsed, sorted(ips)[0]


class RawReader:
    def __init__(self, device_id, headers=None, local=False):
        self.device_id, self.local = device_id, local
        self.clients = {}
        self.headers = {str(k): str(v) for k, v in (headers or {}).items()
                        if str(k).lower() not in ("host", "content-length", "connection", "range", "accept-encoding")}
        if any("\r" in s or "\n" in s for pair in self.headers.items() for s in pair):
            raise DownloadError("来源请求头无效")
        self.headers["Accept-Encoding"] = "identity"

    async def aclose(self):
        for client in self.clients.values():
            await client.aclose()
        self.clients.clear()

    @asynccontextmanager
    async def open(self, url, byte_range=None):
        headers = dict(self.headers)
        if byte_range:
            headers["Range"] = f"bytes={byte_range[0]}-{byte_range[1]}"
        if self.local:
            async with self._device(url, headers) as result:
                yield result
            return
        try:
            for _ in range(6):
                parsed, ip = await destination(url)
                # 按源域隔离 TLS 连接池，同一 CDN IP 的不同域名也分别校验证书。
                origin = (parsed.scheme, parsed.netloc)
                if origin not in self.clients:
                    if len(self.clients) >= 64:
                        raise DownloadError("视频源域名数量过多")
                    self.clients[origin] = httpx.AsyncClient(timeout=httpx.Timeout(20, read=60), trust_env=False)
                client = self.clients[origin]
                target = httpx.URL(url).copy_with(host=ip)
                request_headers = {**headers, "Host": parsed.netloc}
                req = client.build_request("GET", target, headers=request_headers, extensions={"sni_hostname": parsed.hostname})
                response = await client.send(req, stream=True)
                try:
                    if response.status_code in (301, 302, 303, 307, 308):
                        next_url = urljoin(url, response.headers.get("location", ""))
                        if urlsplit(next_url).hostname != parsed.hostname:
                            headers = {k: v for k, v in headers.items() if k.lower() not in ("authorization", "cookie")}
                        url = next_url
                        continue
                    yield {"status": response.status_code, "headers": dict(response.headers), "url": url}, response.aiter_raw(65536)
                    return
                finally:
                    await response.aclose()
            raise DownloadError("视频源重定向次数过多")
        except Exception:
            await self.aclose()
            raise

    @asynccontextmanager
    async def _device(self, url, headers):
        headers = dict(headers)
        for _ in range(6):
            async with self._device_once(url, headers) as (meta, chunks):
                if meta["status"] in (301, 302, 303, 307, 308):
                    next_url = urljoin(url, meta["headers"].get("location", ""))
                    if urlsplit(next_url).hostname != urlsplit(url).hostname:
                        headers = {k: v for k, v in headers.items() if k.lower() not in ("authorization", "cookie")}
                    url = next_url
                    continue
                yield meta, chunks
                return
        raise DownloadError("设备视频源重定向次数过多")

    @asynccontextmanager
    async def _device_once(self, url, headers):
        # 本地代理仅在已解析为 local 的任务中放行；公网地址仍校验。
        pinned_ip = ""
        if device_local(url):
            if not self.local:
                raise DownloadError("公网清单不能访问设备本地地址")
            if urlsplit(url).scheme not in ("http", "https") or urlsplit(url).username or any(c in url for c in ("\r", "\n", "\x00")):
                raise DownloadError("设备代理地址无效")
        else:
            _, pinned_ip = await destination(url)
        dev = bridge._devices.get(self.device_id)
        if not dev or not dev.online:
            raise DownloadError("来源设备已离线，请重新连接后重试")
        if not dev.fetch_flow:
            raise DownloadError("设备版本不支持可靠缓存，请安装新版 Android App 后重试")
        rid, ws = next(bridge._ids), dev.ws
        # 下载帧窗口 8，小于容量；put_nowait 不阻塞共用的 WebSocket 接收循环。
        queue = asyncio.Queue(maxsize=32)
        dev.streams[rid] = queue
        try:
            await ws.send_json({"id": rid, "action": "fetch", "params": {"url": url, "headers": headers, "flowControl": True, "resolvedIp": pinned_ip}})
            meta = await asyncio.wait_for(queue.get(), 90)
            if not isinstance(meta, dict) or meta.get("type") != "meta":
                raise DownloadError("设备取流失败或已断开")

            async def chunks():
                while True:
                    item = await asyncio.wait_for(queue.get(), 60)
                    if isinstance(item, bytes):
                        yield item
                        await ws.send_json({"id": 0, "action": "fetchAck", "params": {"fetchId": rid}})
                    elif isinstance(item, dict) and item.get("type") == "end":
                        return
                    else:
                        raise DownloadError("设备取流中断，文件未完整接收")
            yield {"status": int(meta.get("status", 502)), "headers": {k.lower(): v for k, v in (meta.get("headers") or {}).items()},
                   "url": meta.get("url") or url}, chunks()
        finally:
            dev.streams.pop(rid, None)
            if dev.ws is ws:
                try:
                    await ws.send_json({"id": 0, "action": "cancelFetch", "params": {"fetchId": rid}})
                except Exception:
                    pass
