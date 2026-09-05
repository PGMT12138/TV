import unittest
from unittest.mock import patch

import probe


def line(site_key: str, duration_match: str | None, total: float,
         ad_level: str = "clean", throughput: float = 20.0) -> dict:
    return {
        "siteKey": site_key,
        "flag": "测试线路",
        "status": "ok",
        "metrics": {
            "durationMatch": duration_match,
            "adLevel": ad_level,
            "throughputMbps": throughput,
            "height": 2160,
            "scores": {"total": total},
        },
    }


class ProbeDurationRankingTests(unittest.TestCase):

    @patch.object(probe, "_site_ad_rate", return_value=0.0)
    def test_short_line_cannot_beat_normal_line(self, _mock_rate):
        normal = line("normal", "ok", 0.1, ad_level="dirty", throughput=3.0)
        short = line("short", "short", 1.0, ad_level="clean", throughput=100.0)

        self.assertIs(normal, min([short, normal], key=probe._recommendation_sort_key))

    @patch.object(probe, "_site_ad_rate", return_value=0.0)
    def test_long_line_cannot_beat_normal_line(self, _mock_rate):
        normal = line("normal", None, 0.1, throughput=3.0)
        long = line("long", "long", 1.0, throughput=100.0)

        self.assertIs(normal, min([long, normal], key=probe._recommendation_sort_key))

    def test_duration_abnormal_lines_do_not_satisfy_early_stop(self):
        self.assertFalse(probe._line_good(line("short", "short", 1.0)))
        self.assertFalse(probe._line_good(line("long", "long", 1.0)))
        self.assertTrue(probe._line_good(line("normal", "ok", 0.2)))


if __name__ == "__main__":
    unittest.main()
