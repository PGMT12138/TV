"""下载记录与文件生命周期；记录删除文件后仍保留供管理端审计。"""
import json
import time
import uuid
from contextlib import closing

from database import get_conn

ACTIVE = ("queued", "resolving", "downloading", "muxing", "verifying")


def init():
    with closing(get_conn()) as conn, conn:
        conn.execute("""CREATE TABLE IF NOT EXISTS download_tasks (
            id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, device_id TEXT NOT NULL,
            source TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
            bytes_done INTEGER NOT NULL DEFAULT 0, bytes_total INTEGER NOT NULL DEFAULT 0,
            segments_done INTEGER NOT NULL DEFAULT 0, segments_total INTEGER NOT NULL DEFAULT 0,
            filename TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0,
            duration REAL NOT NULL DEFAULT 0, error TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL, updated_at REAL NOT NULL, expires_at REAL NOT NULL DEFAULT 0
        )""")
        conn.execute("CREATE INDEX IF NOT EXISTS downloads_owner ON download_tasks(user_id, created_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS downloads_status ON download_tasks(status, created_at)")


def decode(row):
    if row is None:
        return None
    result = dict(row)
    result["source"] = json.loads(result["source"])
    return result


def get(task_id):
    with closing(get_conn()) as conn:
        return decode(conn.execute("SELECT * FROM download_tasks WHERE id=?", (task_id,)).fetchone())


def list_tasks(user_id=None, limit=100, offset=0, status=""):
    where, args = [], []
    if user_id is not None:
        where.append("d.user_id=?")
        args.append(user_id)
    if status:
        where.append("d.status=?")
        args.append(status)
    clause = " WHERE " + " AND ".join(where) if where else ""
    with closing(get_conn()) as conn:
        total = conn.execute("SELECT COUNT(*) FROM download_tasks d" + clause, args).fetchone()[0]
        rows = conn.execute("SELECT d.*, u.username FROM download_tasks d LEFT JOIN users u ON u.id=d.user_id"
                            + clause + " ORDER BY d.created_at DESC LIMIT ? OFFSET ?", (*args, limit, offset)).fetchall()
    return [decode(row) for row in rows], total


def by_status(*states):
    with closing(get_conn()) as conn:
        return [decode(row) for row in conn.execute(
            "SELECT * FROM download_tasks WHERE status IN (" + ",".join("?" for _ in states) + ") ORDER BY created_at",
            states).fetchall()]


def create(user_id, device_id, source):
    task_id, now = uuid.uuid4().hex, time.time()
    with closing(get_conn()) as conn, conn:
        conn.execute("INSERT INTO download_tasks(id,user_id,device_id,source,created_at,updated_at) VALUES(?,?,?,?,?,?)",
                     (task_id, user_id, device_id, json.dumps(source, ensure_ascii=False), now, now))
    return get(task_id)


def update(task_id, **values):
    allowed = {"status", "bytes_done", "bytes_total", "segments_done", "segments_total", "filename", "size",
               "duration", "error", "expires_at"}
    if not values or not values.keys() <= allowed:
        raise ValueError("invalid download fields")
    values["updated_at"] = time.time()
    with closing(get_conn()) as conn, conn:
        conn.execute("UPDATE download_tasks SET " + ",".join(f"{key}=?" for key in values) + " WHERE id=?",
                     (*values.values(), task_id))
