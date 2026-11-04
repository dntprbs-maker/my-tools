import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("collector", Path(__file__).parent / "collector/collector.py")
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)


def window(seconds, used=11):
    return {"limit_window_seconds": seconds, "used_percent": used, "reset_at": 1794300556}


class WindowsTests(unittest.TestCase):
    def test_primary_weekly_only(self):
        r = c.codex_windows({"primary_window": window(604800)})
        self.assertEqual(r["weekly"]["used_percent"], 11)
        self.assertIsNone(r["five_hour"]["used_percent"])
        self.assertIsNone(r["five_hour"]["reset_at"])

    def test_both_orders(self):
        for first, second in ((18000, 604800), (604800, 18000)):
            r = c.codex_windows({"primary_window": window(first), "secondary_window": window(second)})
            self.assertEqual(r["five_hour"]["window_seconds"], 18000)
            self.assertEqual(r["weekly"]["window_seconds"], 604800)

    def test_unknown_duration(self):
        for seconds in (None, 3600, "604800"):
            r = c.codex_windows({"primary_window": window(seconds)})
            self.assertIsNone(r["five_hour"]["used_percent"])
            self.assertIsNone(r["weekly"]["used_percent"])
            self.assertEqual(r["weekly"]["status"], "unknown_duration")

    def test_missing_window_reset(self):
        w = window(604800) | {"reset_at": None}
        r = c.codex_windows({"primary_window": None, "secondary_window": w})
        self.assertEqual(r["weekly"]["used_percent"], 11)
        self.assertIsNone(r["weekly"]["reset_at"])

    def test_duplicate_conflict(self):
        r = c.codex_windows({"primary_window": window(604800), "secondary_window": window(604800, 12)})
        self.assertEqual(r["weekly"]["status"], "conflict")
        self.assertIsNone(r["weekly"]["used_percent"])

    def test_legacy_cache(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder) / "usage.json"
            p.write_text(json.dumps({"codex": {"five_hour": {"used_percent": 11}, "status": {"state": "rate_limited"}}, "claude": {"weekly": {"used_percent": 25}}}))
            with patch.object(c, "USAGE_FILE", p):
                r = c.load_usage()
            self.assertIsNone(r["codex"]["five_hour"]["used_percent"])
            self.assertEqual(r["codex"]["status"]["state"], "rate_limited")
            self.assertEqual(r["claude"]["weekly"]["used_percent"], 25)

    def test_saved_mapping_survives_failed_refresh(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(c, "USAGE_FILE", Path(folder) / "usage.json"):
            value = c.codex_windows({"primary_window": window(604800)}) | {"plan": "test", "auth_refreshed": False}
            with patch.dict(c.FETCHERS, {"codex": lambda: value}):
                c.refresh_all(["codex"])
            self.assertEqual(c.load_usage()["codex"]["window_schema"], 2)
            def fail():
                raise c.FetchError("network", "test")
            with patch.dict(c.FETCHERS, {"codex": fail}):
                r = c.refresh_all(["codex"])
            self.assertEqual(r["codex"]["weekly"]["used_percent"], 11)
            self.assertIsNone(r["codex"]["five_hour"]["used_percent"])


if __name__ == "__main__":
    unittest.main()
