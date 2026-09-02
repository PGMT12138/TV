"""CINE 用户体系与播放资源（/cine）。

- 用户：用户名+密码注册登录，pbkdf2 存储，HttpOnly Cookie 会话（30 天）；
- 收藏/观看历史：SQLite 落库，按 subject_id 关联 catalog.subjects 统一注册表；
- 播放资源：经 bridge WebSocket 并发搜索设备上的多站点源，片名归一化匹配打分；
- /api/img：外链图片透传 + 磁盘缓存（豆瓣需伪装 Referer 且并发过高会触发反爬挑战，故限流并校验响应为真实图片）。
"""
import asyncio
import base64
import hashlib
import json
import os
import re
import secrets
import time
from datetime import datetime, timedelta
from urllib.parse import quote

import httpx
from fastapi import APIRouter, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel

from database import get_conn
import database
from bridge import active_device, call_device
from catalog import upsert_subject, get_subject, row_to_item, TMDB_PROXY, upgrade_douban_img
from probe import start_scan, get_scan
from liveprobe import (start_live_scan as liveprobe_start_scan, get_live_scan,
                       get_live_probe_results, clean_live_probe, cancel_live_scan, plan_channels, LIVE_PROBE_TTL)

router = APIRouter()

COOKIE_NAME = "cine_token"
SESSION_DAYS = 30
PBKDF2_ITERS = 120_000
SITES_TTL = 600  # 站点列表缓存 10 分钟
SEARCH_TIMEOUT = 20.0
SEARCH_CONCURRENCY = 6
SEARCH_CACHE_TTL = 6 * 3600  # 聚合搜索命中缓存 6 小时，过期后前台重新实时搜索
SEARCH_RECHECK = 3600        # 缓存命中超过 1 小时未校验时，先回缓存、后台重搜比对（SWR）

_sites_cache = {"t": 0.0, "device": "", "sites": []}


def clear_sites_cache():
    """来源设备切换后调用，让站点列表重新从新设备拉取。"""
    _sites_cache.update({"t": 0.0, "device": "", "sites": []})


# ---------------- 会话与用户 ----------------

def _hash_password(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt), PBKDF2_ITERS).hex()


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _issue_session(user_id: int, response: Response) -> str:
    token = secrets.token_urlsafe(32)
    expires = time.time() + SESSION_DAYS * 86400
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)",
                 (_hash_token(token), user_id, expires))
    conn.commit()
    conn.close()
    response.set_cookie(COOKIE_NAME, token, max_age=SESSION_DAYS * 86400,
                        httponly=True, samesite="lax", path="/")
    return token


def _current_user(request: Request) -> dict | None:
    token = request.cookies.get(COOKIE_NAME, "")
    if not token:
        return None
    conn = get_conn()
    row = conn.execute("""
        SELECT u.id, u.username, u.created_at FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.expires_at > ?
    """, (_hash_token(token), time.time())).fetchone()
    conn.close()
    return dict(row) if row else None


def _user_profile(user: dict) -> dict:
    conn = get_conn()
    row = conn.execute("SELECT COALESCE(SUM(watched_seconds), 0) AS s FROM history WHERE user_id = ?",
                       (user["id"],)).fetchone()
    conn.close()
    hours = round((row["s"] or 0) / 3600, 1)
    return {"id": str(user["id"]), "name": user["username"],
            "watchTimeHours": hours,
            "joinedDate": (user["created_at"] or "")[:10]}


def _auth_error():
    return JSONResponse({"error": "未登录或会话已过期"}, status_code=401)


class AuthBody(BaseModel):
    username: str
    password: str


@router.post("/api/auth/register")
async def auth_register(body: AuthBody, response: Response):
    username = body.username.strip()
    if not re.match(r"^[\w\u4e00-\u9fa5]{2,24}$", username):
        return {"error": "用户名需为 2-24 位字母、数字、下划线或中文"}
    if len(body.password) < 6:
        return {"error": "密码长度至少 6 位"}
    conn = get_conn()
    if conn.execute("SELECT 1 FROM users WHERE username = ?", (username,)).fetchone():
        conn.close()
        return {"error": "用户名已被注册"}
    salt = secrets.token_hex(16)
    now = datetime.now().isoformat()
    cursor = conn.execute(
        "INSERT INTO users (username, password_hash, salt, created_at) VALUES (?, ?, ?, ?)",
        (username, _hash_password(body.password, salt), salt, now))
    user = {"id": cursor.lastrowid, "username": username, "created_at": now}
    conn.commit()
    conn.close()
    _issue_session(user["id"], response)
    return {"ok": True, "user": _user_profile(user)}


