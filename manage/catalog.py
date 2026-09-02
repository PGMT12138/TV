"""CINE 片库（/cine）：豆瓣元数据抓取、SQLite 缓存与目录 API。

数据流：
- 榜单用 m.douban.com rexxar 的 subject_collection / recommend 接口抓取，全量落库（subjects/sections），
  请求永远先读缓存（stale-while-revalidate），豆瓣被反爬拦截时网站照常出缓存数据；
- 详情按需补全（cast/简介/片长），TMDB（可选，env TMDB_API_KEY）兜底补横版背景图；
- 搜索走 rexxar search/subjects，结果同样落库，让片库随使用不断长尾增长。
"""
import asyncio
import hashlib
import json
import os
import random
import re
import time
from datetime import datetime
from urllib.parse import quote

import httpx
from fastapi import APIRouter

from database import get_conn, init_db

router = APIRouter()

DOUBAN_BASE = "https://m.douban.com/rexxar/api/v2"
UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15 "
      "(KHTML, like Gecko) Version/16.6 Mobile/15E148 Safari/604.1")
DOUBAN_HEADERS = {
    "User-Agent": UA,
    "Referer": "https://m.douban.com/",
    "Accept": "application/json",
}
TMDB_KEY = os.environ.get("TMDB_API_KEY", "")
TMDB_PROXY = os.environ.get("TMDB_PROXY", "")
_TMDB_CONF = os.path.join(os.path.dirname(__file__), "data", "tmdb.json")


def _load_tmdb_conf():
    """env 优先，否则读 data/tmdb.json（gitignored）：{"api_key": "...", "proxy": "http://..."}。"""
    global TMDB_KEY, TMDB_PROXY
    if TMDB_KEY:
        return
    try:
        with open(_TMDB_CONF, encoding="utf-8") as f:
            conf = json.load(f)
        TMDB_KEY = conf.get("api_key", "")
        TMDB_PROXY = conf.get("proxy", "") or TMDB_PROXY
    except (OSError, ValueError):
        pass


_load_tmdb_conf()
TMDB_BASE = "https://api.themoviedb.org/3"
TMDB_IMG = "https://image.tmdb.org/t/p/w780"
STALE_AFTER = 12 * 3600  # 榜单缓存有效期

# 首页板块定义：recommend = (kind, sort, 排序名, 形式 tags)——热门板块与探索页「最热门」
# 同走 recommend?sort=U，保证两页片单一致；collection 为豆瓣榜单接口（仅新片速递保留）
SECTIONS = [
    {"key": "hot_tv", "title": "热门剧集", "recommend": ("tv", "U", "热门", ["电视剧"]), "limit": 40, "type": "series"},
    {"key": "hot_movie", "title": "热门电影", "recommend": ("movie", "U", "热门", []), "limit": 40, "type": "movie"},
    {"key": "hot_anime", "title": "热门动漫", "recommend": ("tv", "U", "热门", ["动漫"]), "limit": 30, "type": "anime"},
    {"key": "hot_show", "title": "热门综艺", "recommend": ("tv", "U", "热门", ["综艺"]), "limit": 30, "type": "series"},
    {"key": "hot_doc", "title": "热门纪录片", "recommend": ("tv", "U", "热门", ["纪录片"]), "limit": 20, "type": "doc"},
    {"key": "top_rated", "title": "高分经典", "recommend": ("movie", "S", "高分", []), "limit": 30, "type": "movie"},
    {"key": "new_movie", "title": "新片速递", "collection": "movie_latest", "limit": 30, "type": "movie"},
]

_refresh_lock = asyncio.Lock()
_refresh_task: asyncio.Task | None = None
_desc_tried: dict[str, float] = {}  # 简介补全尝试时间（进程内），避免对无简介影片反复回源
DESC_RETRY_AFTER = 24 * 3600


# ---------------- 豆瓣客户端 ----------------

# 全局串行 + 最小间隔限速：榜单/搜索/探索/详情补全所有豆瓣请求共用，
# 峰值 4 req/s，避免探索页连点筛选或并发扫描触发 IP 限流
_douban_lock = asyncio.Lock()
_douban_last = 0.0
DOUBAN_MIN_INTERVAL = 0.25


