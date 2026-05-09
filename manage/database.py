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


def get_home_contents() -> list[dict]:
    conn = get_conn()
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
