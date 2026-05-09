import os
import json
import httpx
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from database import (init_db, get_urls, get_all_urls, add_url, update_url, delete_url,
                      upsert_home_content, get_home_contents, get_home_content, delete_home_content,
                      upsert_video, get_videos, get_video, delete_video)

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


class HomeContentUpload(BaseModel):
    site_key: str
    site_name: str = ""
    config_name: str = ""
    content: str


@app.get("/api/home-contents")
async def list_home_contents():
    return {"items": get_home_contents()}


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


@app.get("/api/videos/proxy")
async def proxy_video(request: Request, url: str, headers: str = "{}"):
    hdrs = json.loads(headers)
    if "Range" in request.headers:
        hdrs["Range"] = request.headers["Range"]
    client = httpx.AsyncClient(follow_redirects=True, timeout=60.0, http2=True)
    req = client.build_request("GET", url, headers=hdrs)
    resp = await client.send(req, stream=True)

    content_type = resp.headers.get("content-type", "")
    if ".m3u8" in url and "mpegurl" not in content_type:
        content_type = "application/vnd.apple.mpegurl"
    elif not content_type:
        content_type = "video/mp4"

    async def stream():
        try:
            async for chunk in resp.aiter_bytes(chunk_size=65536):
                yield chunk
        finally:
            await resp.aclose()
            await client.aclose()

    headers_out = {
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-cache",
        "Content-Type": content_type,
    }
    for h in ("Content-Length", "Content-Range", "Accept-Ranges"):
        if h in resp.headers:
            headers_out[h] = resp.headers[h]

    return StreamingResponse(stream(), status_code=resp.status_code, headers=headers_out)