async def _douban_get(client: httpx.AsyncClient, path: str, params: dict) -> dict:
    global _douban_last
    async with _douban_lock:
        wait = _douban_last + DOUBAN_MIN_INTERVAL - time.monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _douban_last = time.monotonic()
        resp = await client.get(f"{DOUBAN_BASE}{path}", params=params, headers=DOUBAN_HEADERS)
    if resp.status_code != 200:
        raise RuntimeError(f"douban {resp.status_code}")
    return resp.json()


def _parse_subtitle(subtitle: str) -> dict:
    """card_subtitle 形如 '2025 / 美国 加拿大 / 剧情 爱情 / 导演 / 主演'（年份段可有可无）。"""
    parts = [p.strip() for p in (subtitle or "").split("/")]
    parts = [p for p in parts if p]
    year, countries, genres, director, actors = "", [], [], "", ""
    if parts and re.match(r"^(19|20)\d{2}", parts[0]):
        year = parts[0][:4]
        parts = parts[1:]
    if len(parts) >= 3:
        countries = parts[0].split()
        genres = parts[1].split()
        director = parts[2]
        actors = " ".join(parts[3:])
    elif len(parts) == 2:
        countries = parts[0].split()
        genres = parts[1].split()
    return {"year": year, "countries": countries, "genres": genres,
            "director": director, "actors": actors.split()}


def _map_type(item: dict, default: str) -> str:
    if item.get("type") == "movie":
        return "movie"
    genres = item.get("genres") or _parse_subtitle(item.get("card_subtitle", "")).get("genres", [])
    if any("动画" in g for g in genres):
        return "anime"
    if any("纪录" in g for g in genres):
        return "doc"
    return default


def subject_from_douban(item: dict, default_type: str = "movie") -> dict:
    """把豆瓣条目（榜单 subject / 搜索 target，两种字段风格都兼容）映射为 subjects 行。"""
    cover = ""
    if isinstance(item.get("cover"), dict):
        cover = item["cover"].get("url", "")
    cover = cover or item.get("cover_url") or ""
    if isinstance(item.get("pic"), dict):
        cover = cover or item["pic"].get("large") or item["pic"].get("normal", "")
    rating = item.get("rating") or {}
    sub = _parse_subtitle(item.get("card_subtitle", ""))
    year = item.get("year") or sub["year"] or ""
    try:
        year = int(re.match(r"^(19|20)\d{2}", str(year)).group()) if year else 0
    except (AttributeError, ValueError):
        year = 0
    genres = item.get("genres") or sub["genres"] or []
    actors = item.get("actors") or []
    if actors and isinstance(actors[0], str):
        actor_names = actors
    else:
        actor_names = [a.get("name", "") for a in actors if isinstance(a, dict)]
    if not actor_names:
        actor_names = sub["actors"]
    directors = item.get("directors") or []
    if directors and isinstance(directors[0], str):
        director = " / ".join(directors)
    elif directors:
        director = " / ".join(d.get("name", "") for d in directors if isinstance(d, dict))
    else:
        director = sub["director"]
    photos = [upgrade_douban_img(p) for p in (item.get("photos") or [])]
    return {
        "id": str(item.get("id", "")),
        "source": "douban",
        "type": _map_type(item, default_type),
        "title": item.get("title", ""),
        "original_title": "",
        "cover": upgrade_douban_img(cover),
        "backdrop": photos[0] if photos else "",
        "rating": float(rating.get("value") or 0),
        "year": year,
        "duration": "",
        "genres": genres,
        "region": (item.get("countries") or sub["countries"] or [""])[0],
        "description": "",
        "tagline": "",
        "director": director,
        "cast": [{"name": n, "role": "主演", "avatar": ""} for n in actor_names[:10]],
        "raw": item,
    }


