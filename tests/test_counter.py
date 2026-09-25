"""Exercise the counter through real HTTP connections and persistent SQLite."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import http.client
import json
import os
from pathlib import Path
from queue import Queue, Empty
import socket
import sqlite3
import subprocess
import sys
import tempfile
from threading import Thread
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
SERVER = ROOT / "counter" / "server.py"
SLUGS = (
    "primordial", "primordial-tactics", "bagbrawl", "deadpoint", "headsup",
    "grove", "emberwild", "emberfell", "pelaglyph",
)
SEEDS = {slug: {"deadpoint": 225, "bagbrawl": 30, "primordial": 10}.get(slug, 0) for slug in SLUGS}
ORIGIN = "https://gameslop.now"


class RunningServer:
    def __init__(self, db, site_root=None):
        command = [sys.executable, str(SERVER), "--port", "0", "--db", str(db)]
        if site_root is not None:
            command += ["--site-root", str(site_root)]
        self.process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        queue = Queue()
        Thread(target=lambda: queue.put(self.process.stdout.readline()), daemon=True).start()
        try:
            line = queue.get(timeout=10)
            if not line.startswith("Listening on http://127.0.0.1:"):
                raise AssertionError("Counter failed to start: " + line)
            self.port = int(line.strip().rsplit(":", 1)[1])
        except (Empty, ValueError, AssertionError):
            self.close()
            raise

    def close(self):
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=5)
                raise AssertionError("Counter did not stop")
        self.process.stdout.close()
        self.process.stderr.close()

    def request(self, method="GET", path="/api/plays", headers=None, body=None):
        connection = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            connection.request(method, path, body=body, headers=headers or {})
            response = connection.getresponse()
            return response.status, dict(response.getheaders()), response.read()
        finally:
            connection.close()

    def raw(self, request):
        with socket.create_connection(("127.0.0.1", self.port), timeout=15) as connection:
            connection.sendall(request)
            response = http.client.HTTPResponse(connection)
            response.begin()
            return response.status, dict(response.getheaders()), response.read()


class CounterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.db = self.root / "state" / "plays.sqlite3"
        self.server = RunningServer(self.db)

    def tearDown(self):
        self.server.close()
        self.temporary.cleanup()

    def counts(self):
        status, headers, body = self.server.request()
        self.assertEqual(status, 200)
        self.assertIn("application/json", headers["Content-Type"])
        self.assertIn("no-store", headers["Cache-Control"])
        self.assertEqual(headers["Vary"], "Origin")
        return json.loads(body)["counts"]

    def increment(self, slug="primordial", origin=ORIGIN):
        return self.server.request("POST", "/api/plays/" + slug, headers={"Origin": origin})

    def test_seeds_and_no_mutation_from_reads_or_head(self):
        self.assertEqual(self.counts(), SEEDS)
        self.assertEqual(self.counts(), SEEDS)
        status, headers, body = self.server.request("HEAD")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"")
        self.assertGreater(int(headers["Content-Length"]), 0)
        self.assertEqual(self.server.request(path="/health")[0], 200)
        with closing(sqlite3.connect(self.db)) as connection:
            columns = [row[1] for row in connection.execute("PRAGMA table_info(plays)")]
            self.assertEqual(columns, ["slug", "count"])
            self.assertEqual(connection.execute("PRAGMA journal_mode").fetchone()[0], "wal")

    def test_increment_and_restart_preserve_counts_without_reseeding(self):
        expected = dict(SEEDS)
        for slug in SLUGS:
            status, headers, body = self.increment(slug)
            expected[slug] += 1
            self.assertEqual(status, 200)
            self.assertEqual(json.loads(body), {"counts": expected})
            self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.server.close()
        # Use a fresh ephemeral listener: Linux may retain the old TCP port in
        # TIME_WAIT after process exit. Persistence depends on the DB, not port reuse.
        self.server = RunningServer(self.db)
        self.assertEqual(self.counts(), expected)
        self.assertEqual(self.increment("deadpoint")[0], 200)
        expected["deadpoint"] += 1
        self.assertEqual(self.counts(), expected)

    def test_concurrent_increments_are_atomic(self):
        with ThreadPoolExecutor(max_workers=16) as workers:
            responses = list(workers.map(lambda _: self.increment("grove"), range(96)))
        self.assertTrue(all(response[0] == 200 for response in responses))
        observed = sorted(json.loads(response[2])["counts"]["grove"] for response in responses)
        self.assertEqual(observed, list(range(1, 97)))
        expected = dict(SEEDS, grove=96)
        self.assertEqual(self.counts(), expected)

    def test_a_short_database_write_lock_is_retried_without_losing_the_play(self):
        connection = sqlite3.connect(self.db, isolation_level=None)
        try:
            connection.execute("BEGIN IMMEDIATE")
            with ThreadPoolExecutor(max_workers=1) as workers:
                pending = workers.submit(self.increment, "emberfell")
                time.sleep(0.15)
                self.assertFalse(pending.done())
                connection.commit()
                self.assertEqual(pending.result(timeout=5)[0], 200)
        finally:
            connection.close()
        self.assertEqual(self.counts()["emberfell"], 1)

    def test_origins_reject_cross_site_and_allow_both_portals_and_loopback(self):
        for origin in [
            "https://evil.example", "https://gameslop.now.evil.example", "https://gameslop.now/",
            "http://gameslop.now", "null", "https://user@gameslop.now", "http://localhost.evil.example:3011",
            "http://127.0.0.1:99999", "http://localhost/path", "http://localhost:",
        ]:
            status, headers, body = self.increment(origin=origin)
            self.assertEqual(status, 403, origin)
            self.assertNotIn("Access-Control-Allow-Origin", headers)
            self.assertIn("no-store", headers["Cache-Control"])
            self.assertIn("error", json.loads(body))
        self.assertEqual(self.server.request("POST", "/api/plays/grove")[0], 403)
        self.assertEqual(self.server.request(headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.counts(), SEEDS)
        allowed = [ORIGIN, "https://brainrotgame.shop", "http://localhost:3011", "http://127.0.0.1:3011", "http://[::1]:3011"]
        for origin in allowed:
            status, headers, _ = self.increment("pelaglyph", origin)
            self.assertEqual(status, 200, origin)
            self.assertEqual(headers["Access-Control-Allow-Origin"], origin)
        self.assertEqual(self.counts()["pelaglyph"], len(allowed))

    def test_preflight_is_bounded_and_does_not_increment(self):
        headers = {"Origin": ORIGIN, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}
        status, response_headers, _ = self.server.request("OPTIONS", "/api/plays/primordial", headers=headers)
        self.assertEqual(status, 200)
        self.assertIn("POST", response_headers["Access-Control-Allow-Methods"])
        self.assertEqual(response_headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(self.server.request("OPTIONS", "/api/plays/primordial")[0], 403)
        headers["Origin"] = "https://evil.example"
        self.assertEqual(self.server.request("OPTIONS", "/api/plays/primordial", headers=headers)[0], 403)
        headers["Origin"] = ORIGIN
        headers["Access-Control-Request-Headers"] = "authorization"
        self.assertEqual(self.server.request("OPTIONS", "/api/plays/primordial", headers=headers)[0], 400)
        headers["Access-Control-Request-Headers"] = ""
        headers["Access-Control-Request-Method"] = "DELETE"
        self.assertEqual(self.server.request("OPTIONS", "/api/plays/primordial", headers=headers)[0], 405)
        self.assertEqual(self.counts(), SEEDS)

    def test_unknown_routes_methods_and_malformed_framing_never_increment(self):
        for path in ["/api/plays/unknown", "/api/plays/Primordial", "/api/plays/primordial/", "/api/plays", "/api/plays/primordial/extra"]:
            self.assertEqual(self.server.request("POST", path, headers={"Origin": ORIGIN})[0], 404, path)
        for method in ["PUT", "PATCH", "DELETE", "TRACE"]:
            status, headers, _ = self.server.request(method, "/api/plays/primordial", headers={"Origin": ORIGIN})
            self.assertEqual(status, 405)
            self.assertIn("POST", headers["Allow"])
        for length, status in [("-1", 400), ("nope", 400), ("1.5", 400), ("+1", 400), ("1", 400), ("4096", 400), ("4097", 413), ("9" * 100, 413)]:
            raw = f"POST /api/plays/primordial HTTP/1.1\r\nHost: localhost\r\nOrigin: {ORIGIN}\r\nContent-Length: {length}\r\n\r\n".encode()
            self.assertEqual(self.server.raw(raw)[0], status, length)
        for extra in ["Content-Length: 0\r\nContent-Length: 0", "Transfer-Encoding: chunked", "Origin: https://evil.example"]:
            raw = f"POST /api/plays/primordial HTTP/1.1\r\nHost: localhost\r\nOrigin: {ORIGIN}\r\n{extra}\r\n\r\n".encode()
            self.assertIn(self.server.raw(raw)[0], [400, 403])
        self.assertEqual(self.counts(), SEEDS)
        raw = f"POST /api/plays/grove HTTP/1.1\r\nHost: localhost\r\nOrigin: {ORIGIN}\r\n\r\n".encode()
        self.assertEqual(self.server.raw(raw)[0], 200)
        self.assertEqual(self.counts()["grove"], 1)

    def test_optional_portal_does_not_expose_database_or_scripts(self):
        site = self.root / "site"
        assets = site / "assets"
        assets.mkdir(parents=True)
        (site / "index.html").write_text("<!doctype html><title>Test portal</title>", encoding="utf-8")
        (assets / "portal.js").write_text("console.log('portal');", encoding="utf-8")
        for relative in ["plays.sqlite3", "server.py", ".env", "assets/secrets.sqlite3", "assets/hidden.py"]:
            (site / relative).write_text("private-marker", encoding="utf-8")
        self.server.close()
        self.server = RunningServer(self.db, site)
        for path in ["/", "/index.html", "/assets/portal.js"]:
            self.assertEqual(self.server.request(path=path)[0], 200)
        self.assertIn("javascript", self.server.request(path="/assets/portal.js")[1]["Content-Type"])
        self.assertEqual(self.server.request("HEAD", "/")[2], b"")
        for path in ["/plays.sqlite3", "/server.py", "/.env", "/assets/secrets.sqlite3", "/assets/hidden.py", "/assets/", "/../index.html", "/%2e%2e/index.html", "/assets/%2e%2e/server.py", "/assets/..%5cserver.py", "/%00index.html", "/%zz"]:
            status, headers, body = self.server.request(path=path)
            self.assertIn(status, [400, 404], path)
            self.assertNotIn(b"private-marker", body)
            self.assertIn("application/json", headers["Content-Type"])
        try:
            (assets / "linked.js").symlink_to(site / "server.py")
        except (OSError, NotImplementedError):
            pass
        else:
            self.assertEqual(self.server.request(path="/assets/linked.js")[0], 404)
        self.assertEqual(self.counts(), SEEDS)


if __name__ == "__main__":
    unittest.main()
