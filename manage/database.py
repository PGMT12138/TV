# manage/database.py
import sqlite3
import os
import time
from datetime import datetime

DB_PATH = os.path.join(os.path.dirname(__file__), "data", "urls.db")


def get_conn():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    return conn


def init_db():
    conn = get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS app_versions (
            platform TEXT PRIMARY KEY,
            version INTEGER NOT NULL,
            url TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS urls (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type INTEGER NOT NULL,
            name TEXT DEFAULT '',
            url TEXT NOT NULL,
            sort INTEGER DEFAULT 0,
            enabled INTEGER DEFAULT 1,
            created_at TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS home_contents (
            site_key TEXT PRIMARY KEY,
            site_name TEXT DEFAULT '',
            config_name TEXT DEFAULT '',
            content TEXT NOT NULL,
            updated_at TEXT DEFAULT ''
        )
    """)
    try:
        conn.execute("ALTER TABLE home_contents ADD COLUMN config_name TEXT DEFAULT ''")
    except Exception:
        pass
    try:
        conn.execute("ALTER TABLE videos ADD COLUMN device_name TEXT DEFAULT ''")
    except Exception:
        pass
    conn.execute("""
        CREATE TABLE IF NOT EXISTS videos (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vod_name TEXT NOT NULL DEFAULT '',
            vod_pic TEXT DEFAULT '',
            vod_year TEXT DEFAULT '',
            vod_area TEXT DEFAULT '',
            vod_director TEXT DEFAULT '',
            vod_actor TEXT DEFAULT '',
            vod_content TEXT DEFAULT '',
            type_name TEXT DEFAULT '',
            site_key TEXT NOT NULL DEFAULT '',
            site_name TEXT DEFAULT '',
            flag TEXT DEFAULT '',
            episode_name TEXT DEFAULT '',
            episode_url TEXT DEFAULT '',
            play_url TEXT NOT NULL DEFAULT '',
            headers TEXT DEFAULT '{}',
            device_name TEXT DEFAULT '',
            created_at TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )
    """)
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_videos_site_ep ON videos(site_key, episode_url)")

    # ---------------- CINE 视频站（/cine） ----------------

    conn.execute("""
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            salt TEXT NOT NULL,
            created_at TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            token_hash TEXT PRIMARY KEY,
            user_id INTEGER NOT NULL,
            expires_at REAL NOT NULL
        )
    """)
    # 统一片库注册表：豆瓣榜单/搜索种子 + 资源页反填，收藏/历史都按 subject_id 关联
    conn.execute("""
        CREATE TABLE IF NOT EXISTS subjects (
            id TEXT PRIMARY KEY,
            source TEXT DEFAULT 'douban',
            type TEXT DEFAULT 'movie',
            title TEXT DEFAULT '',
            original_title TEXT DEFAULT '',
            cover TEXT DEFAULT '',
            backdrop TEXT DEFAULT '',
            rating REAL DEFAULT 0,
            year INTEGER DEFAULT 0,
            duration TEXT DEFAULT '',
            genres TEXT DEFAULT '[]',
            region TEXT DEFAULT '',
            description TEXT DEFAULT '',
            tagline TEXT DEFAULT '',
            director TEXT DEFAULT '',
            cast_json TEXT DEFAULT '[]',
            raw_json TEXT DEFAULT '{}',
            updated_at TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sections (
            key TEXT PRIMARY KEY,
            title TEXT DEFAULT '',
            updated_at TEXT DEFAULT ''
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS section_items (
            section_key TEXT NOT NULL,
            subject_id TEXT NOT NULL,
            sort INTEGER DEFAULT 0,
            PRIMARY KEY (section_key, subject_id)
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS favorites (
            user_id INTEGER NOT NULL,
            subject_id TEXT NOT NULL,
            title TEXT DEFAULT '',
            cover TEXT DEFAULT '',
            rating REAL DEFAULT 0,
            year INTEGER DEFAULT 0,
            type TEXT DEFAULT 'movie',
            created_at TEXT DEFAULT '',
            PRIMARY KEY (user_id, subject_id)
        )
    """)
    # 智能选源：站点滚动统计事件
    conn.execute("""
        CREATE TABLE IF NOT EXISTS site_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            site_key TEXT NOT NULL,
            ok INTEGER NOT NULL,
            ad_level TEXT DEFAULT '',
            speed_mbps REAL,
            height INTEGER,
            created_at REAL NOT NULL
        )
    """)
    # 每用户每部影片一行（upsert），换集时更新——"继续观看"语义
    conn.execute("""
        CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            subject_id TEXT NOT NULL,
            title TEXT DEFAULT '',
            cover TEXT DEFAULT '',
            backdrop TEXT DEFAULT '',
            episode_id TEXT DEFAULT '',
            episode_title TEXT DEFAULT '',
            episode_number INTEGER DEFAULT 1,
            watched_seconds REAL DEFAULT 0,
            total_seconds REAL DEFAULT 0,
            updated_at TEXT DEFAULT '',
            UNIQUE (user_id, subject_id)
        )
    """)
    # 旧库补列：历史记录记住上次选择的站点/线路（SQLite 没有列级 IF NOT EXISTS，需手动迁移）
    hist_cols = {r["name"] for r in conn.execute("PRAGMA table_info(history)")}
    if "site_key" not in hist_cols:
        conn.execute("ALTER TABLE history ADD COLUMN site_key TEXT DEFAULT ''")
    if "flag" not in hist_cols:
        conn.execute("ALTER TABLE history ADD COLUMN flag TEXT DEFAULT ''")

    # 聚合搜索命中缓存（TTL 与后台刷新策略见 cine.py resource_search）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS search_cache (
            device_id TEXT NOT NULL,
            wd TEXT NOT NULL,
            orig TEXT DEFAULT '',
            results TEXT NOT NULL,
            created_at REAL NOT NULL,
            last_checked REAL NOT NULL,
            PRIMARY KEY (device_id, wd)
        )
    """)

    # ---------------- 桥接设备管理 ----------------

    # 历史设备（在线状态由 bridge.py 运行时注册表维护，表里只留身份与时间）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS devices (
            id TEXT PRIMARY KEY,
            name TEXT DEFAULT '',
            version TEXT DEFAULT '',
            first_seen_at TEXT DEFAULT '',
            last_seen_at TEXT DEFAULT ''
        )
    """)
    # 通用键值配置（当前 active_device_id 等）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT
        )
    """)
    # 搜索站点登记：每次聚合搜索 upsert，disabled=1 的站点全局跳过（与设备无关）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS search_sites (
            site_key TEXT PRIMARY KEY,
            site_name TEXT DEFAULT '',
            search_count INTEGER DEFAULT 0,
            last_searched_at TEXT DEFAULT '',
            disabled INTEGER DEFAULT 0
        )
    """)
    # 直播频道收藏：按 (live, group, channel) 定位一个频道，line 记住上次选择的线路
    conn.execute("""
        CREATE TABLE IF NOT EXISTS live_favorites (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            live_name TEXT NOT NULL DEFAULT '',
            group_name TEXT NOT NULL,
            channel_name TEXT NOT NULL,
            line INTEGER NOT NULL DEFAULT 0,
            logo TEXT NOT NULL DEFAULT '',
            created_at TEXT NOT NULL,
            UNIQUE(user_id, live_name, group_name, channel_name)
        )
    """)
    # 直播观看历史：每用户每频道一行 upsert，updated_at 为最后观看时间，应用层只保留最近 10 条
    conn.execute("""
        CREATE TABLE IF NOT EXISTS live_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            live_name TEXT NOT NULL DEFAULT '',
            group_name TEXT NOT NULL,
            channel_name TEXT NOT NULL,
            line INTEGER NOT NULL DEFAULT 0,
            logo TEXT NOT NULL DEFAULT '',
            updated_at TEXT NOT NULL,
            UNIQUE(user_id, live_name, group_name, channel_name)
        )
    """)
    # 直播源登记：liveList 看到的全部源（管理后台展示；disabled=1 后 /cine 源选择器不再展示）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS live_sources (
            name TEXT PRIMARY KEY,
            disabled INTEGER NOT NULL DEFAULT 0,
            first_seen TEXT NOT NULL,
            last_seen TEXT NOT NULL
        )
    """)
    # 直播频道表持久缓存：设备离线/服务重启后仍可浏览（替代原纯内存 10min dict 的落库层）
    conn.execute("""
        CREATE TABLE IF NOT EXISTS live_tables (
            live_name TEXT PRIMARY KEY,
            data TEXT NOT NULL,
            updated_at REAL NOT NULL
        )
    """)
    # 直播线路探测缓存：一次体检的结果（含失败记录），TTL 读时判定
    conn.execute("""
        CREATE TABLE IF NOT EXISTS live_probe (
            live_name TEXT NOT NULL,
            group_name TEXT NOT NULL,
            channel_name TEXT NOT NULL,
            line INTEGER NOT NULL,
            metrics TEXT NOT NULL,
            created_at REAL NOT NULL,
            PRIMARY KEY (live_name, group_name, channel_name, line)
        )
    """)
    conn.commit()
    conn.close()


