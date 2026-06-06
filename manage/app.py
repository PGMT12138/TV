import os
import json
import time
import re
import base64
import httpx
from urllib.parse import urlparse, parse_qs, unquote, quote, urljoin
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from database import (init_db, get_urls, get_all_urls, add_url, update_url, delete_url, delete_urls_batch,
                      get_app_version, set_app_version,
                      upsert_home_content, get_home_contents, get_home_content, delete_home_content,
                      delete_home_contents_batch,
                      upsert_video, get_videos, get_video, delete_video, delete_videos_batch)

app = FastAPI(root_path="/tv-manage")
templates = Jinja2Templates(directory=os.path.join(os.path.dirname(__file__), "templates"))

init_db()


class UrlCreate(BaseModel):
    type: int
    name: str = ""
    url: str
    sort: int = 0


class UrlUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    sort: int | None = None
    enabled: bool | None = None


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    return templates.TemplateResponse(request, "index.html")


@app.get("/api/urls")
async def list_urls(type: int):
    return {"urls": get_urls(type)}


@app.get("/api/urls/all")
async def list_all_urls(type: int):
    return {"urls": get_all_urls(type)}


@app.post("/api/urls")
async def create_url(item: UrlCreate):
    return add_url(item.type, item.name, item.url, item.sort)


@app.put("/api/urls/{url_id}")
async def modify_url(url_id: int, item: UrlUpdate):
    return update_url(url_id, item.name, item.url, item.sort, item.enabled)


@app.delete("/api/urls/{url_id}")
async def remove_url(url_id: int):
    delete_url(url_id)
    return {"ok": True}


def _strip_json_comments(text: str) -> str:
    """Remove // comments and trailing commas from quasi-JSON (JSONC).
    Many TV config sources use comments which standard JSON doesn't allow."""
    lines = text.split("\n")
    cleaned = []
    for line in lines:
        stripped = line.lstrip()
        if stripped.startswith("//"):
            continue
        # Remove inline // comments (but not inside strings)
        in_string = False
        escape = False
        result = []
        for i, ch in enumerate(line):
            if escape:
                result.append(ch)
                escape = False
                continue
            if ch == '\\' and in_string:
                result.append(ch)
                escape = True
                continue
            if ch == '"':
                in_string = not in_string
                result.append(ch)
                continue
            if not in_string and ch == '/' and i + 1 < len(line) and line[i + 1] == '/':
                break
            result.append(ch)
        cleaned.append("".join(result))
    # Remove trailing commas before } or ]
    joined = "\n".join(cleaned)
    joined = re.sub(r',\s*([}\]])', r'\1', joined)
    return joined


def _decode_content(data: str) -> str:
    """Mimic App's Decoder.verify: detect JSON, base64(**), AES-CBC(2423)."""
    if not data or not data.strip():
        return data
    stripped = data.strip()
    # Direct JSON object or array
    if stripped.startswith("{") or stripped.startswith("["):
        return data
    # Base64 encoded (** marker)
    if "**" in data:
        import re as _re
        m = _re.search(r'[A-Za-z0-9]{8}\*\*', data)
        if m:
            b64_part = data[data.index(m.group()) + 10:]
            try:
                return base64.b64decode(b64_part).decode("utf-8", errors="replace")
            except Exception:
                pass
    # AES/CBC encrypted (starts with 2423)
    if stripped.startswith("2423"):
        # App's CBC decryption — too complex to replicate without exact key derivation
        # Return as-is, mark as encrypted format
        return data
    return data


def _try_parse_json(text: str) -> dict | None:
    """Try to parse text as JSON, handling JSONC (comments, trailing commas)."""
    decoded = _decode_content(text)
    for candidate in (decoded, text):
        cleaned = _strip_json_comments(candidate)
        try:
            obj = json.loads(cleaned, strict=False)
            if isinstance(obj, dict):
                return obj
        except Exception:
            pass
    return None


def _check_vod_usable(status_code: int, body_text: str) -> tuple[bool, str]:
    if status_code != 200 or not body_text.strip():
        return False, "HTTP 请求失败"
    # Non-JSON text formats
    if not body_text.strip().startswith("{") and not body_text.strip().startswith("["):
        if "**" not in body_text and not body_text.strip().startswith("2423"):
            return False, "非 JSON 格式"
    obj = _try_parse_json(body_text)
    if obj is None:
        return False, "JSON 解析失败"
    if "msg" in obj:
        return False, obj["msg"]
    if "urls" in obj:
        items = obj["urls"]
        return True, f"配置仓库, {len(items)} 个地址"
    sites = obj.get("sites", [])
    if isinstance(sites, list) and len(sites) > 0:
        return True, f"{len(sites)} 个源"
    if "lives" in obj or "live" in obj:
        return True, "直播配置"
    if any(k in obj for k in ("parses", "wallpaper", "wall")):
        return True, "部分配置"
    return False, "缺少 sites 字段"


