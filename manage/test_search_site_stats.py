import asyncio
import json
import os
import tempfile
import time
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

import cine
import database
import probe


class SearchSiteStatsTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_patch = patch.object(database, "DB_PATH", os.path.join(tmp.name, "stats.db"))
        db_patch.start()
        self.addCleanup(db_patch.stop)
        database.init_db()
        self.site = {"key": "demo", "name": "演示站"}

    def stats(self, key="demo"):
        return next(s for s in database.list_search_sites() if s["site_key"] == key)

    def test_migration_keeps_disabled_and_does_not_use_old_registration_count(self):
        conn = database.get_conn()
        conn.execute("DROP TABLE search_sites")
        conn.execute("CREATE TABLE search_sites (site_key TEXT PRIMARY KEY, site_name TEXT, "
                     "search_count INTEGER, last_searched_at TEXT, disabled INTEGER)")
        conn.execute("INSERT INTO search_sites VALUES ('demo', '演示站', 100, '', 1)")
        conn.execute("ALTER TABLE search_sites ADD COLUMN duration_count INTEGER DEFAULT 10")
        conn.execute("ALTER TABLE search_sites ADD COLUMN total_duration_ms REAL DEFAULT 50000")
        conn.commit()
        conn.close()
        database.init_db()
        database.init_db()
        row = self.stats()
        self.assertEqual(row["disabled"], 1)
        self.assertEqual(row["search_count"], 100)
        self.assertIsNone(row["success_rate"])
        self.assertIsNone(row["avg_probe_duration_ms"])
        database.record_search_site_result(self.site, True)
        self.assertEqual(self.stats()["success_rate"], 100)

    def test_search_success_and_probe_duration_are_independent(self):
        database.record_search_site_result(self.site, True)
        database.record_search_site_result(self.site, False)
        database.record_search_site_result(self.site, True)
        self.assertIsNone(self.stats()["avg_probe_duration_ms"])
        database.record_site_probe_duration(self.site, 1000)
        database.record_site_probe_duration(self.site, 3000)
        row = self.stats()
        self.assertEqual(row["completed_count"], 3)
        self.assertEqual(row["success_count"], 2)
        self.assertAlmostEqual(row["success_rate"], 200 / 3)
        self.assertEqual(row["probe_count"], 2)
        self.assertEqual(row["avg_probe_duration_ms"], 2000)

    def test_invalid_duration_is_not_zero_but_zero_duration_is_valid(self):
        database.record_search_sites([self.site])
        for duration in (None, -1, "100", float("nan"), float("inf"), True):
            database.record_site_probe_duration(self.site, duration)
        self.assertIsNone(self.stats()["avg_probe_duration_ms"])
        database.record_site_probe_duration(self.site, 0)
        self.assertEqual(self.stats()["avg_probe_duration_ms"], 0)
        self.assertEqual(self.stats()["probe_count"], 1)
        self.assertIsNone(self.stats()["success_rate"])

    def test_registration_and_disable_preserve_stats_and_cache(self):
        database.record_search_site_result(self.site, True)
        database.set_search_cache("device", "movie", "movie", "{}", 1, 1)
        database.set_search_site_disabled(["demo"], True)
        database.record_site_probe_duration(self.site, 123)
        before = self.stats()
        database.record_search_sites([self.site, {"key": "new", "name": "新站"}])
        self.assertEqual(self.stats(), before)
        self.assertEqual(self.stats("new")["completed_count"], 0)
        self.assertIsNotNone(database.get_search_cache("device", "movie"))

    def test_netdisk_name_detection_matches_cine_rule(self):
        database.record_search_sites([self.site, {"key": "pan", "name": "夸克影视"}])
        self.assertFalse(self.stats()["is_netdisk"])
        self.assertTrue(self.stats("pan")["is_netdisk"])

    async def test_batch_counts_matches_empty_unrelated_and_errors(self):
        async def events(action, params):
            yield {"type": "meta", "sites": 5, "availableSites": [self.site]}
            for data, error in (
                ({"list": [{"id": "1", "name": "星际穿越"}]}, None),
                ({"list": []}, None),
                ({"list": [{"id": "2", "name": "另一部电影"}]}, None),
                ({"list": []}, "timeout"),
                ({"list": [{"id": "1", "name": "星际穿越"}]}, None),
            ):
                yield {"type": "site", "siteKey": "demo", "siteName": "演示站",
                       "data": data, "error": error}
            yield {"type": "done", "searched": 5}

        with patch.object(cine, "stream_device_events", events):
            received = [ev async for ev in cine._live_search_events("星际穿越")]
        row = self.stats()
        self.assertEqual(len(received), 7)
        self.assertEqual(row["success_rate"], 40)
        self.assertIsNone(row["avg_probe_duration_ms"])
        self.assertEqual(row["probe_count"], 0)

    async def test_legacy_records_success_timeout_and_excludes_cancelled_request(self):
        with patch.object(cine, "call_device", AsyncMock(return_value={"list": [{"name": "影片"}]})):
            await cine._search_one(self.site, "影片", asyncio.Semaphore(1))
        with patch.object(cine, "call_device", AsyncMock(side_effect=RuntimeError("timeout"))):
            await cine._search_one(self.site, "影片", asyncio.Semaphore(1))
        with patch.object(cine, "call_device", AsyncMock(side_effect=asyncio.CancelledError())):
            with self.assertRaises(asyncio.CancelledError):
                await cine._search_one(self.site, "影片", asyncio.Semaphore(1))
        row = self.stats()
        self.assertEqual(row["success_rate"], 50)
        self.assertEqual(row["completed_count"], 2)
        self.assertEqual(row["probe_count"], 0)
        self.assertIsNone(row["avg_probe_duration_ms"])

    async def test_cache_hits_do_not_count_and_disabled_site_is_filtered(self):
        database.record_search_site_result(self.site, True)
        database.set_search_site_disabled(["demo"], True)
        before = self.stats()
        now = time.time()
        database.set_search_cache("device", "影片", "影片", json.dumps({
            "results": [{"siteKey": "demo", "vodId": "1"}], "searched": 1,
        }), now, now)
        with patch.object(cine, "active_device", return_value=SimpleNamespace(id="device", online=True)):
            result = await cine.resource_search("影片")
            response = await cine.resource_search_stream("影片")
            events = [json.loads(chunk.removeprefix("data: ")) async for chunk in response.body_iterator]
        self.assertEqual(result["results"], [])
        self.assertTrue(events[-1]["cached"])
        self.assertEqual(self.stats(), before)


    async def test_probe_measures_player_fetch_and_media_analysis(self):
        cand = {"siteKey": "demo", "siteName": "演示站", "vodId": "1", "flag": "线路", "episodeId": "ep"}
        clock = [10.0]

        async def player(*args, **kwargs):
            clock[0] += 2
            return {"url": "https://example.com/video.mp4"}

        async def fetch(*args, **kwargs):
            clock[0] += 3
            return {"status": 200, "data": b"video", "ctype": "video/mp4", "ttfb": 0.1, "redirects": []}

        async def media(*args, **kwargs):
            clock[0] += 3
            return {"status": "ok", "siteKey": "demo"}

        with patch.object(probe, "time", SimpleNamespace(monotonic=lambda: clock[0], time=time.time)), \
                patch.object(probe, "_call_device_wait", player), \
                patch.object(probe, "_fetch", fetch), \
                patch.object(probe, "_probe_file", media):
            result = await probe.probe_candidate(cand)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(self.stats()["probe_count"], 1)
        self.assertEqual(self.stats()["avg_probe_duration_ms"], 8000)
        self.assertEqual(database.get_line_probe_averages(["demo"]), {("demo", "线路"): 8000})
        self.assertEqual(self.stats()["completed_count"], 0)
        self.assertEqual(self.stats()["probe_success_count"], 1)
        self.assertEqual(self.stats()["probe_result_count"], 1)
        self.assertEqual(self.stats()["probe_success_rate"], 100)

    async def test_failed_and_timed_out_probes_contribute_but_cancelled_does_not(self):
        cand = {"siteKey": "demo", "siteName": "演示站", "vodId": "1", "flag": "线路", "episodeId": "ep"}
        clock = [10.0]

        async def timeout(*args, **kwargs):
            clock[0] += 25
            raise TimeoutError("超时")

        async def empty(*args, **kwargs):
            clock[0] += 1
            return {"url": ""}

        with patch.object(probe, "time", SimpleNamespace(monotonic=lambda: clock[0], time=time.time)):
            for fn in (timeout, empty):
                with patch.object(probe, "_call_device_wait", fn):
                    result = await probe.probe_candidate(cand)
                    self.assertEqual(result["status"], "fail")
            with patch.object(probe, "_call_device_wait", AsyncMock(side_effect=asyncio.CancelledError())):
                with self.assertRaises(asyncio.CancelledError):
                    await probe.probe_candidate(cand)
        self.assertEqual(self.stats()["probe_count"], 2)
        self.assertEqual(self.stats()["avg_probe_duration_ms"], 13000)
        self.assertEqual(database.get_line_probe_averages(["demo"]), {("demo", "线路"): 13000})
        self.assertIsNone(self.stats()["success_rate"])
        self.assertEqual(self.stats()["probe_result_count"], 2)
        self.assertEqual(self.stats()["probe_success_rate"], 0)

    def test_probe_success_rate_weights_completed_attempts_and_isolates_sites(self):
        database.record_search_site_result(self.site, True)
        database.set_search_site_disabled(["demo"], True)
        database.record_site_probe_duration(self.site, 100, flag="线路A", success=True)
        for _ in range(3):
            database.record_site_probe_duration(self.site, 200, flag="线路B", success=False)
        database.record_site_probe_duration({"key": "other"}, 300, flag="线路A", success=True)
        row = self.stats()
        self.assertEqual(row["probe_success_rate"], 25)
        self.assertEqual(row["probe_success_count"], 1)
        self.assertEqual(row["probe_result_count"], 4)
        self.assertEqual(row["success_rate"], 100)
        self.assertEqual(row["avg_probe_duration_ms"], 175)
        self.assertEqual(row["disabled"], 1)
        self.assertEqual(self.stats("other")["probe_success_rate"], 100)
        database.init_db()
        self.assertEqual(self.stats(), row)
        conn = database.get_conn()
        try:
            lines = conn.execute("SELECT flag, result_count, success_count FROM line_probe_stats WHERE site_key='demo' ORDER BY flag").fetchall()
        finally:
            conn.close()
        self.assertEqual([tuple(line) for line in lines], [("线路A", 1, 1), ("线路B", 3, 0)])

    def test_probe_result_migration_does_not_treat_old_durations_as_failures(self):
        database.record_search_sites([self.site])
        conn = database.get_conn()
        conn.execute("DROP TABLE line_probe_stats")
        conn.execute("CREATE TABLE line_probe_stats (site_key TEXT, flag TEXT, probe_count INTEGER, "
                     "total_duration_ms REAL, last_duration_ms REAL, last_probed_at REAL, PRIMARY KEY(site_key, flag))")
        conn.execute("INSERT INTO line_probe_stats VALUES ('demo', '旧线路', 100, 50000, 500, 1)")
        conn.commit()
        conn.close()
        database.init_db()
        database.init_db()
        self.assertIsNone(self.stats()["probe_success_rate"])
        self.assertEqual(self.stats()["probe_result_count"], 0)
        database.record_site_probe_duration(self.site, 500, flag="旧线路", success=True)
        self.assertEqual(self.stats()["probe_success_rate"], 100)
        self.assertEqual(self.stats()["probe_result_count"], 1)
        self.assertEqual(database.get_line_probe_averages(["demo"]), {("demo", "旧线路"): 500})

    def test_duration_only_samples_do_not_enter_success_rate(self):
        database.record_site_probe_duration(self.site, 500, flag="线路")
        self.assertIsNone(self.stats()["probe_success_rate"])
        database.record_site_probe_duration(self.site, 500, flag="线路", success=False)
        self.assertEqual(self.stats()["probe_result_count"], 1)
        self.assertEqual(self.stats()["probe_success_rate"], 0)

    async def test_unexpected_probe_error_is_counted_once_as_failure(self):
        cand = {"siteKey": "demo", "siteName": "演示站", "flag": "线路"}
        with patch.object(probe, "_probe_candidate", AsyncMock(side_effect=RuntimeError("unexpected"))):
            with self.assertRaises(RuntimeError):
                await probe.probe_candidate(cand)
        self.assertEqual(self.stats()["probe_result_count"], 1)
        self.assertEqual(self.stats()["probe_success_rate"], 0)

    async def test_probe_statistics_failure_does_not_break_playback(self):
        cand = {"siteKey": "demo", "siteName": "演示站"}
        with patch.object(probe, "_probe_candidate", AsyncMock(return_value={"status": "ok"})), \
                patch.object(probe, "record_site_probe_duration", side_effect=RuntimeError("数据库忙")):
            self.assertEqual(await probe.probe_candidate(cand), {"status": "ok"})


if __name__ == "__main__":
    unittest.main()
