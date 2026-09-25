#!/usr/bin/env python3
"""Shared Gameslop play counts, using only Python's standard library."""

import argparse
from contextlib import closing
import json
import mimetypes
import os
from pathlib import Path
import re
import sqlite3
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


SLUGS = (
    "primordial", "primordial-tactics", "bagbrawl", "deadpoint", "headsup",
    "grove", "emberwild", "emberfell", "pelaglyph",
)
INITIAL_COUNTS = {slug: {"deadpoint": 225, "bagbrawl": 30, "primordial": 10}.get(slug, 0) for slug in SLUGS}
PORTAL_ORIGINS = frozenset(("https://gameslop.now", "https://brainrotgame.shop"))
LOCAL_HOSTS = frozenset(("localhost", "127.0.0.1", "::1"))
STATIC_EXTENSIONS = frozenset((
    ".css", ".js", ".mjs", ".svg", ".png", ".jpg", ".jpeg", ".webp",
    ".avif", ".gif", ".ico", ".woff", ".woff2", ".ttf", ".otf",
))
MAX_BODY = 4096


def allowed_origin(origin):
    if not origin or any(char.isspace() or ord(char) < 32 for char in origin):
        return False
    if origin in PORTAL_ORIGINS:
        return True
    try:
        value = urlsplit(origin)
        port = value.port
        return (
            value.scheme in ("http", "https")
            and value.hostname in LOCAL_HOSTS
            and value.username is None and value.password is None
            and not value.path and not value.query and not value.fragment
            and not origin.endswith(":")
            and (port is None or 1 <= port <= 65535)
        )
    except ValueError:
        return False


class PlayStore:
    def __init__(self, path):
        self.path = Path(path).expanduser().resolve()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with closing(self.connect()) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("CREATE TABLE IF NOT EXISTS plays (slug TEXT PRIMARY KEY, count INTEGER NOT NULL CHECK(count >= 0))")
            connection.executemany(
                "INSERT OR IGNORE INTO plays (slug, count) VALUES (?, ?)",
                INITIAL_COUNTS.items(),
            )
            connection.commit()

    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10, isolation_level=None)
        connection.execute("PRAGMA busy_timeout=10000")
        return connection

    @staticmethod
    def snapshot(connection):
        # Do not return arbitrary database keys if a future migration adds rows.
        rows = dict(connection.execute("SELECT slug, count FROM plays"))
        return {slug: rows[slug] for slug in SLUGS}

    def counts(self):
        with closing(self.connect()) as connection:
            return self.snapshot(connection)

    def increment(self, slug):
        if slug not in SLUGS:
            raise KeyError(slug)
        with closing(self.connect()) as connection:
            connection.execute("BEGIN IMMEDIATE")
            connection.execute("UPDATE plays SET count = count + 1 WHERE slug = ?", (slug,))
            counts = self.snapshot(connection)
            connection.commit()
            return counts


class CounterServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address, store, site_root=None):
        self.store = store
        self.site_root = Path(site_root).expanduser().resolve() if site_root else None
        if self.site_root is not None and not (self.site_root / "index.html").is_file():
            raise ValueError("--site-root must contain index.html")
        super().__init__(address, CounterHandler)

    def handle_error(self, request, client_address):
        # Neither client addresses nor request headers are recorded.
        print("A counter request ended unexpectedly.", file=sys.stderr, flush=True)


class CounterHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "GameslopCounter/1"
    sys_version = ""

    def setup(self):
        super().setup()
        self.connection.settimeout(10)

    def log_message(self, _format, *args):
        pass

    def send_error(self, code, message=None, explain=None):
        self.json_response(code, {"error": "Invalid HTTP request"})

    def headers_for(self, status, content_type, length, extra=None):
        self.close_connection = True
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(length))
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Connection", "close")
        self.send_header("Vary", "Origin")
        origins = self.headers.get_all("Origin", []) if hasattr(self, "headers") else []
        if len(origins) == 1 and allowed_origin(origins[0]):
            self.send_header("Access-Control-Allow-Origin", origins[0])
        for key, value in (extra or {}).items():
            self.send_header(key, value)
        self.end_headers()

    def json_response(self, status, payload, extra=None):
        body = json.dumps(payload, separators=(",", ":"), ensure_ascii=True).encode("utf-8")
        self.headers_for(status, "application/json; charset=utf-8", len(body), extra)
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def reject(self, status, message, extra=None):
        self.json_response(status, {"error": message}, extra)
        return False

    def validate_body(self):
        if self.headers.get_all("Transfer-Encoding"):
            return self.reject(400, "Transfer-Encoding is not supported")
        lengths = self.headers.get_all("Content-Length", [])
        if len(lengths) > 1:
            return self.reject(400, "Only one Content-Length is allowed")
        if not lengths:
            return True
        length = lengths[0].strip()
        if re.fullmatch(r"[0-9]+", length) is None:
            return self.reject(400, "Content-Length must be a nonnegative integer")
        if len(length) > 10 or int(length) > MAX_BODY:
            return self.reject(413, "Request body is too large")
        if int(length):
            # This API accepts no payload. Closing the connection avoids waiting
            # for a body or allowing unread bytes to become another request.
            return self.reject(400, "Request body must be empty")
        return True

    def validate_origin(self, required=False):
        origins = self.headers.get_all("Origin", [])
        if not origins and not required:
            return True
        if len(origins) != 1 or not allowed_origin(origins[0]):
            return self.reject(403, "Origin is not allowed")
        return True

    def request_path(self):
        if not self.path.startswith("/") or self.path.startswith("//"):
            return None
        raw = self.path.split("?", 1)[0]
        if "#" in raw or re.search(r"%(?![0-9a-fA-F]{2})", raw):
            return None
        try:
            path = unquote(raw, errors="strict")
        except (UnicodeDecodeError, ValueError):
            return None
        if "\\" in path or "\0" in path or ":" in path or ".." in path.split("/"):
            return None
        return path

    def read_request(self):
        if not self.validate_body() or not self.validate_origin():
            return
        path = self.request_path()
        if path is None:
            self.reject(400, "Invalid request path")
        elif path == "/health":
            self.json_response(200, {"ok": True})
        elif path == "/api/plays":
            try:
                self.json_response(200, {"counts": self.server.store.counts()})
            except sqlite3.Error:
                self.reject(503, "Counts are temporarily unavailable", {"Retry-After": "1"})
        else:
            self.serve_static(path)

    def do_GET(self):
        self.read_request()

    def do_HEAD(self):
        self.read_request()

    def do_POST(self):
        if not self.validate_body() or not self.validate_origin(required=True):
            return
        path = self.request_path()
        if path is None:
            self.reject(400, "Invalid request path")
            return
        prefix = "/api/plays/"
        slug = path[len(prefix):] if path.startswith(prefix) else ""
        if slug not in SLUGS:
            self.reject(404, "Unknown game")
            return
        try:
            self.json_response(200, {"counts": self.server.store.increment(slug)})
        except sqlite3.Error:
            self.reject(503, "Counts are temporarily unavailable", {"Retry-After": "1"})

    def do_OPTIONS(self):
        if not self.validate_body() or not self.validate_origin(required=True):
            return
        path = self.request_path()
        if path != "/api/plays" and path not in {"/api/plays/" + slug for slug in SLUGS}:
            self.reject(404, "Unknown API route")
            return
        method = self.headers.get("Access-Control-Request-Method", "")
        if method not in ("GET", "POST"):
            self.reject(405, "Method is not allowed", {"Allow": "GET, HEAD, POST, OPTIONS"})
            return
        headers = {item.strip().lower() for item in self.headers.get("Access-Control-Request-Headers", "").split(",") if item.strip()}
        if not headers <= {"content-type"}:
            self.reject(400, "Requested headers are not allowed")
            return
        self.json_response(200, {"ok": True}, {
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            "Access-Control-Max-Age": "0",
        })

    def unsupported_method(self):
        self.reject(405, "Method is not allowed", {"Allow": "GET, HEAD, POST, OPTIONS"})

    do_PUT = unsupported_method
    do_PATCH = unsupported_method
    do_DELETE = unsupported_method
    do_TRACE = unsupported_method
    do_CONNECT = unsupported_method

    def serve_static(self, path):
        root = self.server.site_root
        if root is None:
            self.reject(404, "Not found")
            return
        relative = "index.html" if path in ("/", "/index.html") else path.lstrip("/")
        if relative != "index.html":
            parts = relative.split("/")
            if (not relative.startswith("assets/") or any(part.startswith(".") or not part for part in parts)
                    or Path(relative).suffix.lower() not in STATIC_EXTENSIONS):
                self.reject(404, "Not found")
                return
        candidate = root / relative
        # Static aliases cannot expose a database or a script through a symlink.
        if any(part.is_symlink() for part in (candidate, *candidate.parents) if part != root and root in part.parents):
            self.reject(404, "Not found")
            return
        try:
            resolved = candidate.resolve()
            if not resolved.is_relative_to(root) or not resolved.is_file():
                self.reject(404, "Not found")
                return
            content = resolved.read_bytes()
        except OSError:
            self.reject(404, "Not found")
            return
        content_type = {".js": "text/javascript", ".mjs": "text/javascript"}.get(resolved.suffix.lower()) or mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
        self.headers_for(200, content_type, len(content))
        if self.command != "HEAD":
            try:
                self.wfile.write(content)
            except (BrokenPipeError, ConnectionResetError):
                pass


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("GAMESLOP_PLAYS_HOST", "127.0.0.1"), choices=("127.0.0.1", "localhost"))
    parser.add_argument("--port", type=int, default=os.environ.get("GAMESLOP_PLAYS_PORT", "3012"))
    parser.add_argument("--db", default=os.environ.get("GAMESLOP_PLAYS_DB", "var/plays.sqlite3"))
    parser.add_argument("--site-root", help="Optionally serve index.html and assets/ from this directory")
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error("--port must be between 0 and 65535")
    try:
        store = PlayStore(args.db)
        server = CounterServer((args.host, args.port), store, args.site_root)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f"Counter could not start: {error}\n")
    print(f"Listening on http://127.0.0.1:{server.server_port}", flush=True)
    try:
        server.serve_forever(poll_interval=0.25)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
