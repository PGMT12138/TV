"""完整文件下载和 HLS 本地化封装。FFmpeg 只读取生成的本地清单。"""
import asyncio
import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import time
from urllib.parse import urljoin

import m3u8
import httpx

import bridge
import download_store as store
from download_transport import DownloadError, RawReader

ROOT = Path(os.environ.get("DOWNLOAD_DIR", Path(__file__).parent / "data" / "downloads")).resolve()
MAX_BYTES = int(os.environ.get("DOWNLOAD_MAX_BYTES", 20 * 1024**3))
MIN_FREE = int(os.environ.get("DOWNLOAD_MIN_FREE_BYTES", 1024**3))
MAX_STORAGE = int(os.environ.get("DOWNLOAD_MAX_STORAGE_BYTES", 100 * 1024**3))
RETENTION = int(os.environ.get("DOWNLOAD_RETENTION_HOURS", 24)) * 3600
FFMPEG = os.environ.get("FFMPEG") or shutil.which("ffmpeg")
FFPROBE = os.environ.get("FFPROBE") or shutil.which("ffprobe")


def folder(task_id):
    if not re.fullmatch(r"[0-9a-f]{32}", task_id):
        raise DownloadError("任务编号无效")
    result = (ROOT / task_id).resolve()
    if result.parent != ROOT or (ROOT / task_id).is_symlink():
        raise DownloadError("任务目录无效")
    return result


def remove_files(task_id):
    path = folder(task_id)
    if path.exists():
        shutil.rmtree(path)


def disk_usage():
    ROOT.mkdir(parents=True, exist_ok=True)
    total = 0
    for path in ROOT.glob("*/*"):
        try:
            if not path.is_symlink() and path.is_file():
                total += path.stat().st_size
        except FileNotFoundError:
            pass  # 与其他任务完成清理或管理员删除并发。
    return total


def filename(title, episode, suffix):
    name = re.sub(r'[<>:"/\\|?*\x00-\x1f]', "_", f"{title}-{episode}").strip(" .")[:140] or "视频"
    return name + suffix