def _check_live_usable(status_code: int, body_text: str) -> tuple[bool, str]:
    if status_code != 200 or not body_text.strip():
        return False, "HTTP 请求失败"
    stripped = body_text.strip()
    if stripped.startswith("#EXTM3U") or "#EXTINF" in stripped[:500]:
        ch_count = stripped.count("#EXTINF")
        return True, f"M3U 格式, {ch_count} 频道"
    if "#genre#" in stripped[:1000]:
        lines = [l for l in stripped.split("\n") if l.strip() and not l.startswith("#")]
        return True, f"TXT 格式, {len(lines)} 行"
    obj = _try_parse_json(body_text)
    if obj is None:
        return False, "非 M3U/TXT/JSON 格式"
    if "msg" in obj:
        return False, obj["msg"]
    if "urls" in obj:
        return True, "配置仓库"
    lives = obj.get("lives", [])
    if isinstance(lives, list) and len(lives) > 0:
        return True, f"JSON 格式, {len(lives)} 直播源"
    sites = obj.get("sites", [])
    if isinstance(sites, list) and len(sites) > 0:
        return True, f"VOD 配置({len(sites)} 源)"
    return False, "缺少直播内容"


@app.post("/api/urls/{url_id}/test")
async def test_url(url_id: int):
    conn = __import__("database").get_conn()
    row = conn.execute("SELECT url, type FROM urls WHERE id = ?", (url_id,)).fetchone()
    conn.close()
    if row is None:
        return {"ok": False, "error": "配置不存在"}
    url = row["url"]
    url_type = row["type"]
    start = time.monotonic()
    try:
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            resp = await client.get(url)
        elapsed = round((time.monotonic() - start) * 1000)
        body = resp.content
        body_size = len(body)
        body_text = body.decode("utf-8", errors="replace")
        is_json = False
        try:
            json.loads(body_text)
            is_json = True
        except Exception:
            pass
        if url_type == 1:
            usable, usable_msg = _check_live_usable(resp.status_code, body_text)
        else:
            usable, usable_msg = _check_vod_usable(resp.status_code, body_text)
        body_preview = body_text[:500]
        return {
            "ok": True,
            "status": resp.status_code,
            "elapsed_ms": elapsed,
            "body_size": body_size,
            "content_type": resp.headers.get("content-type", ""),
            "is_json": is_json,
            "usable": usable,
            "usable_msg": usable_msg,
            "body_preview": body_preview,
        }
    except httpx.TimeoutException:
        elapsed = round((time.monotonic() - start) * 1000)
        return {"ok": True, "status": 0, "elapsed_ms": elapsed, "body_size": 0, "content_type": "", "is_json": False, "usable": False, "usable_msg": "请求超时", "error": "请求超时"}
    except Exception as e:
        elapsed = round((time.monotonic() - start) * 1000)
        return {"ok": True, "status": 0, "elapsed_ms": elapsed, "body_size": 0, "content_type": "", "is_json": False, "usable": False, "usable_msg": str(e), "error": str(e)}


class BatchIds(BaseModel):
    ids: list[int]


@app.post("/api/urls/batch-delete")
async def batch_remove_urls(item: BatchIds):
    delete_urls_batch(item.ids)
    return {"ok": True, "deleted": len(item.ids)}


class AppVersionUpdate(BaseModel):
    version: int
    url: str


@app.get("/api/update/{platform}")
async def get_update(platform: str):
    if platform not in ("mobile", "tv"):
        return {"version": 0, "url": ""}
    row = get_app_version(platform)
    if row is None:
        return {"version": 0, "url": ""}
    return {"version": row["version"], "url": row["url"]}


@app.put("/api/update/{platform}")
async def set_update(platform: str, item: AppVersionUpdate):
    if platform not in ("mobile", "tv"):
        return {"ok": False, "error": "Invalid platform"}
    return set_app_version(platform, item.version, item.url)


class HomeContentUpload(BaseModel):
    site_key: str
    site_name: str = ""
    config_name: str = ""
    content: str


@app.get("/api/home-contents")
async def list_home_contents(has_video: bool | None = None):
    return {"items": get_home_contents(has_video)}


@app.get("/api/home-contents/{site_key}")
async def get_home(site_key: str):
    return get_home_content(site_key)


@app.post("/api/home-contents")
async def upload_home_content(item: HomeContentUpload):
    return upsert_home_content(item.site_key, item.site_name, item.config_name, item.content)


@app.delete("/api/home-contents/{site_key}")
async def remove_home_content(site_key: str):
    delete_home_content(site_key)
    return {"ok": True}


