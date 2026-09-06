import os
import tempfile
import unittest
from unittest.mock import patch

import database
import probe


class ProbeScheduleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        db_patch = patch.object(database, "DB_PATH", os.path.join(tmp.name, "stats.db"))
        db_patch.start()
        self.addCleanup(db_patch.stop)
        database.init_db()

    def duration(self, site, flag, *durations):
        for duration in durations:
            database.record_site_probe_duration({"key": site, "name": site}, duration, flag=flag)

    async def scan(self, flags_by_site, *, cap=10, fill=0, per_site=8, fresh=False):
        calls = []

        async def detail(action, params, timeout):
            self.assertEqual(action, "detail")
            return {"flags": [{"flag": f, "episodes": [{"url": "episode"}]} for f in flags_by_site[params["key"]]]}

        async def candidate(cand, ref_s=None):
            calls.append((cand["siteKey"], cand["flag"]))
            return probe._fail(cand, "测试无可用线路")

        task = probe.ScanTask()
        with patch.object(probe, "_call_device_wait", detail), \
                patch.object(probe, "probe_candidate", candidate), \
                patch.object(probe, "_site_prior", return_value=0.5), \
                patch.object(probe, "DETAIL_CONCURRENCY", 1), \
                patch.object(probe, "PROBE_CONCURRENCY", 1), \
                patch.object(probe, "PRIORITY_LINES_CAP", cap), \
                patch.object(probe, "PRIORITY_FILL_MIN", fill), \
                patch.object(probe, "FLAGS_PER_SITE", per_site):
            await probe._run_scan(task, [{"key": key, "id": "movie", "name": key} for key in flags_by_site], fresh=fresh)
        self.assertTrue(task.done)
        self.assertNotIn("error", task.events[-1])
        results = [ev["result"] for ev in task.events if ev["type"] == "result"]
        return calls, results

    def test_line_averages_are_isolated_by_site_and_flag_and_survive_init(self):
        self.duration("a", "线路", 100, 300)
        self.duration("a", "另一线路", 50)
        self.duration("b", "线路", 900)
        database.init_db()
        self.assertEqual(database.get_line_probe_averages(["a"]), {("a", "线路"): 200, ("a", "另一线路"): 50})
        self.assertEqual(database.get_line_probe_averages(["b"]), {("b", "线路"): 900})
        self.assertEqual(database.get_line_probe_averages([]), {})
        conn = database.get_conn()
        try:
            row = conn.execute("SELECT * FROM line_probe_stats WHERE site_key='a' AND flag='线路'").fetchone()
            self.assertEqual(row["probe_count"], 2)
            self.assertEqual(row["last_duration_ms"], 300)
            self.assertGreater(row["last_probed_at"], 0)
        finally:
            conn.close()

    async def test_both_batches_start_shorter_lines_first_across_sites(self):
        for site, flag, duration in [("b", "4K慢", 400), ("b", "4K快", 100), ("c", "4K中", 200),
                                     ("b", "普通慢", 900), ("b", "普通快", 50), ("c", "普通中", 100)]:
            self.duration(site, flag, duration)
        for fresh in (False, True):
            calls, results = await self.scan({"first": ["4K首条"], "b": ["4K慢", "4K快", "普通慢", "普通快"],
                                              "c": ["4K中", "普通中"]}, fresh=fresh)
            self.assertEqual(calls, [("first", "4K首条"), ("b", "4K快"), ("c", "4K中"), ("b", "4K慢"),
                                     ("b", "普通快"), ("c", "普通中"), ("b", "普通慢")])
            self.assertEqual([r["prio"] for r in results], [True] * 4 + [False] * 3)

    async def test_early_probe_uses_fastest_line_of_available_site(self):
        self.duration("a", "4K慢", 3000)
        self.duration("a", "4K快", 100)
        calls, _ = await self.scan({"a": ["4K慢", "4K快"]})
        self.assertEqual(calls, [("a", "4K快"), ("a", "4K慢")])

    async def test_caps_are_applied_after_duration_sorting(self):
        for site, flag, duration in [("b", "4K慢", 800), ("c", "4K快", 100),
                                     ("b", "普通慢", 1000), ("b", "普通中", 500), ("b", "普通快", 50)]:
            self.duration(site, flag, duration)
        calls, results = await self.scan({"first": ["4K首条"], "b": ["4K慢", "普通慢", "普通中", "普通快"],
                                          "c": ["4K快"]}, cap=2, per_site=2)
        self.assertEqual(calls, [("first", "4K首条"), ("c", "4K快"), ("b", "普通快"), ("b", "普通中")])
        self.assertEqual(sum(r["prio"] for r in results), 2)

    async def test_promoted_normal_lines_are_resorted_with_priority_lines(self):
        for flag, duration in [("4K慢", 500), ("普通快", 100), ("普通中", 200), ("普通慢", 900)]:
            self.duration("b", flag, duration)
        calls, results = await self.scan({"first": ["4K首条"], "b": ["4K慢", "普通慢", "普通中", "普通快"]},
                                         cap=4, fill=3)
        self.assertEqual(calls, [("first", "4K首条"), ("b", "普通快"), ("b", "普通中"), ("b", "4K慢"), ("b", "普通慢")])
        self.assertEqual([r["prio"] for r in results], [True] * 4 + [False])

    async def test_unknown_last_zero_valid_and_ties_stable(self):
        self.duration("b", "零耗时", 0)
        self.duration("b", "同耗时甲", 100)
        self.duration("b", "同耗时乙", 100)
        calls, _ = await self.scan({"first": ["4K首条"], "b": ["未知甲", "同耗时乙", "零耗时", "同耗时甲", "未知乙"]})
        self.assertEqual([flag for _, flag in calls[1:]], ["零耗时", "同耗时乙", "同耗时甲", "未知甲", "未知乙"])


if __name__ == "__main__":
    unittest.main()
