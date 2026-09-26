#!/usr/bin/env python3
"""Record content changes in the nine fixed production games; never run game code.

Current files are hashed on each run. Only first observations consult the bounded
six-game release manifest chain. Dates survive sibling releases and collector
reinstalls; an observed rollback is a new content-change event. Run as root so
atomic 0644 output remains readable by the counter's DynamicUser.
"""

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat
import sys
import tempfile

SLUGS = ("primordial", "primordial-tactics", "bagbrawl", "deadpoint", "headsup",
         "grove", "emberwild", "emberfell", "pelaglyph")
BUNDLE = {"primordial": "primordial-action", "primordial-tactics": "primordial",
          "grove": "grove", "emberwild": "emberwild", "emberfell": "emberfell", "pelaglyph": "pelaglyph"}
ALGORITHM = "sha256-path-size-content-v1"
PUBLIC = frozenset(".html .htm .css .js .mjs .cjs .json .webmanifest .svg .png .jpg .jpeg .gif .webp .avif .ico .woff .woff2 .ttf .otf .eot .mp3 .ogg .wav .m4a .mp4 .webm .wasm".split())
RUNTIME = frozenset(".js .mjs .cjs .json .wasm .glsl .wgsl".split())
EXCLUDED = frozenset(("node_modules", "data", "logs", "test", "tests", "ops", "scripts", "secrets", "credentials"))
MAX_FILES, MAX_FILE_BYTES, MAX_GAME_BYTES, MAX_HISTORY = 4096, 64 * 1024 * 1024, 256 * 1024 * 1024, 256


class UnstableRead(Exception):
    pass


class CollectorBusy(Exception):
    pass


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def timestamp(value):
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed.timestamp() if parsed.tzinfo else None
    except (TypeError, ValueError, AttributeError, OverflowError):
        return None


def allowed(name, runtime=False):
    parts = PurePosixPath(name).parts
    if not parts or any(part.startswith(".") or part.lower() in EXCLUDED for part in parts):
        return False
    leaf = parts[-1].lower()
    if any(word in leaf for word in (".env", ".test.", ".spec.", "secret", "credential")):
        return False
    if leaf.endswith("-ofl.txt") and "fonts" in parts and not runtime:
        return True
    return PurePosixPath(name).suffix.lower() in (RUNTIME if runtime else PUBLIC)