def upsert_subject(s: dict):
    now = datetime.now().isoformat()
    conn = get_conn()
    conn.execute("""
        INSERT INTO subjects (id, source, type, title, original_title, cover, backdrop, rating,
            year, duration, genres, region, description, tagline, director, cast_json, raw_json, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            source=excluded.source, type=excluded.type, title=excluded.title,
            cover=CASE WHEN excluded.cover != '' THEN excluded.cover ELSE subjects.cover END,
            backdrop=CASE WHEN excluded.backdrop != '' THEN excluded.backdrop ELSE subjects.backdrop END,
            rating=CASE WHEN excluded.rating > 0 THEN excluded.rating ELSE subjects.rating END,
            year=CASE WHEN excluded.year > 0 THEN excluded.year ELSE subjects.year END,
            duration=CASE WHEN excluded.duration != '' THEN excluded.duration ELSE subjects.duration END,
            genres=CASE WHEN excluded.genres != '[]' THEN excluded.genres ELSE subjects.genres END,
            region=CASE WHEN excluded.region != '' THEN excluded.region ELSE subjects.region END,
            description=CASE WHEN excluded.description != '' THEN excluded.description ELSE subjects.description END,
            tagline=CASE WHEN excluded.tagline != '' THEN excluded.tagline ELSE subjects.tagline END,
            director=CASE WHEN excluded.director != '' THEN excluded.director ELSE subjects.director END,
            cast_json=CASE WHEN excluded.cast_json != '[]' THEN excluded.cast_json ELSE subjects.cast_json END,
            raw_json=excluded.raw_json, updated_at=excluded.updated_at
    """, (s["id"], s.get("source", "douban"), s["type"], s["title"], s.get("original_title", ""),
          s["cover"], s.get("backdrop", ""), s["rating"], s["year"], s.get("duration", ""),
          json.dumps(s["genres"], ensure_ascii=False), s["region"], s.get("description", ""),
          s.get("tagline", ""), s.get("director", ""), json.dumps(s.get("cast", []), ensure_ascii=False),
          json.dumps(s.get("raw", {}), ensure_ascii=False), now))
    conn.commit()
    conn.close()