class BatchKeys(BaseModel):
    keys: list[str]


@app.post("/api/home-contents/batch-delete")
async def batch_remove_home_contents(item: BatchKeys):
    delete_home_contents_batch(item.keys)
    return {"ok": True, "deleted": len(item.keys)}


class VideoUpload(BaseModel):
    vod_name: str = ""
    vod_pic: str = ""
    vod_year: str = ""
    vod_area: str = ""
    vod_director: str = ""
    vod_actor: str = ""
    vod_content: str = ""
    type_name: str = ""
    site_key: str = ""
    site_name: str = ""
    flag: str = ""
    episode_name: str = ""
    episode_url: str = ""
    play_url: str = ""
    headers: str = "{}"
    device_name: str = ""


@app.get("/api/videos")
async def list_videos():
    return {"items": get_videos()}


def _extract_real_url(url: str) -> str:
    """Extract real URL from Android local proxy URLs like http://127.0.0.1:9978/proxy?url=..."""
    parsed = urlparse(url)
    if parsed.hostname in ("127.0.0.1", "localhost") and "/proxy" in parsed.path:
        qs = parse_qs(parsed.query)
        if "url" in qs:
            return qs["url"][0]
    return url


def _rewrite_m3u8(base_url: str, headers_json: str, m3u8_content: bytes) -> bytes:
    """Rewrite .ts segment URLs in m3u8 to go through our proxy."""
    text = m3u8_content.decode("utf-8", errors="replace")
    lines = text.split("\n")
    rewritten = []
    for line in lines:
        line = line.rstrip("\r")
        if line.startswith("#") or not line.strip():
            rewritten.append(line)
            continue
        # This is a segment URL — make it absolute then proxy it
        if not line.startswith("http"):
            line = urljoin(base_url, line)
        rewritten.append(
            f"/tv-manage/api/videos/proxy?url={quote(line, safe='')}&headers={quote(headers_json, safe='')}"
        )
    return "\n".join(rewritten).encode("utf-8")


@app.get("/api/videos/proxy")
async def proxy_video(request: Request, url: str, headers: str = "{}"):
    url = _extract_real_url(url)
    hdrs = json.loads(headers)
    if "Range" in request.headers:
        hdrs["Range"] = request.headers["Range"]
    client = httpx.AsyncClient(follow_redirects=True, timeout=60.0)
    try:
        req = client.build_request("GET", url, headers=hdrs)
        resp = await client.send(req, stream=True)
    except httpx.ConnectError:
        await client.aclose()
        return StreamingResponse(
            iter([b"Connection failed"]),
            status_code=502,
            headers={"Content-Type": "text/plain", "Access-Control-Allow-Origin": "*"},
        )

    content_type = resp.headers.get("content-type", "")
    is_m3u8 = ".m3u8" in url or "mpegurl" in content_type
    if is_m3u8 and "mpegurl" not in content_type:
        content_type = "application/vnd.apple.mpegurl"
    elif not content_type:
        content_type = "video/mp4"

    headers_out = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
    }
    if is_m3u8 and resp.status_code == 200:
        body = await resp.aread()
        await resp.aclose()
        await client.aclose()
        if not body.lstrip().startswith(b"#EXTM3U"):
            return StreamingResponse(
                iter([json.dumps({"error": "link_expired", "message": "链接已过期，请从App重新播放获取新链接"}).encode()]),
                status_code=410,
                headers={**headers_out, "Content-Type": "application/json"},
            )
        rewritten = _rewrite_m3u8(url, headers, body)
        return StreamingResponse(
            iter([rewritten]),
            status_code=200,
            headers={**headers_out, "Content-Type": content_type},
        )

    headers_out["Content-Type"] = content_type
    for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
        if h in resp.headers:
            headers_out[h] = resp.headers[h]

    async def stream():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    return StreamingResponse(stream(), status_code=resp.status_code, headers=headers_out)


@app.get("/api/videos/{video_id}")
async def get_vid(video_id: int):
    return get_video(video_id)


@app.post("/api/videos")
async def upload_video(item: VideoUpload):
    return upsert_video(
        item.site_key, item.episode_url, item.vod_name, item.vod_pic,
        item.vod_year, item.vod_area, item.vod_director, item.vod_actor,
        item.vod_content, item.type_name, item.site_name, item.flag,
        item.episode_name, item.play_url, item.headers, item.device_name
    )


@app.delete("/api/videos/{video_id}")
async def remove_video(video_id: int):
    delete_video(video_id)
    return {"ok": True}


@app.post("/api/videos/batch-delete")
async def batch_remove_videos(item: BatchIds):
    delete_videos_batch(item.ids)
    return {"ok": True, "deleted": len(item.ids)}
