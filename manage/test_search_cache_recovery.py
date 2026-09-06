import json
import os
import sqlite3
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import bridge
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


class SourceDisableCacheTests(unittest.IsolatedAsyncioTestCase):

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        db_patch = patch.object(database, "DB_PATH", os.path.join(self.tmp.name, "urls.db"))
        db_patch.start()
        self.addCleanup(db_patch.stop)
        database.init_db()
        self.vod = database.add_url(0, "VOD", "https://example.com/vod.json")
        database.record_search_sites([{"key": "site-a", "name": "站点 A"}, {"key": "site-b"}])
        self.payload = json.dumps({"results": [{"siteKey": "site-a", "vodId": "old"}], "searched": 2})
        self.seed_cache()

    def seed_cache(self):
        for device in ("device-a", "device-b"):
            for title in ("影片一", "影片二"):
                database.set_search_cache(device, title, title, self.payload, time.time(), time.time())

    def assert_cache_count(self, count):
        conn = database.get_conn()
        try:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM search_cache").fetchone()[0], count)
        finally:
            conn.close()

    async def test_disable_one_site_preserves_all_movies_and_devices_cache(self):
        result = await bridge.api_set_search_site(bridge.SiteDisableBody(site_keys=["site-a"], disabled=True))
        self.assertEqual(result, {"ok": True})
        self.assertEqual(database.get_disabled_site_keys(), {"site-a"})
        self.assert_cache_count(4)
        self.assertEqual(database.get_search_cache_generation(), 0)
        self.assertEqual(database.get_search_cache("device-a", "影片一")["results"], self.payload)

    async def test_disable_all_sites_preserves_cache(self):
        await bridge.api_set_search_site(bridge.SiteDisableBody(disabled=True))
        self.assertEqual(database.get_disabled_site_keys(), {"site-a", "site-b"})
        self.assert_cache_count(4)
        self.assertEqual(database.get_search_cache_generation(), 0)

    async def test_enable_or_unknown_sites_do_not_clear_cache(self):
        for keys, disabled in ((["site-a"], False), ([], True), (["missing"], True)):
            await bridge.api_set_search_site(bridge.SiteDisableBody(site_keys=keys, disabled=disabled))
            self.assert_cache_count(4)
        self.assertEqual(database.get_search_cache_generation(), 0)

    def test_disable_vod_config_clears_cache(self):
        source = database.add_url(0, "VOD", "https://example.com/vod.json")
        updated = database.update_url(source["id"], enabled=False)
        self.assertEqual(updated["enabled"], 0)
        self.assert_cache_count(0)
        self.assertEqual(database.get_search_cache_generation(), 1)

    def test_other_config_edits_do_not_clear_cache(self):
        vod = database.add_url(0, "VOD", "https://example.com/vod.json")
        live = database.add_url(1, "Live", "https://example.com/live.m3u")
        database.update_url(vod["id"], name="重命名", sort=2)
        database.update_url(vod["id"], enabled=True)
        database.update_url(live["id"], enabled=False)
        self.assert_cache_count(4)
        self.assertEqual(database.get_search_cache_generation(), 0)

    def test_old_generation_cannot_overwrite_new_search(self):
        generation = database.get_search_cache_generation()
        database.update_url(self.vod["id"], enabled=False)
        fresh_payload = json.dumps({"results": [], "searched": 1})
        database.set_search_cache("device-a", "影片一", "影片一", fresh_payload, 10, 10,
                                  generation=database.get_search_cache_generation())
        database.set_search_cache("device-a", "影片一", "影片一", self.payload, 20, 20,
                                  generation=generation)
        self.assertEqual(database.get_search_cache("device-a", "影片一")["results"], fresh_payload)

    async def test_inflight_json_search_cannot_refill_cleared_cache(self):
        async def search(wd):
            database.update_url(self.vod["id"], enabled=False)
            return json.loads(self.payload)

        with patch.object(cine, "active_device", return_value=SimpleNamespace(id="device-a", online=True)), \
                patch.object(cine, "_do_live_search", side_effect=search):
            await cine.resource_search("未缓存影片")
        self.assert_cache_count(0)

    async def test_inflight_stream_cannot_refill_cleared_cache(self):
        async def events(wd, preferred):
            yield {"type": "meta", "sites": 2}
            database.update_url(self.vod["id"], enabled=False)
            yield {"type": "site", "matched": [{"siteKey": "site-a", "vodId": "old", "score": 100}]}
            yield {"type": "done", "searched": 2}

        with patch.object(cine, "active_device", return_value=SimpleNamespace(id="device-a", online=True)), \
                patch.object(cine, "_live_search_events", events):
            response = await cine.resource_search_stream("未缓存影片")
            chunks = [chunk async for chunk in response.body_iterator]
        self.assertTrue(chunks)
        self.assert_cache_count(0)

    async def test_inflight_revalidation_cannot_refill_cleared_cache(self):
        async def search(wd):
            database.update_url(self.vod["id"], enabled=False)
            return {"results": [{"siteKey": "site-a", "vodId": "changed"}], "searched": 2}

        with patch.object(cine, "active_device", return_value=SimpleNamespace(id="device-a", online=True)), \
                patch.object(cine, "_do_live_search", side_effect=search):
            await cine._revalidate_search("device-a", "影片一")
        self.assert_cache_count(0)

    async def test_search_after_vod_disable_fetches_and_caches_fresh_results(self):
        database.update_url(self.vod["id"], enabled=False)
        fresh = {"results": [{"siteKey": "site-b", "vodId": "new"}], "searched": 1}
        search = AsyncMock(return_value=fresh)
        with patch.object(cine, "active_device", return_value=SimpleNamespace(id="device-a", online=True)), \
                patch.object(cine, "_do_live_search", search):
            result = await cine.resource_search("影片一")
        search.assert_awaited_once_with("影片一")
        self.assertEqual(result["results"], fresh["results"])
        self.assertEqual(json.loads(database.get_search_cache("device-a", "影片一")["results"]), fresh)


if __name__ == "__main__":
    unittest.main()
