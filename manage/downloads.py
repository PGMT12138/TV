"""CINE 缓存 API、管理员文件管理及单进程任务调度。"""
import asyncio
import os
from pathlib import Path
import time
from urllib.parse import urlsplit

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import FileResponse, HTMLResponse
from pydantic import BaseModel, Field

import bridge
import database
import download_store as store
import download_engine as engine
from cine import _current_user

router = APIRouter()
_serving = {}


def csrf(request):
    origin = request.headers.get("origin")
    if origin and (urlsplit(origin).netloc != request.url.netloc or urlsplit(origin).scheme != request.url.scheme):
        raise HTTPException(403, "不允许跨站修改缓存任务")
    if request.headers.get("sec-fetch-site") == "cross-site":
        raise HTTPException(403, "不允许跨站访问缓存任务")


def user(request):
    result = _current_user(request)
    if result is None:
        raise HTTPException(401, "请先登录后使用缓存")
    return result


def enabled():
    return database.get_setting("downloads_enabled", "1") == "1"


def check_enabled():
    if not enabled():
        raise HTTPException(403, "管理员已关闭影片缓存")


def public(task):
    # 播放 token 及内部资源标识不会出现在列表/错误中。
    result = {k: v for k, v in task.items() if k not in ("source", "device_id")}
    result["source"] = {k: task["source"].get(k) for k in ("movieId", "title", "siteName", "flag", "episodeName", "episodeNumber")}
    result["file_available"] = task["status"] == "completed" and file_path(task).is_file()
    return result


def owned(request, task_id, administrative=False):
    owner = None if administrative else user(request)
    task = store.get(task_id)
    if not task or (owner and task["user_id"] != owner["id"]):
        raise HTTPException(404, "下载记录不存在")
    return task


def file_path(task):
    suffix = Path(task["filename"]).suffix
    if suffix not in (".mp4", ".mkv", ".ts"):
        suffix = ".invalid"
    return engine.folder(task["id"]) / ("result" + suffix)


