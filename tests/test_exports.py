import importlib.util
from contextlib import closing
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "counter" / "export_counts.py"
spec = importlib.util.spec_from_file_location("export_counts", SCRIPT)
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)


class ExportTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name).resolve()
        self.db = self.root / "actual plays.sqlite3"
        self.output = self.root / "exports"
        self.now = datetime(2026, 1, 31, 23, 45, tzinfo=timezone.utc)
        self.counts = {slug: index * 17 for index, slug in enumerate(exporter.SLUGS)}
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute("CREATE TABLE plays (slug TEXT PRIMARY KEY, count INTEGER NOT NULL)")
            connection.executemany("INSERT INTO plays VALUES (?, ?)", self.counts.items())
            connection.commit()

    def tearDown(self):
        self.temporary.cleanup()

    def export(self, **kwargs):
        return exporter.export_counts(self.db, self.output, now=kwargs.pop("now", self.now), **kwargs)

    def test_exports_actual_database_without_writing_back(self):
        before = hashlib.sha256(self.db.read_bytes()).hexdigest()
        path = self.export()
        data = json.loads(path.read_text(encoding="utf-8"))
        self.assertEqual(data, {"exported_at": "2026-01-31T23:45:00Z", "counts": self.counts})
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), before)
        self.assertEqual(list(self.output.glob("*.json")), [path])
        self.assertEqual(list(self.output.glob("*.tmp")), [])
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)

    def test_interval_is_exactly_72_hours_across_month_boundary_and_keeps_history(self):
        first = self.export()
        self.assertIsNone(self.export(now=self.now + timedelta(hours=71, minutes=59, seconds=59)))
        second = self.export(now=self.now + timedelta(hours=72))
        self.assertNotEqual(first, second)
        self.assertEqual(json.loads(second.read_text())["exported_at"], "2026-02-03T23:45:00Z")
        self.assertTrue(first.exists())
        self.assertEqual(len(list(self.output.glob("*.json"))), 2)
        # The successful file itself is the durable state; no marker update is needed.
        self.assertIsNone(self.export(now=self.now + timedelta(hours=73)))
        self.assertIsNone(self.export(now=self.now - timedelta(hours=1)))

    def test_force_exports_early_but_same_timestamp_cannot_duplicate(self):
        self.export()
        self.assertIsNone(self.export(force=True))
        path = self.export(force=True, now=self.now + timedelta(seconds=1))
        self.assertIsNotNone(path)
        self.assertEqual(len(list(self.output.glob("*.json"))), 2)

    def test_missing_invalid_or_incomplete_database_never_creates_an_export(self):
        missing = self.root / "missing.sqlite3"
        with self.assertRaises(sqlite3.Error):
            exporter.export_counts(missing, self.output, now=self.now)
        self.assertFalse(missing.exists())
        for value in [-1, "invalid"]:
            with closing(sqlite3.connect(self.db)) as connection:
                connection.execute("UPDATE plays SET count=? WHERE slug='grove'", (value,))
                connection.commit()
            with self.assertRaises(ValueError):
                self.export()
        with closing(sqlite3.connect(self.db)) as connection:
            connection.execute("DELETE FROM plays WHERE slug='grove'")
            connection.commit()
        with self.assertRaises(ValueError):
            self.export()
        self.assertEqual(list(self.output.glob("*.json")), [])

    def test_failed_atomic_publish_does_not_advance_the_schedule(self):
        first = self.export()
        due = self.now + timedelta(hours=72)
        with patch.object(exporter.os, "replace", side_effect=OSError("simulated publish failure")):
            with self.assertRaises(OSError):
                self.export(now=due)
        self.assertEqual(list(self.output.glob("*.json")), [first])
        self.assertEqual(list(self.output.glob("*.tmp")), [])
        self.assertIsNotNone(self.export(now=due))
        self.assertEqual(len(list(self.output.glob("*.json"))), 2)

    def test_concurrent_exporter_skips_when_output_lock_is_held(self):
        self.output.mkdir()
        with exporter.output_lock(self.output) as locked:
            self.assertTrue(locked)
            result = subprocess.run([sys.executable, "-I", str(SCRIPT), "--db", str(self.db), "--output", str(self.output)], capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("another exporter", result.stdout)
        self.assertEqual(list(self.output.glob("*.json")), [])

    def test_isolated_cli_succeeds_and_missing_database_fails_nonzero(self):
        command = [sys.executable, "-I", str(SCRIPT), "--db", str(self.db), "--output", str(self.output), "--force"]
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(next(self.output.glob("*.json")).read_text())["counts"], self.counts)
        command[command.index("--db") + 1] = str(self.root / "missing.sqlite3")
        result = subprocess.run(command, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("export failed", result.stderr)
        self.assertEqual(len(list(self.output.glob("*.json"))), 1)


if __name__ == "__main__":
    unittest.main()
