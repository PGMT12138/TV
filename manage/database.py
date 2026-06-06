# manage/database.py
import sqlite3
import os
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