def get_subject(subject_id: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT * FROM subjects WHERE id = ?", (subject_id,)).fetchone()
    conn.close()
    return dict(row) if row else None


def sections_age() -> float:
    """最近一次榜单刷新距今的秒数；从未刷新过返回无穷大。"""
    conn = get_conn()
    row = conn.execute("SELECT MAX(updated_at) AS t FROM sections").fetchone()
    conn.close()
    if not row or not row["t"]:
        return float("inf")
    try:
        return (datetime.now() - datetime.fromisoformat(row["t"])).total_seconds()
    except ValueError:
        return float("inf")


async def refresh_sections(force: bool = False) -> bool:
    """抓取全部榜单并落库。返回是否有更新（供调用方决定是否回退缓存）。"""
    if not force and sections_age() < STALE_AFTER:
        return False
    async with _refresh_lock:
        if not force and sections_age() < STALE_AFTER:  # 双检：并发请求只放一个进来刷新
            return False
        now = datetime.now().isoformat()
        ok_any = False
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            for sec in SECTIONS:
                try:
                    if "collection" in sec:
                        data = await _douban_get(client, f"/subject_collection/{sec['collection']}/items",
                                                 {"start": 0, "limit": sec["limit"]})
                        raw_items = data.get("subject_collection_items") or data.get("items") or []
                        items = [i.get("subject", i) for i in raw_items]
                    else:
                        kind, sort, sort_name, tags = sec["recommend"]
                        params = {"refresh": 0, "start": 0, "limit": sec["limit"], "sort": sort,
                                  "selected": f"全部类型/全部地区/全部年代/{sort_name}"}
                        if tags:
                            params["tags"] = ",".join(tags)
                        data = await _douban_get(client, f"/{kind}/recommend", params)
                        items = [i for i in data.get("items", []) if i.get("card") == "subject"]
                    ids = []
                    for item in items:
                        if not item.get("id") or not item.get("title"):
                            continue
                        s = subject_from_douban(item, sec["type"])
                        upsert_subject(s)
                        ids.append(s["id"])
                    conn = get_conn()
                    conn.execute("INSERT OR REPLACE INTO sections (key, title, updated_at) VALUES (?, ?, ?)",
                                 (sec["key"], sec["title"], now))
                    conn.execute("DELETE FROM section_items WHERE section_key = ?", (sec["key"],))
                    conn.executemany(
                        "INSERT OR IGNORE INTO section_items (section_key, subject_id, sort) VALUES (?, ?, ?)",
                        [(sec["key"], sid, idx) for idx, sid in enumerate(ids)])
                    conn.commit()
                    conn.close()
                    ok_any = ok_any or bool(ids)
                except Exception as e:
                    print(f"[catalog] refresh {sec['key']} failed: {e}", flush=True)
        return ok_any


def _schedule_refresh():
    global _refresh_task
    if _refresh_task is not None and not _refresh_task.done():
        return
    _refresh_task = asyncio.get_event_loop().create_task(_safe_refresh())


async def _safe_refresh():
    try:
        await refresh_sections(force=True)
    except Exception as e:
        print(f"[catalog] background refresh failed: {e}", flush=True)


async def start_refresh_loop():
    """启动时补一次过期刷新，然后每 12 小时循环。"""
    if sections_age() > STALE_AFTER:
        await _safe_refresh()
    while True:
        await asyncio.sleep(STALE_AFTER + random.uniform(0, 1800))
        await _safe_refresh()


# ---------------- 详情补全 ----------------

def _tmdb_client(timeout: float = 15.0) -> httpx.AsyncClient:
    # TMDB 国内直连不通，配置了代理则走代理
    return httpx.AsyncClient(timeout=timeout, proxy=TMDB_PROXY or None)


async def _tmdb_backdrop(title: str, year: int, is_tv: bool) -> str:
    if not TMDB_KEY:
        return ""
    try:
        async with _tmdb_client() as client:
            return await _tmdb_search_backdrop(client, title, year, is_tv)
    except Exception:
        return ""


async def _tmdb_search_backdrop(client: httpx.AsyncClient, title: str, year: int, is_tv: bool) -> str:
    kind = "tv" if is_tv else "movie"
    params = {"query": title, "language": "zh-CN", "api_key": TMDB_KEY}
    if year:
        params["year"] = year
    resp = await client.get(f"{TMDB_BASE}/search/{kind}", params=params)
    results = resp.json().get("results") or []
    # 年份过滤：优先取年份吻合的，避免同名片（如翻拍）串图
    for r in results:
        if r.get("backdrop_path") and (not year or str(year) in str(r.get("release_date") or r.get("first_air_date") or "")):
            return TMDB_IMG + r["backdrop_path"]
    for r in results:
        if r.get("backdrop_path"):
            return TMDB_IMG + r["backdrop_path"]
    return ""


async def enrich_subject(subject_id: str) -> dict | None:
    """豆瓣详情 + TMDB 背景图补全（只在缺字段时回源），更新并返回行。失败时静默返回现有行。"""
    try:
        return await _enrich_inner(subject_id)
    except Exception as e:
        print(f"[catalog] enrich {subject_id} failed: {e}", flush=True)
        return get_subject(subject_id)


async def _enrich_inner(subject_id: str) -> dict | None:
    row = get_subject(subject_id)
    if row is None:
        return None
    has_detail = bool(row["cast_json"] not in ("[]", "") and row["description"] and row["duration"])
    need_backdrop = not row["backdrop"]
    if row["source"] == "douban" and (not has_detail or need_backdrop):
        kind = "movie" if row["type"] == "movie" else "tv"
        async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
            data = await _douban_get(client, f"/{kind}/{subject_id}", {})
            s = subject_from_douban({**data, "card_subtitle": data.get("card_subtitle", "")},
                                    row["type"])
            patch = {
                "original_title": data.get("original_title", "") or "",
                "description": (data.get("intro") or "")[:600],
                "duration": (data.get("durations") or [""])[0],
                "tagline": (data.get("card_subtitle") or "").split("/")[-1].strip(),
            }
            if data.get("episodes_count"):
                patch["duration"] = f"共 {data['episodes_count']} 集"
            elif data.get("is_tv") and data.get("last_episode_number"):
                patch["duration"] = f"更新至 {data['last_episode_number']} 集"
            elif row["type"] != "movie" and patch["duration"].endswith("分钟"):
                patch["duration"] = patch["duration"] + " / 集"
            if not row["cover"]:
                patch["cover"] = s["cover"]
            backdrop = row["backdrop"]
            if not backdrop:
                backdrop = await _tmdb_backdrop(row["title"], row["year"], kind == "tv")
            now = datetime.now().isoformat()
            conn = get_conn()
            conn.execute("""UPDATE subjects SET original_title = CASE WHEN ? != '' THEN ? ELSE original_title END,
                description = CASE WHEN ? != '' THEN ? ELSE description END,
                duration = CASE WHEN ? != '' THEN ? ELSE duration END,
                tagline = CASE WHEN ? != '' THEN ? ELSE tagline END,
                backdrop = CASE WHEN ? != '' THEN ? ELSE backdrop END,
                cast_json = CASE WHEN ? != '[]' THEN ? ELSE cast_json END,
                director = CASE WHEN ? != '' THEN ? ELSE director END,
                updated_at = ? WHERE id = ?""",
                         (patch["original_title"], patch["original_title"],
                          patch["description"], patch["description"],
                          patch["duration"], patch["duration"],
                          patch["tagline"], patch["tagline"],
                          backdrop, backdrop,
                          json.dumps(s["cast"], ensure_ascii=False), json.dumps(s["cast"], ensure_ascii=False),
                          s["director"], s["director"], now, subject_id))
            conn.commit()
            conn.close()
            row = get_subject(subject_id)
    return row


# ---------------- 对外 JSON（前端 MovieItem 契约） ----------------

def _quality(rating: float) -> str:
    if rating >= 8.5:
        return "4K HDR"
    if rating >= 7:
        return "Dolby Vision"
    return "1080P Ultra"


def _accent(subject_id: str) -> str:
    colors = ("emerald", "indigo", "purple", "cyan", "amber", "rose")
    return colors[int(hashlib.md5(subject_id.encode()).hexdigest(), 16) % len(colors)]


def upgrade_douban_img(url: str) -> str:
    """豆瓣移动端接口的图片 URL 带 imageView2 缩略参数（如 h/120 → 120px 小图），
    改写 h 为 9999 取原图；CDN 要求保留参数，直接删参会返回空响应。"""
    if not url or "imageView2" not in url:
        return url
    return re.sub(r"/h/\d+/", "/h/9999/", url)


def _proxy_img(url: str) -> str:
    """外链图片统一走服务端 /api/img 透传：豆瓣无 Referer 会 418，TMDB 国内被墙，资源站各有防盗链。"""
    if url and url.startswith("http"):
        return f"/api/img?url={quote(url, safe='')}"
    return url or ""


def row_to_item(row: dict, ranking: int | None = None, featured: bool = False, trending: bool = False) -> dict:
    try:
        cast = json.loads(row["cast_json"] or "[]")
    except (ValueError, TypeError):
        cast = []
    try:
        genres = json.loads(row["genres"] or "[]")
    except (ValueError, TypeError):
        genres = []
    item = {
        "id": row["id"],
        "title": row["title"],
        "originalTitle": row["original_title"] or "",
        "type": row["type"],
        "cover": _proxy_img(row["cover"]),
        "backdrop": _proxy_img(row["backdrop"]) or _proxy_img(row["cover"]),
        "rating": row["rating"] or 0,
        "year": row["year"] or 0,
        "duration": row["duration"] or ("电影" if row["type"] == "movie" else "剧集"),
        "genres": genres,
        "region": row["region"] or "其他",
        "quality": _quality(row["rating"] or 0),
        "tagline": row["tagline"] or "",
        "description": row["description"] or "",
        "director": row["director"] or "未知",
        "cast": cast,
        "episodes": [],
        "trailerVideoUrl": "",
        "accentColor": _accent(row["id"]),
        "isFeatured": featured,
        "isTrending": trending,
        "ranking": ranking if ranking is not None else 99,
        "source": row["source"],
    }
    if row["source"] == "resource":
        # 资源型影片带上站点 key/id，前端进入详情时精确锁定来源
        try:
            item["raw"] = json.loads(row["raw_json"] or "{}")
        except (ValueError, TypeError):
            item["raw"] = {}
    return item


# ---------------- 路由 ----------------

@router.get("/api/catalog/all")
async def catalog_all():
    """全量片库。首次为空库时同步刷一次榜单（约 10s），之后 stale 数据直接返回并后台刷新。"""
    conn = get_conn()
    count = conn.execute("SELECT COUNT(*) AS c FROM section_items").fetchone()["c"]
    conn.close()
    if count == 0:
        await refresh_sections(force=True)
    elif sections_age() > STALE_AFTER:
        _schedule_refresh()

    conn = get_conn()
    rows = {r["id"]: dict(r) for r in conn.execute(
        """SELECT s.* FROM subjects s JOIN section_items si ON si.subject_id = s.id
           GROUP BY s.id""").fetchall()}
    ordered_ids: list[str] = []
    sec_map: dict[str, list[str]] = {}
    section_meta: list[dict] = []
    for sec in SECTIONS:
        sec_ids = [r["subject_id"] for r in conn.execute(
            "SELECT subject_id FROM section_items WHERE section_key = ? ORDER BY sort",
            (sec["key"],)).fetchall()]
        sec_map[sec["key"]] = sec_ids
        if sec_ids:
            section_meta.append({"key": sec["key"], "title": sec["title"], "ids": sec_ids})
        for sid in sec_ids:
            if sid not in ordered_ids:
                ordered_ids.append(sid)
    conn.close()

    # 轮播位：热门电影/剧集/综艺/动漫各取头部 2 部（8 帧类型多样）；
    # 热门位（trending 兜底池）由电影+剧集榜单按原顺序补足
    featured: list[str] = []
    for key in ("hot_movie", "hot_tv", "hot_show", "hot_anime"):
        for sid in sec_map.get(key, [])[:2]:
            if sid not in featured:
                featured.append(sid)
    seen = set(featured)
    hot: list[str] = list(featured)
    for sid in sec_map.get("hot_movie", []) + sec_map.get("hot_tv", []):
        if sid not in seen:
            seen.add(sid)
            hot.append(sid)

    # 轮播位影片保证有简介：幻灯片切换时每部都要能展示剧情（缺的同步补全，热门位其余后台补）
    await _ensure_hero_desc(rows, hot)

    items = [row_to_item(rows[sid], ranking=idx) for idx, sid in enumerate(ordered_ids) if sid in rows]
    featured_set = set(featured)
    for it in items:
        if it["id"] in featured_set:
            it["isFeatured"] = True
        if it["id"] in hot[:24]:
            it["isTrending"] = True
    return {"list": items, "sections": section_meta,
            "updatedAt": datetime.now().isoformat(timespec="seconds")}


async def _ensure_hero_desc(rows: dict, hot: list[str]):
    now = datetime.now().timestamp()
    missing = [sid for sid in hot[:24]
               if sid in rows and not rows[sid]["description"]
               and now - _desc_tried.get(sid, 0) > DESC_RETRY_AFTER]
    if not missing:
        return
    sem = asyncio.Semaphore(2)  # 豆瓣详情接口有 IP 限流（1309），收敛并发与频率

    async def one(sid: str) -> bool:
        async with sem:
            try:
                await _enrich_inner(sid)
                await asyncio.sleep(random.uniform(0.5, 1.0))
                _desc_tried[sid] = now  # 尝试成功（含确实无简介的未上映片）：24h 内不再回源
                return True
            except Exception:
                return False

    # 前 8 部（幻灯片位）本次请求内补完，其余排后台
    results = await asyncio.gather(*[one(sid) for sid in missing[:8]])
    for sid, ok in zip(missing[:8], results):
        if not ok:
            # 被限流等失败：10 分钟后即可重试（而不是等 24h）
            _desc_tried[sid] = now - DESC_RETRY_AFTER + 600
    if len(missing) > 8:
        for sid in missing[8:]:
            asyncio.get_event_loop().create_task(one(sid))
    conn = get_conn()
    for sid in missing[:8]:
        row = conn.execute("SELECT * FROM subjects WHERE id = ?", (sid,)).fetchone()
        if row is not None:
            rows[sid] = dict(row)
    conn.close()


@router.get("/api/catalog/detail")
async def catalog_detail(id: str):
    row = await enrich_subject(id)
    if row is None:
        return {"error": "影片不存在"}
    return row_to_item(row)


@router.get("/api/catalog/search")
async def catalog_search(wd: str):
    """豆瓣搜索建议（电影+剧集合并），结果落库供片库长尾检索。"""
    out = []
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for kind in ("movie", "tv"):
            try:
                data = await _douban_get(client, "/search/subjects",
                                         {"q": wd, "type": kind, "count": 20})
                for wrap in (data.get("subjects") or {}).get("items", []):
                    target = wrap.get("target") or {}
                    if not target.get("id"):
                        continue
                    s = subject_from_douban({**target, "year": target.get("year", "")}, "series")
                    s["type"] = _map_type({"type": kind,
                                           "genres": _parse_subtitle(target.get("card_subtitle", "")).get("genres", [])},
                                          "series" if kind == "tv" else "movie")
                    upsert_subject(s)
                    out.append(row_to_item(get_subject(s["id"]) or s))
            except Exception as e:
                print(f"[catalog] search {kind} failed: {e}", flush=True)
    seen, unique = set(), []
    for it in out:
        if it["id"] not in seen:
            seen.add(it["id"])
            unique.append(it)
    return {"list": unique[:24]}


@router.post("/api/catalog/refresh")
async def catalog_refresh():
    ok = await refresh_sections(force=True)
    return {"ok": ok, "age": sections_age()}


# ---------------- 探索页：豆瓣「选电影」recommend 直连（全库浏览） ----------------

# 前端媒体类型 → (douban kind, 形式 tag)；实测 U=热门(选电影/选剧集页的"热门") R=最新 S=高分，
# T=零散新片(含未上映,不可用)；精确年份（2023-2026）与「2010年代」可直接作 tag，仅 2020-2022/经典老片需后置过滤
EXPLORE_TYPE_MAP = {
    "movie": ("movie", ""),
    "series": ("tv", "电视剧"),
    "anime": ("tv", "动漫"),
    "doc": ("tv", "纪录片"),
    "variety": ("tv", "综艺"),
}
EXPLORE_SORT_MAP = {"trending": "U", "rating": "S", "newest": "R"}
EXPLORE_PAGE = 24          # 单次返回目标条数（all 模式两条流各 12）
EXPLORE_SCAN_PAGES = 8     # 后置过滤时最多向后扫的豆瓣页数（160 条原始数据）
EXPLORE_CACHE_TTL = 3600
_explore_cache: dict[str, tuple[float, dict]] = {}
_explore_order: list[str] = []


def _year_filter(year: str):
    """把前端年代选项转成豆瓣 tag 与后置年份过滤；None 表示无需过滤。"""
    if not year or year == "全部":
        return "", None
    if year == "2010-2019":
        return "2010年代", None
    if year == "2020-2022":
        return "2020年代", (2020, 2022)
    if year == "经典老片":
        return "", (1900, 2009)
    return year, None  # 2023/2024/2025/2026：豆瓣支持精确年份 tag


async def _explore_stream(client: httpx.AsyncClient, kind: str, tags: list[str],
                          sort_code: str, start: int, year_range: tuple | None, target: int):
    """从豆瓣拉一页（后置过滤时向后扫描直到攒够 target 或扫尽）。
    返回 (原始条目列表, 下一个 raw start, 是否扫尽)。"""
    out, seen, cursor, exhausted = [], set(), start, False
    for _ in range(EXPLORE_SCAN_PAGES):
        if len(out) >= target:
            break
        try:
            data = await _douban_get(client, f"/{kind}/recommend",
                                     {"refresh": 0, "start": cursor, "limit": 20,
                                      "sort": sort_code, "tags": ",".join(tags)})
        except Exception as e:
            print(f"[catalog] explore {kind} failed: {e}", flush=True)
            exhausted = True
            break
        items = data.get("items") or []
        if len(items) < 20:
            exhausted = True
        for it in items:
            sid = str(it.get("id", ""))
            if not sid or sid in seen:
                continue
            seen.add(sid)
            if year_range is not None:
                m = re.match(r"^(19|20)\d{2}", str(it.get("year") or ""))
                y = int(m.group()) if m else 0
                if not (year_range[0] <= y <= year_range[1]):
                    continue
            out.append(it)
        cursor += len(items)
        if exhausted:
            break
    return out, cursor, exhausted


@router.get("/api/catalog/explore")
async def catalog_explore(type: str = "all", genre: str = "", region: str = "",
                          year: str = "", sort: str = "trending", cursor: str = ""):
    """探索页全库浏览：筛选映射为豆瓣 recommend 的 tags+sort，结果落库。
    cursor 为不透明游标（"movieStart:tvStart"），前端原样传回翻页。"""
    ftype = type if type in EXPLORE_TYPE_MAP else "all"
    genre = "" if genre == "全部" else genre
    region = "" if region in ("", "全部", "其他") else region  # 其他=非豆瓣标准地区，无法取反
    year_tag, year_range = _year_filter(year)
    sort_code = EXPLORE_SORT_MAP.get(sort, "R")

    cache_key = json.dumps([ftype, genre, region, year, sort, cursor], ensure_ascii=False)
    now = time.time()
    hit = _explore_cache.get(cache_key)
    if hit and now - hit[0] < EXPLORE_CACHE_TTL:
        return hit[1]

    # all 模式跑 movie+tv 两条流交替合并；单类型跑一条
    streams = []
    if ftype == "all":
        starts = cursor.split(":")
        m_start = int(starts[0]) if len(starts) > 0 and starts[0].isdigit() else 0
        t_start = int(starts[1]) if len(starts) > 1 and starts[1].isdigit() else 0
        streams = [("movie", "", m_start), ("tv", "", t_start)]
        per_target = EXPLORE_PAGE // 2
    else:
        kind, form = EXPLORE_TYPE_MAP[ftype]
        s0 = int(cursor.split(":")[0]) if cursor.split(":")[0].isdigit() else 0
        streams = [(kind, form, s0)]
        per_target = EXPLORE_PAGE

    out_items, next_starts, all_done = [], [], True
    stream_items: list[list] = []
    async with httpx.AsyncClient(timeout=15.0, follow_redirects=True) as client:
        for kind, form, start in streams:
            tags = [t for t in (form, genre, region, year_tag) if t]
            items, nstart, exhausted = await _explore_stream(
                client, kind, tags, sort_code, start, year_range, per_target)
            default_type = "movie" if kind == "movie" else "series"
            processed = []
            for it in items:
                s = subject_from_douban(it, default_type)
                if ftype in ("anime", "doc"):
                    s["type"] = ftype
                elif ftype == "variety":
                    s["type"] = "series"  # 前端 typeLabel 按综艺题材显示角标
                upsert_subject(s)
                processed.append(row_to_item(get_subject(s["id"]) or s))
            stream_items.append(processed)
            next_starts.append(nstart)
            all_done = all_done and exhausted

    # 多条流轮转交错（保持各流服务端顺序），单流原序
    if len(stream_items) == 2:
        for i in range(max(len(stream_items[0]), len(stream_items[1]))):
            for lst in stream_items:
                if i < len(lst):
                    out_items.append(lst[i])
    elif stream_items:
        out_items = stream_items[0]

    seen, unique = set(), []
    for it in out_items:
        if it["id"] not in seen:
            seen.add(it["id"])
            unique.append(it)

    resp = {"list": unique, "cursor": ":".join(str(s) for s in next_starts), "done": all_done}
    _explore_cache[cache_key] = (now, resp)
    _explore_order.append(cache_key)
    if len(_explore_order) > 300:
        for k in _explore_order[:-300]:
            _explore_cache.pop(k, None)
        del _explore_order[:-300]
    return resp


@router.post("/api/catalog/backfill")
async def catalog_backfill(limit: int = 60, desc: bool = False):
    """补全缓存：desc=true 批量拉豆瓣详情补简介/片长/演职员；默认只补 TMDB 背景图。"""
    conn = get_conn()
    if desc:
        rows = conn.execute(
            "SELECT id FROM subjects WHERE source = 'douban' AND description = '' LIMIT ?",
            (limit,)).fetchall()
        conn.close()
        if not rows:
            return {"ok": True, "enriched": 0, "total": 0}
        sem = asyncio.Semaphore(3)  # 详情接口逐部请求，限速防触发豆瓣风控

        async def one(row: dict):
            async with sem:
                await enrich_subject(row["id"])
                await asyncio.sleep(random.uniform(0.2, 0.6))

        await asyncio.gather(*[one(dict(r)) for r in rows])
        conn = get_conn()
        enriched = conn.execute(
            "SELECT COUNT(*) AS c FROM subjects WHERE source = 'douban' AND description != ''").fetchone()["c"]
        conn.close()
        return {"ok": True, "enriched": enriched, "total": len(rows)}

    rows = conn.execute("""
        SELECT DISTINCT s.id, s.title, s.year, s.type FROM subjects s
        LEFT JOIN section_items si ON si.subject_id = s.id
        WHERE s.source = 'douban' AND (s.backdrop = '' OR s.backdrop = s.cover)
        ORDER BY (si.sort IS NULL), si.sort LIMIT ?
    """, (limit,)).fetchall()
    conn.close()
    if not rows:
        return {"ok": True, "updated": 0, "tmdb": bool(TMDB_KEY)}
    sem = asyncio.Semaphore(4)
    updated = 0

    async def one(row: dict):
        nonlocal updated
        async with sem:
            url = await _tmdb_backdrop(row["title"], row["year"] or 0, row["type"] != "movie")
            if not url:
                return
            conn = get_conn()
            conn.execute("UPDATE subjects SET backdrop = ?, updated_at = ? WHERE id = ? AND backdrop = ''",
                         (url, datetime.now().isoformat(), row["id"]))
            conn.commit()
            conn.close()
            updated += 1

    await asyncio.gather(*[one(dict(r)) for r in rows])
    return {"ok": True, "updated": updated, "total": len(rows), "tmdb": bool(TMDB_KEY)}


@router.get("/api/catalog/status")
async def catalog_status():
    conn = get_conn()
    subjects = conn.execute("SELECT COUNT(*) AS c FROM subjects").fetchone()["c"]
    sections = conn.execute("SELECT key, title, updated_at FROM sections ORDER BY updated_at DESC").fetchall()
    conn.close()
    return {"subjects": subjects, "sections": [dict(r) for r in sections],
            "tmdb": bool(TMDB_KEY)}