@router.post("/api/auth/login")
async def auth_login(body: AuthBody, response: Response):
    conn = get_conn()
    row = conn.execute("SELECT id, username, password_hash, salt, created_at FROM users WHERE username = ?",
                       (body.username.strip(),)).fetchone()
    conn.close()
    if row is None or _hash_password(body.password, row["salt"]) != row["password_hash"]:
        return {"error": "用户名或密码错误"}
    user = dict(row)
    _issue_session(user["id"], response)
    return {"ok": True, "user": _user_profile(user)}


@router.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    token = request.cookies.get(COOKIE_NAME, "")
    if token:
        conn = get_conn()
        conn.execute("DELETE FROM sessions WHERE token_hash = ?", (_hash_token(token),))
        conn.commit()
        conn.close()
    response.delete_cookie(COOKIE_NAME, path="/")
    return {"ok": True}


@router.get("/api/auth/me")
async def auth_me(request: Request):
    user = _current_user(request)
    if user is None:
        return JSONResponse({"user": None}, status_code=200)
    return {"user": _user_profile(user)}


# ---------------- 收藏 ----------------

def _require(request: Request) -> dict | None:
    return _current_user(request)


@router.get("/api/user/favorites")
async def favorites_list(request: Request):
    user = _require(request)
    if user is None:
        return _auth_error()
    conn = get_conn()
    rows = conn.execute("""
        SELECT s.* FROM favorites f LEFT JOIN subjects s ON s.id = f.subject_id
        WHERE f.user_id = ? ORDER BY f.created_at DESC
    """, (user["id"],)).fetchall()
    conn.close()
    items = []
    for row in rows:
        if row["id"] is None:
            continue
        items.append(row_to_item(dict(row)))
    return {"list": items}


class MovieBody(BaseModel):
    id: str
    title: str = ""
    cover: str = ""
    rating: float = 0
    year: int = 0
    type: str = "movie"


