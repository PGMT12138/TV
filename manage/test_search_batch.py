import asyncio
import unittest
from unittest.mock import patch

import bridge
import cine


class SearchEventMappingTest(unittest.IsolatedAsyncioTestCase):

    async def test_app_batch_events_are_mapped_to_cine_events(self):
        captured = {}

        async def app_events(action, params):
            captured["action"] = action
            captured["params"] = params
            yield {
                "type": "meta",
                "sites": 1,
                "availableSites": [{"key": "demo", "name": "演示站"}],
            }
            yield {
                "type": "site",
                "siteKey": "demo",
                "siteName": "演示站",
                "data": {"list": [{"id": "1", "name": "星际穿越"}]},
            }
            yield {"type": "done", "searched": 1}

        recorded = []
        with (
            patch.object(cine, "stream_device_events", app_events),
            patch.object(cine.database, "get_disabled_site_keys", return_value={"disabled"}),
            patch.object(cine.database, "record_search_sites", side_effect=recorded.append),
            patch.object(cine.database, "record_search_site_result"),
        ):
            events = [event async for event in cine._live_search_events("星际穿越", "demo")]

        self.assertEqual("searchAll", captured["action"])
        self.assertEqual(False, captured["params"]["quick"])
        self.assertEqual("demo", captured["params"]["preferred"])
        self.assertEqual(["disabled"], captured["params"]["disabled"])
        self.assertEqual([[{"key": "demo", "name": "演示站"}]], recorded)
        self.assertEqual("meta", events[0]["type"])
        self.assertEqual("demo", events[1]["matched"][0]["siteKey"])
        self.assertEqual(100, events[1]["matched"][0]["score"])
        self.assertEqual({"type": "done", "searched": 1}, events[2])

    async def test_unknown_search_all_falls_back_to_legacy_search(self):
        async def unsupported(action, params):
            if False:
                yield None
            raise RuntimeError("unknown action searchAll")

        async def legacy(wd, preferred):
            yield {"type": "meta", "sites": 2}
            yield {"type": "done", "searched": 2}

        with (
            patch.object(cine, "stream_device_events", unsupported),
            patch.object(cine, "_legacy_search_events", legacy),
            patch.object(cine.database, "get_disabled_site_keys", return_value=set()),
        ):
            events = [event async for event in cine._live_search_events("关键词")]

        self.assertEqual([
            {"type": "meta", "sites": 2},
            {"type": "done", "searched": 2},
        ], events)


class DeviceEventStreamTest(unittest.IsolatedAsyncioTestCase):

    async def test_one_command_carries_multiple_events(self):
        device = bridge.Device("test-device")

        class FakeWebSocket:
            def __init__(self):
                self.sent = []

            async def send_json(self, message):
                self.sent.append(message)
                if message["action"] == "searchAll":
                    rid = message["id"]
                    asyncio.get_running_loop().call_soon(
                        bridge._on_device_text, device, {"id": rid, "type": "meta", "sites": 1}
                    )
                    asyncio.get_running_loop().call_soon(
                        bridge._on_device_text, device, {"id": rid, "type": "site", "siteKey": "demo"}
                    )
                    asyncio.get_running_loop().call_soon(
                        bridge._on_device_text, device, {"id": rid, "type": "done", "searched": 1}
                    )

        socket = FakeWebSocket()
        device.ws = socket
        with patch.object(bridge, "active_device", return_value=device):
            events = [event async for event in bridge.stream_device_events("searchAll", {"wd": "测试"})]

        self.assertEqual(["meta", "site", "done"], [event["type"] for event in events])
        self.assertEqual(1, len(socket.sent))
        self.assertEqual("searchAll", socket.sent[0]["action"])
        self.assertEqual({}, device.events)

    async def test_closing_consumer_sends_cancel_search(self):
        device = bridge.Device("test-device")

        class FakeWebSocket:
            def __init__(self):
                self.sent = []

            async def send_json(self, message):
                self.sent.append(message)
                if message["action"] == "searchAll":
                    rid = message["id"]
                    asyncio.get_running_loop().call_soon(
                        bridge._on_device_text, device, {"id": rid, "type": "meta", "sites": 1}
                    )

        socket = FakeWebSocket()
        device.ws = socket
        with patch.object(bridge, "active_device", return_value=device):
            events = bridge.stream_device_events("searchAll", {"wd": "测试"})
            self.assertEqual("meta", (await anext(events))["type"])
            await events.aclose()

        self.assertEqual(["searchAll", "cancelSearch"], [item["action"] for item in socket.sent])
        self.assertEqual(socket.sent[0]["id"], socket.sent[1]["params"]["searchId"])
        self.assertEqual({}, device.events)


if __name__ == "__main__":
    unittest.main()
