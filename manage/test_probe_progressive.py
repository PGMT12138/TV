import asyncio
import unittest
from unittest.mock import patch

import probe


class ProbeProgressiveTests(unittest.IsolatedAsyncioTestCase):

    async def test_first_probe_result_does_not_wait_for_all_site_details(self):
        release_slow = asyncio.Event()
        slow_detail_started = asyncio.Event()

        async def fake_call(action, params, timeout):
            self.assertEqual(action, "detail")
            if params["key"] == "preferred":
                return {"flags": [{"flag": "4K", "episodes": [{"url": "episode-1"}]}]}
            slow_detail_started.set()
            await release_slow.wait()
            return {"flags": []}

        async def fake_probe(cand, ref_s=None):
            return {
                "siteKey": cand["siteKey"], "siteName": cand["siteName"],
                "vodId": cand["vodId"], "flag": cand["flag"],
                "status": "ok", "metrics": {
                    "adLevel": "clean", "throughputMbps": 10.0,
                    "height": 2160, "bitrateKbps": None,
                    "scores": {"total": 1.0},
                },
            }

        matches = [
            {"key": "preferred", "id": "1", "name": "历史来源"},
            {"key": "slow-a", "id": "2", "name": "慢站点 A"},
            {"key": "slow-b", "id": "3", "name": "慢站点 B"},
        ]
        task = probe.ScanTask()
        with patch.object(probe, "_call_device_wait", side_effect=fake_call), \
                patch.object(probe, "probe_candidate", side_effect=fake_probe), \
                patch.object(probe, "_site_prior", return_value=None):
            runner = asyncio.create_task(probe._run_scan(task, matches))
            await asyncio.wait_for(slow_detail_started.wait(), timeout=1)

            async def wait_first_result():
                while not any(e.get("type") == "result" and e.get("result", {}).get("flag") for e in task.events):
                    await asyncio.sleep(0.01)

            await asyncio.wait_for(wait_first_result(), timeout=1)
            self.assertFalse(release_slow.is_set(), "首条结果不应等待慢站点详情结束")
            first = next(e["result"] for e in task.events if e.get("type") == "result" and e["result"].get("flag"))
            self.assertEqual(first["siteKey"], "preferred")

            release_slow.set()
            await asyncio.wait_for(runner, timeout=1)
            self.assertTrue(task.done)
            self.assertEqual(task.events[-1]["type"], "done")


if __name__ == "__main__":
    unittest.main()