class Engine:
    def __init__(self, task):
        self.task, self.id = task, task["id"]
        self.path = folder(self.id)
        self.bytes, self.last_update, self.last_disk = 0, 0, 0
        self.reader = None
        self.file_counter = 0

    async def check_disk(self, force=False):
        now = time.monotonic()
        if force or now - self.last_disk >= 1:
            self.last_disk = now
            if shutil.disk_usage(ROOT).free < MIN_FREE:
                raise DownloadError("服务器磁盘剩余空间不足")
            if await asyncio.to_thread(disk_usage) > MAX_STORAGE:
                raise DownloadError("服务器缓存空间已达上限")
        if self.bytes > MAX_BYTES:
            raise DownloadError("影片大小超过单任务缓存上限")

    def progress(self, force=False, **extra):
        if force or time.monotonic() - self.last_update >= 0.5:
            self.last_update = time.monotonic()
            store.update(self.id, bytes_done=self.bytes, **extra)

    async def fetch(self, url, target, *, cap=MAX_BYTES, byte_range=None, detect=False):
        before = self.bytes
        for attempt in range(3):
            self.bytes = before
            try:
                async with self.reader.open(url, byte_range) as (meta, chunks):
                    status, headers = meta["status"], meta["headers"]
                    if status not in (200, 206):
                        raise DownloadError(f"视频源返回 HTTP {status}")
                    expected = int(headers.get("content-length") or 0)
                    if byte_range:
                        if status != 206 or not headers.get("content-range", "").startswith(f"bytes {byte_range[0]}-{byte_range[1]}/"):
                            raise DownloadError("源站未正确响应分片范围请求")
                        expected = byte_range[1] - byte_range[0] + 1
                    elif status == 206:
                        raise DownloadError("源站只返回了部分视频")
                    if expected > cap:
                        raise DownloadError("资源大小超过限制")
                    size, first, is_list = 0, b"", False
                    with target.open("wb") as out:
                        async for data in chunks:
                            if len(first) < 512:
                                first += data[:512-len(first)]
                                is_list = first.lstrip(b"\xef\xbb\xbf \r\n\t").startswith(b"#EXTM3U")
                            size += len(data)
                            if size > cap or (detect and is_list and size > 4 * 1024**2):
                                raise DownloadError("播放清单或媒体超过大小限制")
                            self.bytes += len(data)
                            await self.check_disk()
                            out.write(data)
                            if detect and not is_list:
                                self.progress(bytes_total=expected)
                            else:
                                self.progress()
                    if not size or (expected and expected != size):
                        raise DownloadError("媒体数据不完整")
                    self.progress(force=True)
                    return meta, is_list
            except (OSError, TimeoutError, DownloadError, httpx.HTTPError):
                target.unlink(missing_ok=True)
                if attempt == 2:
                    raise
                await asyncio.sleep(0.5 * (attempt + 1))

    async def playlist(self, url, depth=0):
        if depth > 4:
            raise DownloadError("嵌套播放清单过深")
        target = self.path / f"source-{self.file_counter}.txt"
        self.file_counter += 1
        meta, _ = await self.fetch(url, target, cap=4 * 1024**2)
        text = target.read_text("utf-8-sig")
        target.unlink()
        if not text.lstrip().startswith("#EXTM3U"):
            raise DownloadError("视频源未返回有效的 HLS 清单")
        return await self.select_playlist(text, meta["url"], depth)

    async def select_playlist(self, text, url, depth=0):
        parsed = m3u8.loads(text, uri=url)
        if parsed.session_keys and any(k.method not in ("AES-128", "NONE") for k in parsed.session_keys):
            raise DownloadError("暂不支持 DRM 保护的视频")
        if parsed.is_variant:
            if not parsed.playlists:
                raise DownloadError("主清单没有可下载线路")
            chosen = max(parsed.playlists, key=lambda p: p.stream_info.bandwidth or 0)
            video, nested_audio = await self.playlist(chosen.absolute_uri, depth + 1)
            audio = [m for m in parsed.media if m.type == "AUDIO" and m.group_id == chosen.stream_info.audio and m.uri]
            if audio:
                selected = next((a for a in audio if a.default == "YES"), audio[0])
                audio_list, _ = await self.playlist(selected.absolute_uri, depth + 1)
                return video, audio_list
            return video, nested_audio
        if not parsed.is_endlist:
            raise DownloadError("只支持完整点播视频，暂不支持直播或未结束清单")
        if not parsed.segments or len(parsed.segments) > 20000:
            raise DownloadError("播放清单为空或分片数量过多")
        if parsed.session_keys:
            raise DownloadError("该清单的会话密钥格式暂不支持")
        if any(not math.isfinite(s.duration or 0) or s.duration <= 0 or s.gap_tag for s in parsed.segments):
            raise DownloadError("播放清单包含无效或缺失分片")
        return parsed, None

    async def localize(self, parsed, name, done=0):
        lines = ["#EXTM3U", "#EXT-X-VERSION:7", f"#EXT-X-TARGETDURATION:{math.ceil(max(s.duration for s in parsed.segments))}",
                 f"#EXT-X-MEDIA-SEQUENCE:{parsed.media_sequence}", "#EXT-X-PLAYLIST-TYPE:VOD"]
        keys, maps = {}, {}
        last_key, last_map, previous_range = None, None, None
        async def save(url, suffix, byte_range=None, cap=MAX_BYTES):
            leaf = f"part-{self.file_counter}{suffix}"
            self.file_counter += 1
            await self.fetch(url, self.path / leaf, cap=cap, byte_range=byte_range)
            return leaf
        for i, segment in enumerate(parsed.segments):
            if segment.discontinuity:
                lines.append("#EXT-X-DISCONTINUITY")
            key = segment.key
            key_id = (key.method, key.absolute_uri, key.iv, key.keyformat) if key else None
            if key_id != last_key:
                if key and key.method != "NONE":
                    if key.method != "AES-128" or key.keyformat not in (None, "identity"):
                        raise DownloadError("暂不支持 DRM 或此加密方式")
                    if key.iv and not re.fullmatch(r"0[xX][0-9a-fA-F]{1,32}", key.iv):
                        raise DownloadError("HLS 密钥 IV 无效")
                    if key.absolute_uri not in keys:
                        keys[key.absolute_uri] = await save(key.absolute_uri, ".key", cap=16)
                    if (self.path / keys[key.absolute_uri]).stat().st_size != 16:
                        raise DownloadError("AES-128 密钥长度无效")
                    line = f'#EXT-X-KEY:METHOD=AES-128,URI="{keys[key.absolute_uri]}"'
                    if key.iv:
                        line += f",IV={key.iv}"
                    lines.append(line)
                else:
                    lines.append("#EXT-X-KEY:METHOD=NONE")
                last_key = key_id
            init = segment.init_section
            if init:
                map_id = (init.absolute_uri, init.byterange)
                if map_id != last_map:
                    if map_id not in maps:
                        rng = self.parse_range(init.byterange, init.absolute_uri, None)[0] if init.byterange else None
                        maps[map_id] = await save(init.absolute_uri, ".mp4", rng)
                    lines.append(f'#EXT-X-MAP:URI="{maps[map_id]}"')
                    last_map = map_id
            rng, previous_range = self.parse_range(segment.byterange, segment.absolute_uri, previous_range)
            leaf = await save(segment.absolute_uri, ".m4s" if init else ".ts", rng)
            lines.extend([f"#EXTINF:{segment.duration},", leaf])
            store.update(self.id, segments_done=done + i + 1)
        lines.append("#EXT-X-ENDLIST")
        target = self.path / name
        target.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return target

    @staticmethod
    def parse_range(value, url, previous):
        if not value:
            return None, None
        parts = value.split("@")
        size = int(parts[0])
        if len(parts) == 2:
            start = int(parts[1])
        elif len(parts) == 1 and previous and previous[0] == url:
            start = previous[1] + 1
        else:
            raise DownloadError("分片范围缺少有效起点")
        if size <= 0 or start < 0 or size > MAX_BYTES:
            raise DownloadError("分片范围无效")
        return (start, start + size - 1), (url, start + size - 1)

    async def command(self, args, timeout=1800):
        stdout, stderr = self.path / "process.out", self.path / "process.err"
        with stdout.open("wb") as out, stderr.open("wb") as err:
            process = subprocess.Popen(args, cwd=self.path, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            try:
                deadline = time.monotonic() + timeout
                while process.poll() is None:
                    if time.monotonic() > deadline:
                        raise DownloadError("视频处理超时")
                    await self.check_disk()
                    if stdout.stat().st_size + stderr.stat().st_size > 2 * 1024**2:
                        raise DownloadError("视频处理产生过多错误")
                    if any(p.stat().st_size > MAX_BYTES for p in self.path.glob("result.*")):
                        raise DownloadError("生成文件超过大小限制")
                    await asyncio.sleep(0.2)
                return process.returncode, stdout.read_bytes(), stderr.read_bytes()
            finally:
                if process.poll() is None:
                    process.kill()
                await asyncio.to_thread(process.wait)

    async def probe(self, path):
        code, data, _ = await self.command([FFPROBE, "-v", "error", "-protocol_whitelist", "file", "-format_whitelist", "mov,matroska,mpegts", "-show_entries",
            "format=duration,format_name:stream=codec_type,codec_name,duration", "-of", "json", str(path)], timeout=60)
        if code:
            raise DownloadError("视频文件校验失败")
        info = json.loads(data)
        if not any(s.get("codec_type") == "video" for s in info.get("streams", [])):
            raise DownloadError("文件中没有可用视频轨道")
        duration = float(info.get("format", {}).get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0:
            raise DownloadError("视频时长无效")
        return info, duration

    async def run(self):
        try:
            await self._run()
        finally:
            if self.reader:
                await self.reader.aclose()

    async def _run(self):
        if not FFMPEG or not FFPROBE:
            raise DownloadError("服务器未安装 ffmpeg / ffprobe")
        self.path.mkdir(parents=True, exist_ok=True)
        await self.check_disk(force=True)
        source = self.task["source"]
        store.update(self.id, status="resolving")
        data = await bridge.call_device("player", {"key": source["siteKey"], "flag": source["flag"], "id": source["episodeId"]},
                                        device_id=self.task["device_id"])
        url = (data.get("url") or "").strip()
        if not url.startswith(("https://", "http://")):
            # 选集 token 过期时按原线路及集序号取新 token，绝不换其他线路。
            detail = await bridge.call_device("detail", {"key": source["siteKey"], "id": source["vodId"]}, device_id=self.task["device_id"])
            line = next((f for f in detail.get("flags", []) if f["flag"] == source["flag"]), None)
            episodes = line.get("episodes", []) if line else []
            index = source["episodeNumber"] - 1
            if index < 0 or index >= len(episodes):
                raise DownloadError("原线路或选集已失效，请重新选择后缓存")
            data = await bridge.call_device("player", {"key": source["siteKey"], "flag": source["flag"], "id": episodes[index]["url"]}, device_id=self.task["device_id"])
            url = (data.get("url") or "").strip()
        self.reader = RawReader(self.task["device_id"], data.get("headers"), bool(data.get("local")))
        store.update(self.id, status="downloading")
        incoming = self.path / "incoming.bin"
        meta, is_list = await self.fetch(url, incoming, detect=True)
        if is_list:
            video, audio = await self.select_playlist(incoming.read_text("utf-8-sig"), meta["url"])
            incoming.unlink()
            expected = sum(s.duration for s in video.segments)
            store.update(self.id, segments_total=len(video.segments) + (len(audio.segments) if audio else 0), bytes_total=0)
            video_path = await self.localize(video, "video.m3u8")
            inputs = ["-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL", "-i", str(video_path)]
            if audio:
                audio_path = await self.localize(audio, "audio.m3u8", len(video.segments))
                inputs += ["-protocol_whitelist", "file,crypto,data", "-allowed_extensions", "ALL", "-i", str(audio_path)]
            maps = ["-map", "0:v:0", "-map", "1:a:0" if audio else "0:a:0?"]
            store.update(self.id, status="muxing")
            result = self.path / "result.mp4"
            code, _, _ = await self.command([FFMPEG, "-nostdin", "-v", "error", "-xerror", "-y", *inputs, *maps, "-c", "copy", "-movflags", "+faststart", str(result)])
            if code:
                result.unlink(missing_ok=True)
                result = self.path / "result.mkv"
                code, _, _ = await self.command([FFMPEG, "-nostdin", "-v", "error", "-xerror", "-y", *inputs, *maps, "-c", "copy", str(result)])
                if code:
                    raise DownloadError("视频封装失败，源分片或编码不兼容")
            store.update(self.id, status="verifying")
            info, duration = await self.probe(result)
            if abs(duration - expected) > max(3, expected * 0.01):
                raise DownloadError("下载文件时长与源清单不符，可能存在缺片")
            if audio and not any(s.get("codec_type") == "audio" for s in info.get("streams", [])):
                raise DownloadError("下载文件缺少源音轨")
        else:
            store.update(self.id, status="verifying")
            info, duration = await self.probe(incoming)
            fmt = info.get("format", {}).get("format_name", "")
            suffix = ".mp4" if "mp4" in fmt else ".mkv" if "matroska" in fmt else ".ts" if "mpegts" in fmt else ""
            if not suffix:
                raise DownloadError("暂不支持此整文件视频格式")
            result = self.path / ("result" + suffix)
            incoming.replace(result)
        size = result.stat().st_size
        if size > MAX_BYTES:
            raise DownloadError("文件超过单任务缓存上限")
        for path in self.path.iterdir():
            if path != result and path.is_file():
                path.unlink()
        store.update(self.id, status="completed", filename=filename(source["title"], source["episodeName"], result.suffix),
                     size=size, duration=duration, error="", expires_at=time.time() + RETENTION)