@router.post("/api/user/favorites/toggle")
async def favorites_toggle(request: Request, body: MovieBody):
    user = _require(request)
    if user is None:
        return _auth_error()
    # 兜底：收藏的影片可能还不在 subjects（比如搜索建议直接收藏），先注册
    if get_subject(body.id) is None:
        upsert_subject({"id": body.id, "source": "douban", "type": body.type, "title": body.title,
                        "original_title": "", "cover": body.cover, "backdrop": "", "rating": body.rating,
                        "year": body.year, "duration": "", "genres": [], "region": "",
                        "description": "", "tagline": "", "director": "", "cast": [], "raw": {}})
    conn = get_conn()
    existing = conn.execute("SELECT 1 FROM favorites WHERE user_id = ? AND subject_id = ?",
                            (user["id"], body.id)).fetchone()
    if existing:
        conn.execute("DELETE FROM favorites WHERE user_id = ? AND subject_id = ?", (user["id"], body.id))
        favorited = False
    else:
        conn.execute("""INSERT OR IGNORE INTO favorites (user_id, subject_id, title, cover, rating, year, type, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                     (user["id"], body.id, body.title, body.cover, body.rating, body.year, body.type,
                      datetime.now().isoformat()))
        favorited = True
    count = conn.execute("SELECT COUNT(*) AS c FROM favorites WHERE user_id = ?", (user["id"],)).fetchone()["c"]
    conn.commit()
    conn.close()
    return {"ok": True, "favorited": favorited, "count": count}


# ---------------- 观看历史 ----------------

def _img_via_proxy(url: str) -> str:
    """历史里存的原始图片 URL 输出时统一走 /api/img 代理。"""
    if url and url.startswith("http"):
        from urllib.parse import quote as _quote
        return f"/api/img?url={_quote(url, safe='')}"
    return url or ""


@router.get("/api/user/history")
async def history_list(request: Request):
    user = _require(request)
    if user is None:
        return _auth_error()
    conn = get_conn()
    rows = conn.execute("SELECT * FROM history WHERE user_id = ? ORDER BY updated_at DESC",
                        (user["id"],)).fetchall()
    conn.close()
    items = []
    for r in rows:
        total = float(r["total_seconds"] or 0)
        watched = float(r["watched_seconds"] or 0)
        try:
            ts = datetime.fromisoformat(r["updated_at"]).timestamp() * 1000
        except (ValueError, TypeError):
            ts = 0
        items.append({
            "id": str(r["id"]),
            "movieId": r["subject_id"],
            "episodeId": r["episode_id"],
            "episodeNumber": r["episode_number"] or 1,
            "episodeTitle": r["episode_title"] or "正片",
            "movieTitle": r["title"],
            "cover": _img_via_proxy(r["cover"]),
            "backdrop": _img_via_proxy(r["backdrop"]),
            "watchedSeconds": watched,
            "totalSeconds": total,
            "progressPercent": min(100, round(watched / total * 100)) if total > 0 else 0,
            "lastWatchedAt": ts,
            "siteKey": r["site_key"] or "",
            "flag": r["flag"] or "",
        })
    return {"list": items}


class HistoryBody(BaseModel):
    movieId: str
    movieTitle: str = ""
    cover: str = ""
    backdrop: str = ""
    episodeId: str = ""
    episodeTitle: str = ""
    episodeNumber: int = 1
    watchedSeconds: float = 0
    totalSeconds: float = 0
    siteKey: str = ""   # 最后选择的来源站点（重新进入时优先恢复）
    flag: str = ""      # 最后选择的线路


@router.post("/api/user/history")
async def history_upsert(request: Request, body: HistoryBody):
    user = _require(request)
    if user is None:
        return _auth_error()
    conn = get_conn()
    now = datetime.now().isoformat()
    conn.execute("""
        INSERT INTO history (user_id, subject_id, title, cover, backdrop, episode_id, episode_title,
            episode_number, watched_seconds, total_seconds, site_key, flag, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, subject_id) DO UPDATE SET
            title=excluded.title, cover=excluded.cover, backdrop=excluded.backdrop,
            episode_id=excluded.episode_id, episode_title=excluded.episode_title,
            episode_number=excluded.episode_number, watched_seconds=excluded.watched_seconds,
            total_seconds=excluded.total_seconds, site_key=excluded.site_key, flag=excluded.flag,
            updated_at=excluded.updated_at
    """, (user["id"], body.movieId, body.movieTitle, body.cover, body.backdrop, body.episodeId,
          body.episodeTitle, body.episodeNumber, body.watchedSeconds, body.totalSeconds,
          body.siteKey, body.flag, now))
    conn.commit()
    conn.close()
    return {"ok": True}


@router.delete("/api/user/history/{subject_id}")
async def history_delete(request: Request, subject_id: str):
    user = _require(request)
    if user is None:
        return _auth_error()
    conn = get_conn()
    if subject_id == "all":
        conn.execute("DELETE FROM history WHERE user_id = ?", (user["id"],))
    else:
        # 按影片（subject_id）删；subject_id 也可能是旧数据的数字行 id，双兼容
        conn.execute("DELETE FROM history WHERE user_id = ? AND (subject_id = ? OR id = ?)",
                     (user["id"], subject_id, subject_id if subject_id.isdigit() else -1))
    conn.commit()
    conn.close()
    return {"ok": True}


# ---------------- 播放资源（设备站点聚合搜索） ----------------

def _norm(name: str) -> str:
    """片名归一化：去空白/标点，全角转半角，小写。"""
    name = name.lower()
    name = re.sub(r"[\s\u3000·，。！？：；、''\"\"（）()\[\]【】\-_—….,!?:;~～]", "", name)
    return re.sub(r"[^\w\u4e00-\u9fa5]", "", name)


def _match_score(query: str, title: str) -> int:
    q, t = _norm(query), _norm(title)
    if not q or not t:
        return 0
    if q == t:
        return 100
    if t.startswith(q):
        return 85
    if q in t:
        return 65
    return 0


async def _searchable_sites() -> list[dict]:
    """当前来源设备的可搜索站点（未过滤管理端禁用项），按设备缓存。"""
    dev = active_device()
    device_id = dev.id if dev is not None else ""
    if time.time() - _sites_cache["t"] < SITES_TTL and _sites_cache["device"] == device_id and _sites_cache["sites"]:
        return _sites_cache["sites"]
    try:
        data = await call_device("sites", {}, timeout=15.0)
        sites = [s for s in (data.get("sites") or []) if s.get("searchable", True)]
        _sites_cache.update({"t": time.time(), "device": device_id, "sites": sites})
    except RuntimeError:
        raise
    except Exception as e:
        raise RuntimeError(str(e)) from e
    return _sites_cache["sites"]


async def _search_one(site: dict, wd: str, sem: asyncio.Semaphore) -> list[dict]:
    async with sem:
        try:
            data = await call_device("search", {"key": site.get("key", ""), "wd": wd},
                                     timeout=SEARCH_TIMEOUT)
            return data.get("list") or []
        except Exception:
            return []


async def _do_live_search(wd: str) -> dict:
    """实时聚合搜索（原 resource_search 主体）。"""
    sites = await _searchable_sites()
    database.record_search_sites(sites)
    disabled = database.get_disabled_site_keys()
    sites = [s for s in sites if s.get("key", "") not in disabled]
    sem = asyncio.Semaphore(SEARCH_CONCURRENCY)
    results = await asyncio.gather(*[_search_one(s, wd, sem) for s in sites])
    matched = []
    for site, vods in zip(sites, results):
        for vod in vods:
            score = _match_score(wd, vod.get("name", ""))
            if score <= 0:
                continue
            matched.append({
                "title": vod.get("name", ""),
                "siteKey": site.get("key", ""),
                "siteName": site.get("name", ""),
                "vodId": vod.get("id", ""),
                "pic": vod.get("pic", ""),
                "remarks": vod.get("remarks", ""),
                "typeName": vod.get("typeName", ""),
                "score": score,
            })
    matched.sort(key=lambda m: -m["score"])
    del matched[60:]
    return {"results": matched, "searched": len(sites)}


def _norm_wd(wd: str) -> str:
    """搜索词归一化：压空白 + 小写，让「复仇者 联盟」与「复仇者联盟 」命中同一缓存。"""
    return " ".join(wd.split()).lower()


def _fingerprint(matched: list[dict]) -> str:
    """比对「哪些站点命中了什么片」，顺序敏感；pic/score 等展示字段不参与。"""
    return json.dumps([[m.get("siteKey"), m.get("vodId"), m.get("title"), m.get("remarks")] for m in matched],
                      ensure_ascii=False)


_search_revalidating: set[tuple[str, str]] = set()


async def _revalidate_search(device_id: str, key: str):
    """后台重新聚合搜索并与缓存比对：有变化覆盖并重置计时，无变化只记录校验时间。"""
    try:
        dev = active_device()
        if dev is None or dev.id != device_id or not dev.online:
            return  # 设备已切换/离线：不动缓存，下次命中再校验
        cached = database.get_search_cache(device_id, key)
        if cached is None:
            return
        fresh = await _do_live_search(cached["orig"] or key)
        payload = json.dumps({"results": fresh["results"], "searched": fresh["searched"]}, ensure_ascii=False)
        old = json.loads(cached["results"]).get("results", [])
        if _fingerprint(fresh["results"]) != _fingerprint(old):
            database.set_search_cache(device_id, key, cached["orig"] or key, payload, time.time(), time.time())
        else:
            database.touch_search_cache(device_id, key, time.time())
    except Exception:
        pass  # 校验失败保留旧缓存，下次命中再试
    finally:
        _search_revalidating.discard((device_id, key))


def _kick_revalidate(device_id: str, key: str):
    if (device_id, key) in _search_revalidating:
        return
    _search_revalidating.add((device_id, key))
    asyncio.create_task(_revalidate_search(device_id, key))


@router.get("/api/resource/search")
async def resource_search(wd: str, year: str = ""):
    dev = active_device()
    if dev is None or not dev.online:
        return {"deviceOnline": False, "results": [], "searched": 0}
    key = _norm_wd(wd)
    now = time.time()
    cached = database.get_search_cache(dev.id, key)
    if cached and now - cached["created_at"] < SEARCH_CACHE_TTL:
        # 命中：立即返回缓存；距上次校验超 1 小时则后台重搜比对（stale-while-revalidate）
        if now - max(cached["created_at"], cached["last_checked"]) >= SEARCH_RECHECK:
            _kick_revalidate(dev.id, key)
        disabled = database.get_disabled_site_keys()
        data = json.loads(cached["results"])
        results = [m for m in data.get("results", []) if m.get("siteKey") not in disabled]
        return {"deviceOnline": True, "results": results, "searched": data.get("searched", 0)}
    try:
        fresh = await _do_live_search(wd)
    except RuntimeError as e:
        return {"deviceOnline": False, "error": str(e), "results": [], "searched": 0}
    payload = json.dumps({"results": fresh["results"], "searched": fresh["searched"]}, ensure_ascii=False)
    database.set_search_cache(dev.id, key, wd, payload, now, now)
    if secrets.randbelow(10) == 0:  # 写入时低概率顺手清理过期行，避免表无限增长
        database.clean_search_cache(now - SEARCH_CACHE_TTL)
    return {"deviceOnline": True, **fresh}


class AdoptBody(BaseModel):
    key: str
    id: str


def _vod_type(type_name: str) -> str:
    """资源站分类名 → 模板媒体类型。"""
    tn = type_name or ""
    if "动漫" in tn or "动画" in tn:
        return "anime"
    if "纪录" in tn:
        return "doc"
    if "电影" in tn or tn.endswith("片"):
        return "movie"
    if "剧" in tn or "综艺" in tn or "真人秀" in tn or "脱口秀" in tn:
        return "series"
    return "movie"


@router.post("/api/resource/adopt")
async def resource_adopt(body: AdoptBody):
    """从搜索资源卡进入详情：拉站点详情并把 vod 信息注册进 subjects 统一表。"""
    try:
        data = await call_device("detail", {"key": body.key, "id": body.id})
    except RuntimeError as e:
        return {"error": str(e)}
    sid = f"{body.key}:{body.id}"
    m = re.search(r"(19|20)\d{2}", data.get("year") or "")
    type_name = data.get("typeName") or ""
    desc = _clean_desc(re.sub(r"<[^>]+>", "", data.get("content") or ""))[:600]
    upsert_subject({
        "id": sid, "source": "resource",
        "type": _vod_type(type_name),
        "title": data.get("name", ""),
        "original_title": "",
        "cover": data.get("pic", ""),
        "backdrop": data.get("pic", ""),
        "rating": 0, "year": int(m.group()) if m else 0,
        "duration": data.get("remarks", ""),
        "genres": [type_name] if type_name else [],
        "region": data.get("area", ""),
        "description": desc,
        "tagline": data.get("remarks", ""),
        "director": data.get("director", ""),
        "cast": [{"name": a.strip(), "role": "主演", "avatar": ""}
                 for a in re.split(r"[,，/、\s]+", data.get("actor") or "") if a.strip()][:10],
        "raw": {"key": body.key, "id": body.id, "siteName": data.get("siteName", "")},
    })
    row = get_subject(sid)
    return {"ok": True, "movie": row_to_item(row) if row else None}


def _clean_desc(text: str) -> str:
    """去掉资源站简介开头的 emoji/【推广】前缀等广告噪声。"""
    text = text.strip()
    text = re.sub(r"^[^\u4e00-\u9fa5A-Za-z0-9《]{0,8}", "", text)  # 开头 emoji/符号
    text = re.sub(r"^【[^】]{0,30}】\s*[:：]?", "", text)  # 【xxx】：
    # 前缀短句带"分享/推广/提醒"等推广词时整句丢弃
    head = text[:40]
    if "：" in head or ":" in head:
        sep = "：" if "：" in head else ":"
        prefix = head.split(sep)[0]
        if len(prefix) <= 25 and any(k in prefix for k in ("分享", "推广", "提醒", "关注", "广告", "声明", "客服", "网址")):
            text = text.split(sep, 1)[1].strip()
    return text


# ---------------- 智能选源（线路测速/清晰度/广告探测） ----------------

class ScanSite(BaseModel):
    key: str
    id: str
    name: str = ""


class ScanBody(BaseModel):
    candidates: list[ScanSite]
    refDurationS: float | None = None  # 片库片长（秒），供探测时做时长交叉比对


@router.post("/api/resource/scan")
async def resource_scan(body: ScanBody):
    """启动一次扫描：入参为聚合搜索命中的站点列表（按匹配分排序），按站点去重后探测其全部线路。"""
    dev = active_device()
    if dev is None or not dev.online:
        return {"error": "设备未连接，请打开 App 并保持前台运行"}
    seen, matches = set(), []
    for c in body.candidates:
        if not c.key or not c.id or c.key in seen:
            continue
        seen.add(c.key)
        matches.append({"key": c.key, "id": c.id, "name": c.name})
    del matches[15:]  # 候选站点上限，防止探测规模失控
    if not matches:
        return {"error": "没有可探测的候选源"}
    scan_id = await start_scan(matches, body.refDurationS)
    return {"scanId": scan_id, "sites": len(matches)}


@router.get("/api/resource/scan/{scan_id}")
async def resource_scan_events(scan_id: str):
    """SSE 流式返回探测结果；重连时重放已产生事件（消费端按 siteKey::flag 幂等合并）。"""
    task = get_scan(scan_id)
    if task is None:
        return JSONResponse({"error": "scan not found"}, status_code=404)

    async def gen():
        for ev in task.events:
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        while not task.done:
            try:
                ev = await asyncio.wait_for(task.queue.get(), 15.0)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if ev.get("type") == "done":
                break

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


# ---------------- 直播（设备桥，直连优先） ----------------

LIVE_TTL = 600  # 频道表按（设备, 源）内存缓存 10 分钟；另有 live_tables 落库层（不限时，供离线浏览）
_live_cache: dict[tuple[str, str], dict] = {}


def _live_cached(device_id: str, live: str) -> dict | None:
    cached = _live_cache.get((device_id, live))
    if cached and time.time() - cached["t"] < LIVE_TTL:
        return cached["data"]
    return None


def _live_set_cache(device_id: str, live: str, data: dict):
    _live_cache[(device_id, live)] = {"t": time.time(), "data": data}


def _live_table_stored(live: str) -> dict | None:
    """live_tables 持久缓存（按源名，跨设备共享配置；设备离线/服务重启后仍可浏览）。"""
    if not live:
        return None
    try:
        conn = get_conn()
        row = conn.execute("SELECT data FROM live_tables WHERE live_name=?", (live,)).fetchone()
        conn.close()
        return json.loads(row["data"]) if row else None
    except Exception:
        return None


def _live_table_store(live: str, data: dict):
    if not live:
        return
    try:
        conn = get_conn()
        conn.execute("INSERT OR REPLACE INTO live_tables (live_name, data, updated_at) VALUES (?, ?, ?)",
                     (live, json.dumps(data, ensure_ascii=False), time.time()))
        conn.commit()
        conn.close()
    except Exception:
        pass


def _register_lives(data: dict) -> set[str]:
    """把频道表里的 lives 清单登记进 live_sources（管理后台展示/禁用用），返回当前禁用名集。"""
    names = [l.get("name") for l in (data.get("lives") or []) if l.get("name")]
    if data.get("name") and data["name"] not in names:
        names.append(data["name"])
    if names:
        database.register_live_sources(names)
    return database.get_disabled_live_names()


@router.get("/api/live/list")
async def live_list(live: str = ""):
    """直播频道表：经设备解析（txt/m3u/json/spider 源都支持），内存缓存 → live_tables 落库，离线回退。
    lives 清单同步登记 live_sources；已禁用源从返回的 lives 剔除（/cine 源选择器即不展示），
    默认（App 激活）源被禁用时自动切到第一个未禁用源。"""
    dev = active_device()
    device_id = dev.id if dev is not None else ""

    async def resolve(name: str) -> dict:
        data = await call_device("liveList", {"live": name})
        _live_set_cache(device_id, name, data)
        _live_table_store(data.get("name") or name, data)
        return data

    if dev is not None and dev.online:
        try:
            data = await resolve(live)
            flags = {"deviceOnline": True}
        except RuntimeError as e:
            data = _live_cached(device_id, live) or _live_table_stored(live)
            if data is None:
                return {"deviceOnline": True, "error": str(e)}
            flags = {"deviceOnline": True, "stale": True}  # stale: 设备实际解析失败，此为缓存兜底
    else:
        # 设备离线：有缓存仍可浏览频道表（播放时才必须在线）
        data = _live_cached(device_id, live) or (_live_cache.get((device_id, live)) or {}).get("data") \
            or _live_table_stored(live)
        if data is None:
            return {"deviceOnline": False, "error": "设备未连接，请打开 App 并保持前台运行"}
        flags = {"deviceOnline": False}

    disabled = _register_lives(data)
    out = {**flags, **data}
    if not disabled:
        return out
    if data.get("name") in disabled:
        if live:
            return {**flags, "error": f"直播源「{data['name']}」已被禁用"}
        alt = next((l["name"] for l in (data.get("lives") or [])
                    if l.get("name") and l["name"] not in disabled), None)
        if not alt:
            return {**flags, "error": "当前直播源已被禁用，且没有其它可用源"}
        try:
            data = await resolve(alt)
        except RuntimeError as e:
            return {**flags, "error": f"当前直播源已被禁用，切换「{alt}」失败: {e}"}
        disabled = _register_lives(data)
        out = {**flags, **data}
    if disabled and out.get("lives"):
        # 只改 out（合并副本），不动缓存里的原始 data
        out["lives"] = [l for l in out["lives"] if l.get("name") not in disabled]
    return out


@router.get("/api/live/groups")
async def live_groups(live: str = ""):
    """单源分组/频道数摘要（源选择器展示用）：内存缓存 → live_tables 落库 → 设备解析后回填两层缓存。
    首次探测后落库，二次进页秒回且不占设备；切源时的 liveList 会自然刷新对应源的缓存。"""
    if not live:
        return {"error": "缺少 live 参数"}
    if live in database.get_disabled_live_names():
        return {"error": f"直播源「{live}」已被禁用"}
    dev = active_device()
    device_id = dev.id if dev is not None else ""
    table = _live_cached(device_id, live)
    if table is None:
        table = _live_table_stored(live)
    # 空表缓存（上次解析失败等）视为无效：设备在线时重探一次，避免「0 分组」死缓存
    empty_stored = table is not None and not (table.get("groups") or [])
    if (table is None or empty_stored) and dev is not None and dev.online:
        try:
            fresh = await call_device("liveList", {"live": live})
            _live_set_cache(device_id, live, fresh)
            _live_table_store(fresh.get("name") or live, fresh)
            _register_lives(fresh)
            table = fresh
        except RuntimeError:
            pass
    if table is None:
        return {"error": "设备未连接且无缓存"}
    groups = table.get("groups") or []
    return {"name": table.get("name") or live, "groups": len(groups),
            "channels": sum(len(g.get("channels") or []) for g in groups)}


def _live_wrap_play(request: Request, data: dict) -> dict:
    """直连优先：公网地址且无请求头时把原始 url 交给浏览器直连，
    否则走服务端 /stream 代理（补请求头 / 经设备转发）；proxy 字段始终提供，供直连失败回退。"""
    prefix = request.scope.get("root_path", "")
    url = data.get("url", "")
    headers = data.get("headers") or {}
    h64 = base64.b64encode(json.dumps(headers).encode()).decode()
    via = 1 if data.get("local") else 0
    proxy = f"{prefix}/stream?url={quote(url, safe='')}"
    if headers:
        proxy += f"&h={quote(h64, safe='')}"
    if via:
        proxy += f"&via=1"
    direct = (not data.get("local")) and (not headers) and url.startswith("http")
    data["proxy"] = proxy
    data["play"] = url if direct else proxy
    data["direct"] = direct
    return data


@router.get("/api/live/play")
async def live_play(request: Request, live: str = "", group: str = "", channel: str = "", line: int = 0):
    try:
        data = await call_device("livePlay", {"live": live, "group": group, "channel": channel, "line": line})
    except RuntimeError as e:
        return {"error": str(e)}
    return _live_wrap_play(request, data)


@router.get("/api/live/epg")
async def live_epg(live: str = "", group: str = "", channel: str = ""):
    try:
        return await call_device("liveEpg", {"live": live, "group": group, "channel": channel})
    except RuntimeError as e:
        return {"error": str(e)}


# ---------------- 直播体检（线路测速/清晰度/可用性） ----------------

class LiveScanBody(BaseModel):
    live: str = ""
    group: str = ""  # 非空时只探测该分组（手动体检按当前分组发起）


@router.post("/api/live/scan")
async def live_scan(body: LiveScanBody):
    """启动一次直播源体检（手动发起）：抽样探测——每分组前 10 个频道 × 每频道前 2 条线路；
    group 非空时只探测该分组。live 为空表示 App 当前激活源。"""
    dev = active_device()
    if dev is None or not dev.online:
        return {"error": "设备未连接，请打开 App 并保持前台运行"}
    device_id = dev.id
    table = _live_cached(device_id, body.live)
    if table is None:
        try:
            table = await call_device("liveList", {"live": body.live})
            _live_set_cache(device_id, body.live, table)
            _live_table_store(table.get("name") or body.live, table)
        except RuntimeError as e:
            table = _live_table_stored(body.live)
            if table is None:
                return {"error": str(e)}
    # 探测缓存按源名落库：live 为空时用设备返回的实际源名，避免切换激活源后串缓存
    live = body.live or table.get("name") or ""
    total = sum(n for _, _, n in plan_channels(table, body.group))
    scan_id = await liveprobe_start_scan(live, table, body.group)
    if secrets.randbelow(20) == 0:  # 低概率清理过期探测行
        clean_live_probe()
    return {"scanId": scan_id, "total": total}


@router.post("/api/live/scan/{scan_id}/cancel")
async def live_scan_cancel(scan_id: str):
    return {"ok": cancel_live_scan(scan_id)}


@router.get("/api/live/scan/{scan_id}")
async def live_scan_events(scan_id: str):
    """SSE 流式返回体检结果；重连时重放已产生事件（消费端按 频道::线路 幂等合并）。"""
    task = get_live_scan(scan_id)
    if task is None:
        return JSONResponse({"error": "scan not found"}, status_code=404)

    async def gen():
        for ev in task.events:
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
        while not task.done:
            try:
                ev = await asyncio.wait_for(task.queue.get(), 15.0)
            except asyncio.TimeoutError:
                yield ": ping\n\n"
                continue
            yield f"data: {json.dumps(ev, ensure_ascii=False)}\n\n"
            if ev.get("type") == "done":
                break

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@router.get("/api/live/probe")
async def live_probe(live: str = ""):
    """当前源的新鲜探测缓存（进页秒显徽章；体检由前端手动探测按钮发起）。"""
    return {"list": get_live_probe_results(live), "ttl": LIVE_PROBE_TTL}


@router.get("/api/live/favorites")
async def live_favorites_list(request: Request):
    user = _require(request)
    if user is None:
        return _auth_error()
    return {"list": database.list_live_favorites(user["id"])}


class LiveFavBody(BaseModel):
    # 与 GET /api/live/favorites 返回行同构（LiveFavoriteItem）；曾用 live/group/channel 命名，
    # 前端一直发 camelCase 字段导致 422（2026-09-01 修）
    liveName: str = ""
    groupName: str
    channelName: str
    line: int = 0
    logo: str = ""


@router.post("/api/live/favorites/toggle")
async def live_favorites_toggle(request: Request, body: LiveFavBody):
    user = _require(request)
    if user is None:
        return _auth_error()
    favorited = database.toggle_live_favorite(user["id"], body.liveName, body.groupName, body.channelName, body.line, body.logo)
    return {"ok": True, "favorited": favorited}


@router.post("/api/live/favorites/line")
async def live_favorites_line(request: Request, body: LiveFavBody):
    """记住收藏频道当前使用的线路（未收藏时静默忽略）。"""
    user = _require(request)
    if user is None:
        return _auth_error()
    database.update_live_favorite_line(user["id"], body.liveName, body.groupName, body.channelName, body.line)
    return {"ok": True}


class LiveHistBody(LiveFavBody):
    pass


@router.get("/api/live/history")
async def live_history_list(request: Request):
    user = _require(request)
    if user is None:
        return _auth_error()
    return {"list": database.list_live_history(user["id"])}


@router.post("/api/live/history")
async def live_history_save(request: Request, body: LiveHistBody):
    """记录一条直播观看历史（upsert + 每用户最多保留 10 条）。"""
    user = _require(request)
    if user is None:
        return _auth_error()
    database.save_live_history(user["id"], body.liveName, body.groupName, body.channelName, body.line, body.logo)
    return {"ok": True}


# ---------------- 图片防盗链透传 ----------------

# 豆瓣 img9 图床按 TLS 指纹识别 Python 客户端并回反爬挑战页，curl_cffi 模拟浏览器指纹可绕过；
# 未安装时降级 httpx（部分图床节点仍可用）。
try:
    from curl_cffi.requests import AsyncSession as CurlSession
except ImportError:
    CurlSession = None

_img_client_direct = None
_img_client_proxy = None
_img_sem = asyncio.Semaphore(4)  # 并发过高同样会触发反爬，限流
IMG_CACHE_DIR = os.path.join(os.path.dirname(__file__), "data", "img_cache")


def _img_clients() -> tuple:
    """返回 (直连客户端, 代理客户端或 None)，curl_cffi 优先。"""
    global _img_client_direct, _img_client_proxy
    if _img_client_direct is None:
        if CurlSession is not None:
            _img_client_direct = CurlSession(impersonate="chrome", timeout=15)
        else:
            _img_client_direct = httpx.AsyncClient(follow_redirects=True, timeout=15.0)
    if _img_client_proxy is None and TMDB_PROXY:
        if CurlSession is not None:
            _img_client_proxy = CurlSession(impersonate="chrome", timeout=15, proxy=TMDB_PROXY)
        else:
            _img_client_proxy = httpx.AsyncClient(follow_redirects=True, timeout=15.0, proxy=TMDB_PROXY)
    return _img_client_direct, _img_client_proxy


def _sniff_mime(data: bytes) -> str | None:
    """识别真实图片格式；非图片（如反爬挑战 HTML）返回 None。"""
    if data[:3] == b"\xff\xd8\xff":
        return "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "image/webp"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    return None


async def _img_fetch(url: str) -> tuple[bytes | None, str]:
    """回源拉图：豆瓣要伪装 Referer；响应必须是真实图片（反爬挑战页判失败重试）。"""
    direct, proxied = _img_clients()
    if "doubanio.com" in url:
        referer = "https://m.douban.com/"
    else:
        referer = url.split("/")[0] + "//" + (url.split("/")[2] if "/" in url else "") + "/"
    headers = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                             "(KHTML, like Gecko) Chrome/124.0 Safari/537.36",
               "Referer": referer, "Accept": "image/avif,image/webp,image/*,*/*;q=0.8"}
    client = proxied if ("tmdb.org" in url and proxied) else direct
    for attempt in (1, 2):
        try:
            async with _img_sem:
                resp = await client.get(url, headers=headers)
            mime = _sniff_mime(resp.content) if resp.status_code == 200 else None
            if mime:
                return resp.content, mime
        except Exception:
            pass
        await asyncio.sleep(0.4 * attempt)
    return None, ""


@router.get("/api/img")
async def img_proxy(url: str):
    # 豆瓣缩略 URL（h/120）改写为原图再取；缓存 key 用改写后的 URL，旧小图缓存自然失效
    fetch_url = upgrade_douban_img(url)
    key = hashlib.md5(fetch_url.encode()).hexdigest()
    os.makedirs(IMG_CACHE_DIR, exist_ok=True)
    cache_path = os.path.join(IMG_CACHE_DIR, key)
    if os.path.isfile(cache_path):
        with open(cache_path, "rb") as f:
            data = f.read()
        return Response(data, media_type=_sniff_mime(data) or "image/jpeg",
                        headers={"Cache-Control": "public, max-age=604800",
                                 "Access-Control-Allow-Origin": "*"})
    data, mime = await _img_fetch(fetch_url)
    if data is None:
        return JSONResponse({"error": "图片获取失败"}, status_code=502)
    try:
        with open(cache_path, "wb") as f:
            f.write(data)
    except OSError:
        pass
    return Response(data, media_type=mime,
                    headers={"Cache-Control": "public, max-age=604800",
                             "Access-Control-Allow-Origin": "*"})
