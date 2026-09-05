import json
import os
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

import cine
import database


class SearchCacheRecoveryTests(unittest.TestCase):

    def test_remove_only_the_failed_site_resource(self):
        payload = json.dumps({
            "searched": 12,
            "results": [
                {"siteKey": "site-a", "vodId": "old", "title": "影片"},
                {"siteKey": "site-a", "vodId": "new", "title": "影片"},
                {"siteKey": "site-b", "vodId": "1", "title": "影片"},
            ],
        }, ensure_ascii=False)

        updated, removed = cine._remove_cached_candidate(payload, "site-a", "old")
        data = json.loads(updated)

        self.assertTrue(removed)
        self.assertEqual(data["searched"], 12)
        self.assertEqual(
            [(m["siteKey"], m["vodId"]) for m in data["results"]],
            [("site-a", "new"), ("site-b", "1")],
        )

    def test_missing_candidate_does_not_report_removal(self):
        payload = json.dumps({"searched": 1, "results": [{"siteKey": "site-a", "vodId": "1"}]})

        updated, removed = cine._remove_cached_candidate(payload, "site-x", "9")

        self.assertFalse(removed)
        self.assertEqual(json.loads(updated), json.loads(payload))

    def test_history_migration_adds_vod_id_without_losing_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            db_path = os.path.join(tmp, "urls.db")
            conn = sqlite3.connect(db_path)
            conn.execute("""
                CREATE TABLE history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    user_id INTEGER NOT NULL,
                    subject_id TEXT NOT NULL,
                    watched_seconds REAL DEFAULT 0,
                    site_key TEXT DEFAULT '',
                    flag TEXT DEFAULT '',
                    UNIQUE (user_id, subject_id)
                )
            """)
            conn.execute(
                "INSERT INTO history (user_id, subject_id, watched_seconds, site_key, flag) VALUES (?, ?, ?, ?, ?)",
                (1, "movie-1", 321.0, "site-a", "4K"),
            )
            conn.commit()
            conn.close()

            with patch.object(database, "DB_PATH", db_path):
                database.init_db()
                migrated = database.get_conn()
                columns = {row["name"] for row in migrated.execute("PRAGMA table_info(history)")}
                row = migrated.execute(
                    "SELECT watched_seconds, site_key, vod_id, flag FROM history WHERE subject_id = ?",
                    ("movie-1",),
                ).fetchone()
                migrated.close()

            self.assertIn("vod_id", columns)
            self.assertEqual(row["watched_seconds"], 321.0)
            self.assertEqual(row["site_key"], "site-a")
            self.assertEqual(row["vod_id"], "")
            self.assertEqual(row["flag"], "4K")


if __name__ == "__main__":
    unittest.main()