# ---------------- 聚合搜索缓存 ----------------

def get_search_cache(device_id: str, wd: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT device_id, wd, orig, results, created_at, last_checked FROM search_cache "
                       "WHERE device_id=? AND wd=?", (device_id, wd)).fetchone()
    conn.close()
    return dict(row) if row else None


def set_search_cache(device_id: str, wd: str, orig: str, payload: str, created_at: float, last_checked: float):
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO search_cache (device_id, wd, orig, results, created_at, last_checked) "
                 "VALUES (?, ?, ?, ?, ?, ?)", (device_id, wd, orig, payload, created_at, last_checked))
    conn.commit()
    conn.close()


def touch_search_cache(device_id: str, wd: str, last_checked: float):
    conn = get_conn()
    conn.execute("UPDATE search_cache SET last_checked=? WHERE device_id=? AND wd=?",
                 (last_checked, device_id, wd))
    conn.commit()
    conn.close()


def clean_search_cache(expire_before: float):
    conn = get_conn()
    conn.execute("DELETE FROM search_cache WHERE created_at < ?", (expire_before,))
    conn.commit()
    conn.close()


def get_urls(url_type: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, url, sort, enabled FROM urls WHERE type = ? AND enabled = 1 ORDER BY sort ASC, id ASC",
        (url_type,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_all_urls(url_type: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, url, sort, enabled, created_at FROM urls WHERE type = ? ORDER BY sort ASC, id ASC",
        (url_type,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def add_url(url_type: int, name: str, url: str, sort: int = 0) -> dict:
    conn = get_conn()
    now = datetime.now().isoformat()
    cursor = conn.execute(
        "INSERT INTO urls (type, name, url, sort, enabled, created_at) VALUES (?, ?, ?, ?, 1, ?)",
        (url_type, name, url, sort, now),
    )
    row_id = cursor.lastrowid
    conn.commit()
    row = conn.execute("SELECT id, name, url, sort, enabled, created_at FROM urls WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    return dict(row)


def update_url(row_id: int, name: str = None, url: str = None, sort: int = None, enabled: bool = None) -> dict:
    conn = get_conn()
    sets = []
    params = []
    if name is not None:
        sets.append("name = ?")
        params.append(name)
    if url is not None:
        sets.append("url = ?")
        params.append(url)
    if sort is not None:
        sets.append("sort = ?")
        params.append(sort)
    if enabled is not None:
        sets.append("enabled = ?")
        params.append(1 if enabled else 0)
    if not sets:
        conn.close()
        raise ValueError("No fields to update")
    params.append(row_id)
    conn.execute(f"UPDATE urls SET {', '.join(sets)} WHERE id = ?", params)
    conn.commit()
    row = conn.execute("SELECT id, name, url, sort, enabled, created_at FROM urls WHERE id = ?", (row_id,)).fetchone()
    conn.close()
    return dict(row)


def delete_url(row_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM urls WHERE id = ?", (row_id,))
    conn.commit()
    conn.close()


def delete_urls_batch(row_ids: list[int]):
    conn = get_conn()
    placeholders = ",".join("?" * len(row_ids))
    conn.execute(f"DELETE FROM urls WHERE id IN ({placeholders})", row_ids)
    conn.commit()
    conn.close()


def get_app_version(platform: str) -> dict | None:
    conn = get_conn()
    row = conn.execute("SELECT platform, version, url, updated_at FROM app_versions WHERE platform = ?", (platform,)).fetchone()
    conn.close()
    return dict(row) if row else None


def set_app_version(platform: str, version: int, url: str) -> dict:
    conn = get_conn()
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO app_versions (platform, version, url, updated_at) VALUES (?, ?, ?, ?)",
        (platform, version, url, now),
    )
    conn.commit()
    row = conn.execute("SELECT platform, version, url, updated_at FROM app_versions WHERE platform = ?", (platform,)).fetchone()
    conn.close()
    return dict(row)


def upsert_home_content(site_key: str, site_name: str, config_name: str, content: str) -> dict:
    conn = get_conn()
    now = datetime.now().isoformat()
    conn.execute(
        "INSERT OR REPLACE INTO home_contents (site_key, site_name, config_name, content, updated_at) VALUES (?, ?, ?, ?, ?)",
        (site_key, site_name, config_name, content, now),
    )
    conn.commit()
    row = conn.execute("SELECT site_key, site_name, config_name, content, updated_at FROM home_contents WHERE site_key = ?", (site_key,)).fetchone()
    conn.close()
    return dict(row)


def get_home_contents(has_video: bool | None = None) -> list[dict]:
    conn = get_conn()
    if has_video is True:
        rows = conn.execute("SELECT site_key, site_name, config_name, content, updated_at FROM home_contents WHERE content LIKE '%\"list\":%' ORDER BY updated_at DESC").fetchall()
    elif has_video is False:
        rows = conn.execute("SELECT site_key, site_name, config_name, content, updated_at FROM home_contents WHERE content NOT LIKE '%\"list\":%' ORDER BY updated_at DESC").fetchall()
    else:
        rows = conn.execute("SELECT site_key, site_name, config_name, content, updated_at FROM home_contents ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_home_content(site_key: str) -> dict:
    conn = get_conn()
    row = conn.execute("SELECT site_key, site_name, config_name, content, updated_at FROM home_contents WHERE site_key = ?", (site_key,)).fetchone()
    conn.close()
    if row is None:
        raise ValueError("Not found")
    return dict(row)


def delete_home_content(site_key: str):
    conn = get_conn()
    conn.execute("DELETE FROM home_contents WHERE site_key = ?", (site_key,))
    conn.commit()
    conn.close()


def upsert_video(site_key: str, episode_url: str, vod_name: str, vod_pic: str,
                 vod_year: str, vod_area: str, vod_director: str, vod_actor: str,
                 vod_content: str, type_name: str, site_name: str, flag: str,
                 episode_name: str, play_url: str, headers: str,
                 device_name: str = "") -> dict:
    conn = get_conn()
    now = datetime.now().isoformat()
    existing = conn.execute("SELECT id, created_at FROM videos WHERE site_key = ? AND episode_url = ?", (site_key, episode_url)).fetchone()
    created = existing["created_at"] if existing else now
    conn.execute("""
        INSERT OR REPLACE INTO videos (site_key, episode_url, vod_name, vod_pic, vod_year, vod_area,
            vod_director, vod_actor, vod_content, type_name, site_name, flag,
            episode_name, play_url, headers, device_name, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (site_key, episode_url, vod_name, vod_pic, vod_year, vod_area,
          vod_director, vod_actor, vod_content, type_name, site_name, flag,
          episode_name, play_url, headers, device_name, created, now))
    conn.commit()
    row = conn.execute("SELECT * FROM videos WHERE site_key = ? AND episode_url = ?", (site_key, episode_url)).fetchone()
    conn.close()
    return dict(row)


def get_videos() -> list[dict]:
    conn = get_conn()
    rows = conn.execute("SELECT * FROM videos ORDER BY updated_at DESC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_video(video_id: int) -> dict:
    conn = get_conn()
    row = conn.execute("SELECT * FROM videos WHERE id = ?", (video_id,)).fetchone()
    conn.close()
    if row is None:
        raise ValueError("Not found")
    return dict(row)


def delete_video(video_id: int):
    conn = get_conn()
    conn.execute("DELETE FROM videos WHERE id = ?", (video_id,))
    conn.commit()
    conn.close()


def delete_videos_batch(video_ids: list[int]):
    conn = get_conn()
    placeholders = ",".join("?" * len(video_ids))
    conn.execute(f"DELETE FROM videos WHERE id IN ({placeholders})", video_ids)
    conn.commit()
    conn.close()


def delete_home_contents_batch(site_keys: list[str]):
    conn = get_conn()
    placeholders = ",".join("?" * len(site_keys))
    conn.execute(f"DELETE FROM home_contents WHERE site_key IN ({placeholders})", site_keys)
    conn.commit()
    conn.close()


# ---------------- 桥接设备管理 ----------------

def upsert_device(device_id: str, name: str, version: str) -> None:
    conn = get_conn()
    now = datetime.now().isoformat()
    conn.execute("""
        INSERT INTO devices (id, name, version, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name,
            version = excluded.version, last_seen_at = excluded.last_seen_at
    """, (device_id, name, version, now, now))
    conn.commit()
    conn.close()


def touch_device(device_id: str) -> None:
    conn = get_conn()
    conn.execute("UPDATE devices SET last_seen_at = ? WHERE id = ?",
                 (datetime.now().isoformat(), device_id))
    conn.commit()
    conn.close()


def list_devices() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT id, name, version, first_seen_at, last_seen_at FROM devices ORDER BY last_seen_at DESC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_setting(key: str, default: str = "") -> str:
    conn = get_conn()
    row = conn.execute("SELECT value FROM settings WHERE key = ?", (key,)).fetchone()
    conn.close()
    return row["value"] if row and row["value"] is not None else default


def set_setting(key: str, value: str) -> None:
    conn = get_conn()
    conn.execute("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)", (key, value))
    conn.commit()
    conn.close()


def record_search_sites(sites: list[dict]) -> None:
    """聚合搜索时登记参与站点：新站点插入，老站点更新名称并累加搜索次数。"""
    if not sites:
        return
    now = datetime.now().isoformat()
    conn = get_conn()
    conn.executemany("""
        INSERT INTO search_sites (site_key, site_name, search_count, last_searched_at, disabled)
        VALUES (?, ?, 1, ?, 0)
        ON CONFLICT(site_key) DO UPDATE SET site_name = excluded.site_name,
            search_count = search_count + 1, last_searched_at = excluded.last_searched_at
    """, [(s.get("key", ""), s.get("name", ""), now) for s in sites])
    conn.commit()
    conn.close()


def list_search_sites() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT site_key, site_name, search_count, last_searched_at, disabled "
        "FROM search_sites ORDER BY disabled ASC, search_count DESC, site_key ASC"
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_disabled_site_keys() -> set[str]:
    conn = get_conn()
    rows = conn.execute("SELECT site_key FROM search_sites WHERE disabled = 1").fetchall()
    conn.close()
    return {r["site_key"] for r in rows}


def set_search_site_disabled(site_keys: list[str] | None, disabled: bool) -> None:
    """site_keys 为 None 时作用于全部站点。"""
    conn = get_conn()
    if site_keys is None:
        conn.execute("UPDATE search_sites SET disabled = ?", (1 if disabled else 0,))
    elif site_keys:
        placeholders = ",".join("?" * len(site_keys))
        conn.execute(f"UPDATE search_sites SET disabled = ? WHERE site_key IN ({placeholders})",
                     [1 if disabled else 0, *site_keys])
    conn.commit()
    conn.close()


# ---------------- 网站用户管理（管理端） ----------------

def list_users() -> list[dict]:
    """CINE 注册用户 + 收藏/历史/观看时长/有效会话统计。"""
    conn = get_conn()
    rows = conn.execute("""
        SELECT u.id, u.username, u.created_at,
            (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) AS favorites,
            (SELECT COUNT(*) FROM history h WHERE h.user_id = u.id) AS history_count,
            (SELECT COALESCE(SUM(h.watched_seconds), 0) FROM history h WHERE h.user_id = u.id) AS watch_seconds,
            (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.expires_at > ?) AS active_sessions
        FROM users u
        ORDER BY u.created_at DESC
    """, (time.time(),)).fetchall()
    conn.close()
    return [dict(r) for r in rows]


def delete_user_sessions(user_id: int) -> None:
    """强制下线：清掉该用户全部会话。"""
    conn = get_conn()
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.commit()
    conn.close()


def delete_user(user_id: int) -> None:
    """删除用户并级联清理会话/收藏/观看历史。"""
    conn = get_conn()
    conn.execute("DELETE FROM sessions WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM favorites WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM history WHERE user_id = ?", (user_id,))
    conn.execute("DELETE FROM users WHERE id = ?", (user_id,))
    conn.commit()
    conn.close()


# ---------------- 直播频道收藏 ----------------

def list_live_favorites(user_id: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT live_name, group_name, channel_name, line, logo FROM live_favorites "
        "WHERE user_id = ? ORDER BY created_at DESC", (user_id,)).fetchall()
    conn.close()
    return [{"liveName": r["live_name"], "groupName": r["group_name"], "channelName": r["channel_name"],
             "line": r["line"], "logo": r["logo"] or ""} for r in rows]


def toggle_live_favorite(user_id: int, live: str, group: str, channel: str, line: int, logo: str) -> bool:
    """收藏/取消收藏频道，返回收藏后的状态。"""
    conn = get_conn()
    existing = conn.execute(
        "SELECT 1 FROM live_favorites WHERE user_id = ? AND live_name = ? AND group_name = ? AND channel_name = ?",
        (user_id, live, group, channel)).fetchone()
    if existing:
        conn.execute(
            "DELETE FROM live_favorites WHERE user_id = ? AND live_name = ? AND group_name = ? AND channel_name = ?",
            (user_id, live, group, channel))
        favorited = False
    else:
        conn.execute(
            "INSERT OR IGNORE INTO live_favorites (user_id, live_name, group_name, channel_name, line, logo, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (user_id, live, group, channel, line, logo, datetime.now().isoformat()))
        favorited = True
    conn.commit()
    conn.close()
    return favorited


def update_live_favorite_line(user_id: int, live: str, group: str, channel: str, line: int) -> None:
    """记住频道当前使用的线路（收藏项存在时才更新）。"""
    conn = get_conn()
    conn.execute(
        "UPDATE live_favorites SET line = ? WHERE user_id = ? AND live_name = ? AND group_name = ? AND channel_name = ?",
        (line, user_id, live, group, channel))
    conn.commit()
    conn.close()


# ---------------- 直播观看历史 ----------------

def list_live_history(user_id: int) -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT live_name, group_name, channel_name, line, logo, updated_at FROM live_history "
        "WHERE user_id = ? ORDER BY updated_at DESC", (user_id,)).fetchall()
    conn.close()
    return [{"liveName": r["live_name"], "groupName": r["group_name"], "channelName": r["channel_name"],
             "line": r["line"], "logo": r["logo"] or "", "updatedAt": r["updated_at"]} for r in rows]


def save_live_history(user_id: int, live: str, group: str, channel: str, line: int, logo: str) -> None:
    """记录/刷新一条观看历史（同频道 upsert 到最新线路与时间），每用户只保留最近 10 条。"""
    conn = get_conn()
    conn.execute(
        "INSERT INTO live_history (user_id, live_name, group_name, channel_name, line, logo, updated_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?) "
        "ON CONFLICT(user_id, live_name, group_name, channel_name) "
        "DO UPDATE SET line = excluded.line, logo = excluded.logo, updated_at = excluded.updated_at",
        (user_id, live, group, channel, line, logo, datetime.now().isoformat()))
    conn.execute(
        "DELETE FROM live_history WHERE user_id = ? AND id NOT IN "
        "(SELECT id FROM live_history WHERE user_id = ? ORDER BY updated_at DESC LIMIT 10)",
        (user_id, user_id))
    conn.commit()
    conn.close()


# ---------------- 直播源登记与禁用 ----------------

def register_live_sources(names: list[str]) -> None:
    """liveList 看到的直播源全部登记（新源插入，老源刷新 last_seen；禁用状态不动）。"""
    if not names:
        return
    now = datetime.now().isoformat()
    conn = get_conn()
    conn.executemany("""
        INSERT INTO live_sources (name, disabled, first_seen, last_seen)
        VALUES (?, 0, ?, ?)
        ON CONFLICT(name) DO UPDATE SET last_seen = excluded.last_seen
    """, [(n, now, now) for n in names])
    conn.commit()
    conn.close()


def list_live_sources() -> list[dict]:
    conn = get_conn()
    rows = conn.execute(
        "SELECT name, disabled, first_seen, last_seen FROM live_sources "
        "ORDER BY disabled ASC, name ASC").fetchall()
    conn.close()
    return [dict(r) for r in rows]


def get_disabled_live_names() -> set[str]:
    conn = get_conn()
    rows = conn.execute("SELECT name FROM live_sources WHERE disabled = 1").fetchall()
    conn.close()
    return {r["name"] for r in rows}


def set_live_source_disabled(names: list[str] | None, disabled: bool) -> None:
    """names 为 None 时作用于全部直播源。"""
    conn = get_conn()
    if names is None:
        conn.execute("UPDATE live_sources SET disabled = ?", (1 if disabled else 0,))
    elif names:
        placeholders = ",".join("?" * len(names))
        conn.execute(f"UPDATE live_sources SET disabled = ? WHERE name IN ({placeholders})",
                     [1 if disabled else 0, *names])
    conn.commit()
    conn.close()
