import os
from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from pydantic import BaseModel
from database import init_db, get_urls, get_all_urls, add_url, update_url, delete_url, upsert_home_content, get_home_contents, get_home_content, delete_home_content

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