class Manager:
    def __init__(self):
        self.running = {}
        self.lock = asyncio.Lock()
        self.loop_task = None
        self.lock_file = None

    async def start(self):
        store.init()
        engine.ROOT.mkdir(parents=True, exist_ok=True)
        # 同时有多个 worker 会重复下载且无法共享设备桥，启动时显式拒绝。
        self.lock_file = (engine.ROOT / ".worker.lock").open("a+b")
        self.lock_file.seek(0)
        try:
            if os.name == "nt":
                import msvcrt
                self.lock_file.write(b"0")
                self.lock_file.flush()
                self.lock_file.seek(0)
                msvcrt.locking(self.lock_file.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(self.lock_file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            self.lock_file.close()
            self.lock_file = None
            raise RuntimeError("缓存任务和设备桥只支持单个 Uvicorn worker")
        for task in store.by_status(*store.ACTIVE):
            store.update(task["id"], status="interrupted", error="服务重启，任务已中断，可从头重试")
            engine.remove_files(task["id"])
        await self.cleanup()
        self.loop_task = asyncio.create_task(self.loop())

    async def stop(self):
        if self.loop_task:
            self.loop_task.cancel()
            await asyncio.gather(self.loop_task, return_exceptions=True)
        for task_id in list(self.running):
            await self.cancel(task_id, "interrupted", "服务关闭，任务已中断")
        if self.lock_file:
            self.lock_file.close()
            self.lock_file = None

    async def execute(self, task):
        try:
            async with asyncio.timeout(6 * 3600):
                await engine.Engine(task).run()
        except asyncio.CancelledError:
            raise
        except Exception as e:
            message = str(e) if isinstance(e, engine.DownloadError) else "下载失败：源连接异常或视频处理错误，请重试"
            store.update(task["id"], status="failed", error=message[:300])
        finally:
            if store.get(task["id"])["status"] != "completed":
                engine.remove_files(task["id"])

    async def loop(self):
        count = 0
        while True:
            async with self.lock:
                for key, task in list(self.running.items()):
                    if task.done():
                        # 回收异常，避免后台任务出现未读取的异常警告。
                        await asyncio.gather(task, return_exceptions=True)
                        self.running.pop(key, None)
                if enabled():
                    busy_users = {store.get(key)["user_id"] for key in self.running}
                    for row in store.by_status("queued"):
                        if len(self.running) >= max(1, int(os.environ.get("DOWNLOAD_CONCURRENCY", "2"))):
                            break
                        if row["user_id"] in busy_users:
                            continue
                        store.update(row["id"], status="resolving")
                        self.running[row["id"]] = asyncio.create_task(self.execute(row))
                        busy_users.add(row["user_id"])
                if count % 60 == 0:
                    await self.cleanup()
            count += 1
            await asyncio.sleep(1)

    async def cleanup(self):
        for task in store.by_status("completed", "deleted", "expired", "failed", "cancelled", "interrupted"):
            if _serving.get(task["id"]):
                continue
            try:
                if task["status"] == "completed":
                    if not file_path(task).is_file():
                        store.update(task["id"], status="missing", error="服务端文件已不存在")
                    elif task["expires_at"] and task["expires_at"] <= time.time():
                        engine.remove_files(task["id"])
                        store.update(task["id"], status="expired", error="缓存文件已到期清理")
                else:
                    engine.remove_files(task["id"])
            except OSError:
                store.update(task["id"], error="临时文件被占用或无删除权限，稍后自动重试清理")

    async def cancel(self, task_id, state="cancelled", reason="任务已取消"):
        task = store.get(task_id)
        if task["status"] not in store.ACTIVE:
            return
        work = self.running.pop(task_id, None)
        if work:
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
        store.update(task_id, status=state, error=reason)
        try:
            engine.remove_files(task_id)
        except OSError:
            store.update(task_id, error=reason + "；临时文件稍后自动清理")


manager = Manager()


class CreateBody(BaseModel):
    movieId: str = Field(min_length=1, max_length=200)
    title: str = Field(min_length=1, max_length=200)
    siteKey: str = Field(min_length=1, max_length=200)
    siteName: str = Field(default="", max_length=200)
    vodId: str = Field(min_length=1, max_length=4000)
    flag: str = Field(min_length=1, max_length=200)
    episodeId: str = Field(min_length=1, max_length=16000)
    episodeName: str = Field(min_length=1, max_length=200)
    episodeNumber: int = Field(ge=1, le=100000)


class SettingBody(BaseModel):
    enabled: bool


@router.get("/api/downloads/config")
async def config():
    return {"enabled": enabled(), "retentionHours": engine.RETENTION / 3600,
            "available": bool(engine.FFMPEG and engine.FFPROBE)}


@router.post("/api/downloads")
async def create(request: Request, body: CreateBody):
    csrf(request)
    owner = user(request)
    async with manager.lock:
        check_enabled()
        if not engine.FFMPEG or not engine.FFPROBE:
            raise HTTPException(503, "服务器需要安装 ffmpeg 和 ffprobe 后才能缓存")
        dev = bridge.active_device()
        if not dev or not dev.online:
            raise HTTPException(409, "来源设备未连接")
        source = body.model_dump()
        active = [t for t in store.by_status(*store.ACTIVE) if t["user_id"] == owner["id"]]
        for task in active:
            if task["device_id"] == dev.id and all(task["source"].get(k) == source[k] for k in ("siteKey", "vodId", "flag", "episodeId")):
                return public(task)
        if len(active) >= 10 or len(store.by_status(*store.ACTIVE)) >= 100:
            raise HTTPException(429, "排队任务过多，请等待已有任务完成")
        task = store.create(owner["id"], dev.id, source)
        return public(task)


@router.get("/api/downloads")
async def list_user(request: Request, offset: int = 0):
    owner = user(request)
    rows, total = store.list_tasks(owner["id"], offset=max(0, offset))
    return {"items": [public(row) for row in rows], "total": total, "enabled": enabled()}


@router.get("/api/downloads/{task_id}")
async def detail(request: Request, task_id: str):
    return public(owned(request, task_id))


async def mutate(request, task_id, action, administrative=False):
    csrf(request)
    async with manager.lock:
        task = owned(request, task_id, administrative)
        if action == "cancel":
            await manager.cancel(task_id)
        elif action == "retry":
            check_enabled()
            if task["status"] not in ("failed", "cancelled", "interrupted", "expired", "missing"):
                raise HTTPException(409, "此任务当前不能重试")
            active = store.by_status(*store.ACTIVE)
            if len(active) >= 100 or sum(t["user_id"] == task["user_id"] for t in active) >= 10:
                raise HTTPException(429, "排队任务过多")
            if any(t["user_id"] == task["user_id"] and t["source"] == task["source"] for t in active):
                raise HTTPException(409, "已有相同任务正在执行")
            engine.remove_files(task_id)
            store.update(task_id, status="queued", error="", bytes_done=0, bytes_total=0,
                         segments_done=0, segments_total=0, filename="", size=0, duration=0, expires_at=0)
        elif action == "delete":
            if _serving.get(task_id):
                raise HTTPException(409, "文件正在查看或下载，请稍后删除")
            await manager.cancel(task_id)
            engine.remove_files(task_id)
            store.update(task_id, status="deleted", error="服务端文件已删除，记录保留")
        return public(store.get(task_id))


@router.post("/api/downloads/{task_id}/cancel")
async def cancel(request: Request, task_id: str):
    return await mutate(request, task_id, "cancel")


@router.post("/api/downloads/{task_id}/retry")
async def retry(request: Request, task_id: str):
    return await mutate(request, task_id, "retry")


@router.delete("/api/downloads/{task_id}")
async def delete(request: Request, task_id: str):
    return await mutate(request, task_id, "delete")


class CachedFileResponse(FileResponse):
    def __init__(self, *args, task_id, **kwargs):
        super().__init__(*args, **kwargs)
        self.task_id = task_id

    async def __call__(self, scope, receive, send):
        try:
            await super().__call__(scope, receive, send)
        finally:
            _serving[self.task_id] -= 1
            if not _serving[self.task_id]:
                _serving.pop(self.task_id, None)


async def serve(request, task_id, preview=False, administrative=False):
    async with manager.lock:
        task = owned(request, task_id, administrative)
        if task["status"] != "completed":
            raise HTTPException(409, "文件尚未就绪或已清理")
        path = file_path(task)
        if not path.is_file() or path.is_symlink():
            raise HTTPException(410, "文件已不存在")
        _serving[task_id] = _serving.get(task_id, 0) + 1
        return CachedFileResponse(path, task_id=task_id, filename=task["filename"],
            content_disposition_type="inline" if preview else "attachment",
            media_type={".mp4": "video/mp4", ".mkv": "video/x-matroska", ".ts": "video/mp2t"}.get(path.suffix),
            headers={"Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff"})


@router.api_route("/api/downloads/{task_id}/file", methods=["GET", "HEAD"])
async def file(request: Request, task_id: str, preview: bool = False):
    return await serve(request, task_id, preview)


@router.get("/downloads", response_class=HTMLResponse)
async def admin_page():
    return HTMLResponse((Path(__file__).parent / "templates" / "downloads.html").read_text("utf-8"), headers={"Cache-Control": "no-store"})


@router.get("/api/admin/downloads")
async def admin_list(request: Request, offset: int = 0, status: str = ""):
    rows, total = store.list_tasks(offset=max(0, offset), status=status)
    return {"items": [public(row) for row in rows], "total": total, "enabled": enabled(),
            "usedBytes": await asyncio.to_thread(engine.disk_usage), "maxBytes": engine.MAX_STORAGE,
            "retentionHours": engine.RETENTION / 3600, "available": bool(engine.FFMPEG and engine.FFPROBE)}


@router.put("/api/admin/downloads/settings")
async def settings(request: Request, body: SettingBody):
    csrf(request)
    async with manager.lock:
        database.set_setting("downloads_enabled", "1" if body.enabled else "0")
        if not body.enabled:
            for task in store.by_status(*store.ACTIVE):
                await manager.cancel(task["id"], reason="管理员已关闭缓存，任务已停止")
    return {"enabled": enabled()}


@router.post("/api/admin/downloads/{task_id}/cancel")
async def admin_cancel(request: Request, task_id: str):
    return await mutate(request, task_id, "cancel", True)


@router.post("/api/admin/downloads/{task_id}/retry")
async def admin_retry(request: Request, task_id: str):
    return await mutate(request, task_id, "retry", True)


@router.delete("/api/admin/downloads/{task_id}")
async def admin_delete(request: Request, task_id: str):
    return await mutate(request, task_id, "delete", True)


@router.api_route("/api/admin/downloads/{task_id}/file", methods=["GET", "HEAD"])
async def admin_file(request: Request, task_id: str, preview: bool = False):
    return await serve(request, task_id, preview, True)
