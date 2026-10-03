import importlib.util
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("release_dates", Path(__file__).resolve().parents[1] / "counter" / "release_dates.py")
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)

T0, T1, T2, T3 = 1700000000, 1700001000, 1700002000, 1700003000


class ReleaseDateTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "opt"
        self.output = Path(self.temporary.name) / "catalog" / "updates.json"
        self.release("r0", T0)
        self.activate("r0")
        for slug in ("bagbrawl", "deadpoint"):
            self.file(f"{slug}/dist/index.html", "client")
            self.file(f"{slug}/app/server/index.js", "server")
            self.file(f"{slug}/app/src/shared.js", "shared")
            self.file(f"{slug}/app/package.json", "{}")
            self.file(f"{slug}/app/package-lock.json", "{}")
        self.file("headsup/dist/index.html", "headsup")

    def file(self, name, body, mtime=T0):
        target = self.root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(body, encoding="utf-8")
        os.utime(target, (mtime, mtime))
        return target

    def release(self, name, created, base=None, changes=None, runtime_changes=None):
        directory = self.root / "gameslop" / "releases" / name
        if base:
            shutil.copytree(self.root / "gameslop" / "releases" / base, directory)
        else:
            for slug, folder in collector.BUNDLE.items():
                self.file(f"gameslop/releases/{name}/games/{folder}/index.html", slug)
        for folder, content in (changes or {}).items():
            self.file(f"gameslop/releases/{name}/games/{folder}/index.html", content, created)
        for filename in collector.HYPERCYCLE_RUNTIME:
            if not (directory / "realtime" / filename).exists():
                self.file(f"gameslop/releases/{name}/realtime/{filename}", f"runtime:{filename}", created)
        for filename, content in (runtime_changes or {}).items():
            self.file(f"gameslop/releases/{name}/realtime/{filename}", content, created)
        games = []
        for folder in collector.BUNDLE.values():
            public = directory / "games" / folder
            records = []
            for filename in sorted(public.rglob("*")):
                if filename.is_file():
                    content = filename.read_bytes()
                    records.append({"path": filename.relative_to(public).as_posix(), "bytes": len(content), "sha256": collector.hashlib.sha256(content).hexdigest()})
            games.append({"slug": folder, "files": records})
        manifest = {"releaseId": name, "createdAt": collector.iso(created), "games": games}
        runtime = []
        for filename in collector.HYPERCYCLE_RUNTIME:
            content = (directory / "realtime" / filename).read_bytes()
            runtime.append({"path": filename, "bytes": len(content), "sha256": collector.hashlib.sha256(content).hexdigest()})
        manifest["realtime"] = {"hypercycle": {"source": "realtime", "files": runtime}}
        if base:
            manifest["baseReleaseId"] = base
        (directory / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

    def activate(self, name):
        # Copies exercise the production hash/history logic without Windows
        # symlink privileges. Pointer-race and activation timestamps are mocked.
        target = self.root / "gameslop" / "current"
        if target.exists():
            shutil.rmtree(target)
        shutil.copytree(self.root / "gameslop" / "releases" / name, target)

    def test_bootstrap_uses_game_dates_not_collector_install_time(self):
        result = collector.run(self.root, self.output, now=T3)
        self.assertEqual(set(result["lastUpdated"]), set(collector.SLUGS))
        self.assertEqual(set(result["lastUpdated"].values()), {collector.iso(T0)})
        self.assertFalse(result["errors"])
        self.assertEqual(result["source"]["headsup"]["method"], "game-file-mtime")

    def test_history_ignores_sibling_releases_and_copied_file_mtimes(self):
        self.release("r1", T1, "r0", {"grove": "grove changed"})
        self.release("r2", T2, "r1", {"pelaglyph": "pelaglyph changed"})
        self.activate("r2")
        for filename in (self.root / "gameslop/current/games").rglob("index.html"):
            os.utime(filename, (T2, T2))
        result = collector.collect(self.root, now=T3)
        self.assertEqual(result["lastUpdated"]["grove"], collector.iso(T1))
        self.assertEqual(result["lastUpdated"]["pelaglyph"], collector.iso(T2))
        self.assertEqual(result["lastUpdated"]["emberfell"], collector.iso(T0))
        self.assertEqual(result["source"]["grove"]["method"], "release-history")

    def test_reinstall_and_repeat_do_not_fake_an_update(self):
        first = collector.run(self.root, self.output, now=T1)
        before = self.output.stat().st_mtime_ns
        with patch.object(collector, "bootstrap_date", side_effect=AssertionError("History rescanned")):
            again = collector.run(self.root, self.output, now=T2)
        self.assertEqual(again, first)
        self.assertEqual(before, self.output.stat().st_mtime_ns)
        self.output.unlink()
        reinstalled = collector.run(self.root, self.output, now=T3)
        self.assertEqual(reinstalled["lastUpdated"], first["lastUpdated"])

    def test_hypercycle_first_release_stops_at_older_nine_game_manifest(self):
        original = self.root / "gameslop/releases/r0"
        shutil.rmtree(original / "games/hypercycle")
        shutil.rmtree(original / "realtime")
        manifest = json.loads((original / "manifest.json").read_text())
        manifest["games"] = [game for game in manifest["games"] if game["slug"] != "hypercycle"]
        del manifest["realtime"]
        (original / "manifest.json").write_text(json.dumps(manifest))
        self.activate("r0")
        with patch.object(collector, "SLUGS", tuple(slug for slug in collector.SLUGS if slug != "hypercycle")):
            previous = collector.collect(self.root, now=T1)
        self.release("r-hypercycle", T2, "r0", {"hypercycle": "new neon arena"})
        self.activate("r-hypercycle")
        current = collector.collect(self.root, previous, now=T3)
        self.assertEqual(current["lastUpdated"]["hypercycle"], collector.iso(T2))
        self.assertEqual(current["source"]["hypercycle"]["release"], "r-hypercycle")
        self.assertFalse(current["errors"])
        for slug in previous["lastUpdated"]:
            self.assertEqual(current["lastUpdated"][slug], previous["lastUpdated"][slug])
            self.assertEqual(current["fingerprints"][slug], previous["fingerprints"][slug])

    def test_hypercycle_server_only_release_has_its_own_update_date(self):
        self.release("r1", T1, "r0", runtime_changes={"hypercycle.mjs": "updated room server"})
        self.release("r2", T2, "r1", {"pelaglyph": "changed sandbox"})
        self.activate("r2")
        result = collector.collect(self.root, now=T3)
        self.assertEqual(result["lastUpdated"]["hypercycle"], collector.iso(T1))
        self.assertEqual(result["lastUpdated"]["pelaglyph"], collector.iso(T2))
        self.assertEqual(result["lastUpdated"]["grove"], collector.iso(T0))
        self.assertEqual(result["source"]["hypercycle"]["method"], "release-history")

    def test_hypercycle_hashes_only_the_three_fixed_runtime_files(self):
        original = collector.collect(self.root, now=T1)
        self.file("gameslop/current/realtime/unrelated.mjs", "must not affect Hypercycle", T2)
        self.assertEqual(collector.collect(self.root, original, now=T2), original)
        self.file("gameslop/current/realtime/websocket.mjs", "updated wire protocol", T2)
        changed = collector.collect(self.root, original, now=T3)
        self.assertEqual(changed["lastUpdated"]["hypercycle"], collector.iso(T3))
        self.assertNotEqual(changed["fingerprints"]["hypercycle"], original["fingerprints"]["hypercycle"])
        for slug in set(collector.SLUGS) - {"hypercycle"}:
            self.assertEqual(changed["lastUpdated"][slug], original["lastUpdated"][slug])

    def test_content_change_only_bumps_the_changed_game(self):
        first = collector.collect(self.root, now=T1)
        self.file("gameslop/current/games/grove/index.html", "new version", T2)
        second = collector.collect(self.root, first, now=T3)
        self.assertEqual(second["lastUpdated"]["grove"], collector.iso(T3))
        for slug in set(collector.SLUGS) - {"grove"}:
            self.assertEqual(second["lastUpdated"][slug], first["lastUpdated"][slug])

    def test_mtime_only_change_does_not_bump_date(self):
        first = collector.collect(self.root, now=T1)
        os.utime(self.root / "gameslop/current/games/grove/index.html", (T2, T2))
        self.assertEqual(collector.collect(self.root, first, now=T3), first)

    def test_server_and_shared_runtime_are_counted_but_secrets_and_data_are_not(self):
        first = collector.collect(self.root, now=T1)
        self.file("bagbrawl/app/server/index.js", "changed server", T2)
        self.file("deadpoint/app/src/shared.js", "changed runtime", T2)
        self.file("headsup/dist/.env", "do not read", T2)
        self.file("bagbrawl/app/data/session.json", "do not read", T2)
        second = collector.collect(self.root, first, now=T3)
        self.assertEqual(second["lastUpdated"]["bagbrawl"], collector.iso(T3))
        self.assertEqual(second["lastUpdated"]["deadpoint"], collector.iso(T3))
        self.assertEqual(second["lastUpdated"]["headsup"], first["lastUpdated"]["headsup"])

    def test_rollback_is_new_activation_not_old_content_date(self):
        first = collector.collect(self.root, now=T1)
        original = collector.snapshot_game
        self.file("gameslop/current/games/grove/index.html", "new version", T2)
        second = collector.collect(self.root, first, now=T2)
        self.file("gameslop/current/games/grove/index.html", "grove", T0)

        def rolled_back(root, slug):
            game = original(root, slug)
            if slug == "grove":
                game.update(release="rollback-r0", activation=T3 - 10)
            return game

        with patch.object(collector, "snapshot_game", side_effect=rolled_back):
            third = collector.collect(self.root, second, now=T3)
        self.assertEqual(third["lastUpdated"]["grove"], collector.iso(T3 - 10))
        self.assertEqual(third["source"]["grove"]["method"], "release-activation")

    def test_missing_or_unreadable_game_preserves_previous_state(self):
        first = collector.collect(self.root, now=T1)
        (self.root / "headsup/dist/index.html").unlink()
        second = collector.collect(self.root, first, now=T2)
        self.assertEqual(second["lastUpdated"]["headsup"], first["lastUpdated"]["headsup"])
        self.assertIn("headsup", second["errors"])
        unknown = collector.collect(self.root, now=T2)
        self.assertIsNone(unknown["lastUpdated"]["headsup"])

    def test_pointer_changes_retry_and_never_publish_mixed_state(self):
        first = collector.run(self.root, self.output, now=T1)
        with patch.object(collector, "pointer_tokens", side_effect=[[number] for number in range(6)]):
            with self.assertRaises(collector.UnstableRead):
                collector.run(self.root, self.output, now=T2)
        self.assertEqual(json.loads(self.output.read_text()), first)

    def test_missing_history_and_future_mtime_are_honestly_unknown(self):
        (self.root / "gameslop/current/manifest.json").unlink()
        os.utime(self.root / "gameslop/current/games/grove/index.html", (T3 + 100, T3 + 100))
        result = collector.collect(self.root, now=T3)
        self.assertIsNone(result["lastUpdated"]["grove"])
        self.assertEqual(result["source"]["grove"]["method"], "unknown")

    def test_nested_symlink_never_reads_an_external_file(self):
        link = self.root / "headsup/dist/external.js"
        try:
            link.symlink_to(self.file("private/secret.js", "private"))
        except (OSError, NotImplementedError):
            self.skipTest("Symlinks require privileges on this platform")
        result = collector.collect(self.root, now=T1)
        self.assertIsNone(result["fingerprints"]["headsup"])
        self.assertIn("headsup", result["errors"])

    def test_atomic_output_readable_and_dry_run_has_no_writes(self):
        collector.run(self.root, self.output, now=T1, dry_run=True)
        self.assertFalse(self.output.exists())
        collector.run(self.root, self.output, now=T1)
        self.file("headsup/dist/index.html", "updated", T2)
        collector.run(self.root, self.output, now=T3)
        self.assertEqual(list(self.output.parent.glob(".updates-*")), [])
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(self.output.stat().st_mode), 0o644)
            self.assertEqual(stat.S_IMODE(self.output.parent.stat().st_mode), 0o755)

    def test_concurrent_runs_cannot_overwrite_newer_observations(self):
        first = collector.run(self.root, self.output, now=T1)
        self.file("headsup/dist/index.html", "new version", T2)
        with collector.state_lock(self.output):
            with self.assertRaises(collector.CollectorBusy):
                collector.run(self.root, self.output, now=T3)
        self.assertEqual(json.loads(self.output.read_text()), first)
        second = collector.run(self.root, self.output, now=T3)
        self.assertEqual(second["lastUpdated"]["headsup"], collector.iso(T3))


if __name__ == "__main__":
    unittest.main()