def digest_records(records):
    normalized = sorted((row["path"], row["bytes"], row["sha256"]) for row in records)
    return hashlib.sha256(json.dumps(normalized, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def file_signature(info):
    # Windows exposes different ctime meanings through stat and fstat. Size,
    # mtime and file identity remain comparable there; Linux also checks ctime.
    return (info.st_size, info.st_mtime_ns, 0 if os.name == "nt" else info.st_ctime_ns, info.st_ino)


def confined(path, owner):
    resolved = path.resolve(strict=True)
    if not resolved.is_relative_to(owner.resolve(strict=True)):
        raise ValueError("Game path escapes its fixed deployment directory")
    return resolved


def inventory(trees):
    """List only public/runtime files, without following nested symlinks."""
    result = {}
    def failed_walk(error):
        raise error

    for directory, prefix, runtime in trees:
        for current, directories, files in os.walk(directory, followlinks=False, onerror=failed_walk):
            current = Path(current)
            directories[:] = sorted(name for name in directories if not name.startswith(".") and name.lower() not in EXCLUDED)
            for name in directories:
                if (current / name).is_symlink():
                    raise ValueError("Nested symlinks are not allowed in game content")
            for name in sorted(files):
                relative = (current / name).relative_to(directory).as_posix()
                if not allowed(relative, runtime):
                    continue
                filename = current / name
                info = filename.lstat()
                if not stat.S_ISREG(info.st_mode):
                    raise ValueError("Game content must contain regular files")
                if info.st_size > MAX_FILE_BYTES:
                    raise ValueError("Game file exceeds collector size bound")
                logical = prefix + relative
                result[logical] = (filename, *file_signature(info))
                if len(result) > MAX_FILES:
                    raise ValueError("Game exceeds collector file-count bound")
    if sum(row[1] for row in result.values()) > MAX_GAME_BYTES:
        raise ValueError("Game exceeds collector byte-count bound")
    return result


def pointer_tokens(root):
    names = ("gameslop/current", "bagbrawl/ci-current", "bagbrawl/app", "bagbrawl/dist",
             "deadpoint/ci-current", "deadpoint/app", "deadpoint/dist", "headsup/dist")
    tokens = []
    for name in names:
        pointer = root / name
        try:
            info = pointer.lstat()
            tokens.append((name, str(pointer.resolve(strict=True)), info.st_ino, info.st_mtime_ns))
        except OSError:
            tokens.append((name, None))
    return tokens


def game_location(root, slug):
    if slug in BUNDLE:
        owner = root / "gameslop"
        pointer = owner / "current"
        release = confined(pointer, owner)
        if release != owner / "current" and release.parent != owner / "releases":
            raise ValueError("Unexpected six-game release location")
        public = confined(release / "games" / BUNDLE[slug], release)
        return [(public, "", False)], release, pointer
    owner = root / slug
    public = confined(owner / "dist", owner)
    trees = [(public, "dist/" if slug != "headsup" else "", False)]
    pointer = owner / ("ci-current" if slug != "headsup" else "dist")
    if slug != "headsup":
        app = confined(owner / "app", owner)
        if public.name != "dist" or app.name != "app" or public.parent != app.parent:
            raise ValueError("Client and server point at different releases")
        for folder in ("server", "src"):
            selected = confined(app / folder, owner)
            trees.append((selected, "app/" + folder + "/", True))
        if not (app / "server" / "index.js").is_file():
            raise ValueError("Missing server runtime entrypoint")
        # These two exact files describe the running dependency graph. Do not
        # walk app/, node_modules/, environment files, logs, or saved game data.
        trees.append((app, "packages/", "packages"))
    return trees, public.parent, pointer


def game_inventory(trees):
    ordinary = [tree for tree in trees if tree[2] != "packages"]
    result = inventory(ordinary)
    for directory, _, mode in trees:
        if mode != "packages":
            continue
        for name in ("package.json", "package-lock.json"):
            filename = directory / name
            info = filename.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE_BYTES:
                raise ValueError("Invalid runtime package manifest")
            result["app/" + name] = (filename, *file_signature(info))
    return result


def snapshot_game(root, slug):
    trees, release, pointer = game_location(root, slug)
    before = game_inventory(trees)
    entrypoint = "dist/index.html" if slug in ("bagbrawl", "deadpoint") else "index.html"
    if entrypoint not in before:
        raise ValueError("Missing public game entrypoint")
    records = []
    for name, (filename, size, mtime, ctime, inode) in sorted(before.items()):
        # O_NOFOLLOW avoids reading a replaced symlink on the Linux collector.
        descriptor = os.open(filename, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(descriptor, "rb") as handle:
            info = os.fstat(handle.fileno())
            if file_signature(info) != (size, mtime, ctime, inode):
                raise UnstableRead("Game changed before hashing")
            digest = hashlib.sha256()
            bytes_read = 0
            while chunk := handle.read(1024 * 1024):
                bytes_read += len(chunk)
                if bytes_read > size:
                    raise UnstableRead("Game grew while hashing")
                digest.update(chunk)
            after = os.fstat(handle.fileno())
            if file_signature(after) != (size, mtime, ctime, inode):
                raise UnstableRead("Game changed while hashing")
        records.append({"path": name, "bytes": size, "sha256": digest.hexdigest()})
    if game_inventory(trees) != before:
        raise UnstableRead("Game inventory changed while hashing")
    try:
        activation = pointer.lstat().st_mtime if pointer.is_symlink() else None
    except OSError:
        activation = None
    return {"fingerprint": digest_records(records), "records": records,
            "mtime": max(row[2] for row in before.values()) / 1e9,
            "releasePath": release, "release": release.name, "activation": activation}


def read_metadata(filename):
    if filename.is_symlink():
        raise ValueError("Metadata symlinks are not permitted")
    with filename.open("rb") as handle:
        raw = handle.read(1024 * 1024 + 1)
    if len(raw) > 1024 * 1024:
        raise ValueError("Metadata exceeds size bound")
    return json.loads(raw)


def manifest_fingerprint(manifest, slug):
    game = next(game for game in manifest["games"] if game["slug"] == BUNDLE[slug])
    records = []
    for row in game["files"]:
        name, length, digest = row["path"], row["bytes"], row["sha256"]
        if not isinstance(name, str) or "\\" in name or PurePosixPath(name).is_absolute() or ".." in PurePosixPath(name).parts:
            raise ValueError("Invalid historical game path")
        if not allowed(name):
            continue
        if not isinstance(length, int) or length < 0 or length > MAX_FILE_BYTES or not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("Invalid historical content fingerprint")
        records.append(row)
    if not records or len(records) > MAX_FILES or len({row["path"] for row in records}) != len(records):
        raise ValueError("Invalid historical inventory")
    return digest_records(records)


def bootstrap_date(root, slug, current, now):
    if slug in BUNDLE:
        folder, visited, best = current["releasePath"], set(), None
        for _ in range(MAX_HISTORY):
            try:
                manifest = read_metadata(folder / "manifest.json")
                release_id = manifest["releaseId"]
                created = timestamp(manifest.get("createdAt"))
                if not isinstance(release_id, str) or release_id in visited or created is None or not 0 < created <= now:
                    break
                visited.add(release_id)
                if manifest_fingerprint(manifest, slug) != current["fingerprint"]:
                    if best:
                        return best[0], {"method": "release-history", "release": best[1]}
                    break
                if best and created > timestamp(best[0]):
                    break
                best = (iso(created), release_id)
                previous = manifest.get("baseReleaseId")
                if not isinstance(previous, str) or not previous or any(c not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-" for c in previous):
                    break
                folder = confined(root / "gameslop" / "releases" / previous, root / "gameslop" / "releases")
            except (OSError, ValueError, KeyError, TypeError, StopIteration):
                break
        if best:
            return best[0], {"method": "earliest-retained-release", "release": best[1]}
    if 0 < current["mtime"] <= now:
        return iso(current["mtime"]), {"method": "game-file-mtime", "release": current["release"]}
    return None, {"method": "unknown"}


def collect(root=Path("/opt"), previous=None, now=None):
    root = Path(root).resolve()
    now = datetime.now(timezone.utc).timestamp() if now is None else now
    previous = previous or {}
    if previous and (previous.get("schemaVersion") != 1 or previous.get("fingerprintAlgorithm") != ALGORITHM):
        raise ValueError("Incompatible previous collector state; preserve it for explicit migration")
    for _ in range(3):
        before, current, errors = pointer_tokens(root), {}, {}
        try:
            for slug in SLUGS:
                try:
                    current[slug] = snapshot_game(root, slug)
                except (OSError, ValueError) as error:
                    errors[slug] = str(error)
            if pointer_tokens(root) != before:
                raise UnstableRead("Deployment pointers changed during collection")
            break
        except UnstableRead:
            continue
    else:
        raise UnstableRead("Deployment changed during all three collection attempts; previous output retained")
    result = {"schemaVersion": 1, "fingerprintAlgorithm": ALGORITHM,
              "lastUpdated": {}, "fingerprints": {}, "source": {}, "observedReleases": {}, "errors": errors}
    for slug in SLUGS:
        old_hash = previous.get("fingerprints", {}).get(slug)
        old_date = previous.get("lastUpdated", {}).get(slug)
        if slug not in current:
            result["fingerprints"][slug], result["lastUpdated"][slug] = old_hash, old_date
            result["source"][slug] = previous.get("source", {}).get(slug, {"method": "unknown"})
            result["observedReleases"][slug] = previous.get("observedReleases", {}).get(slug)
            continue
        game = current[slug]
        if old_hash == game["fingerprint"] and timestamp(old_date) is not None:
            date, source = old_date, previous["source"][slug]
        elif old_hash and old_hash != game["fingerprint"]:
            activated = game["activation"]
            moved = previous.get("observedReleases", {}).get(slug) != game["release"]
            use_activation = moved and activated is not None and (timestamp(old_date) or 0) < activated <= now
            date = iso(activated if use_activation else now)
            source = {"method": "release-activation" if use_activation else "content-change-observed", "release": game["release"]}
        else:
            date, source = bootstrap_date(root, slug, game, now)
        result["lastUpdated"][slug], result["source"][slug] = date, source
        result["fingerprints"][slug] = game["fingerprint"]
        result["observedReleases"][slug] = game["release"]
    if all(previous.get(key) == value for key, value in result.items()):
        return previous
    result["observedAt"] = iso(now)
    return result


def output_directory(output):
    output.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if output.is_symlink() or output.parent.is_symlink():
        raise ValueError("Collector output must not use symlinks")
    os.chmod(output.parent, 0o755)


@contextmanager
def state_lock(output):
    """Serialize install/cron from reading prior state through atomic replace."""
    output_directory(output)
    lock_path = output.with_name(output.name + ".lock")
    descriptor = os.open(lock_path, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    acquired = False
    try:
        if os.name == "nt":
            import msvcrt
            if os.fstat(descriptor).st_size == 0:
                os.write(descriptor, b"\0")
            os.lseek(descriptor, 0, os.SEEK_SET)
            try:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise CollectorBusy("Another collector owns this output") from error
        else:
            import fcntl
            try:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise CollectorBusy("Another collector owns this output") from error
        acquired = True
        yield
    finally:
        if acquired:
            if os.name == "nt":
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def write_atomic(output, document):
    output = Path(output)
    output_directory(output)
    descriptor, temporary = tempfile.mkstemp(prefix=".updates-", suffix=".json", dir=output.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(document, handle, sort_keys=True, indent=2, allow_nan=False)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, 0o644)
        os.replace(temporary, output)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def run(root, output, now=None, dry_run=False):
    output = Path(output)

    def collect_state():
        try:
            previous = read_metadata(output)
        except FileNotFoundError:
            previous = None
        result = collect(root, previous, now)
        if not dry_run:
            if result != previous:
                write_atomic(output, result)
            else:
                os.chmod(output, 0o644)
        return result

    if dry_run:
        return collect_state()
    with state_lock(output):
        return collect_state()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("/var/lib/gameslop-catalog/updates.json"))
    parser.add_argument("--root", type=Path, default=Path("/opt"), help="Deployment root; /opt in production")
    parser.add_argument("--dry-run", action="store_true", help="Print metadata without creating or changing files")
    options = parser.parse_args()
    try:
        result = run(options.root, options.output, dry_run=options.dry_run)
        print(json.dumps(result if options.dry_run else {"lastUpdated": result["lastUpdated"], "errors": result["errors"]}, sort_keys=True))
        return 1 if result["errors"] else 0
    except CollectorBusy:
        print(json.dumps({"skipped": "Another collector is updating this output"}))
        return 0
    except (OSError, ValueError, UnstableRead) as error:
        print(f"Release-date collection failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
