#!/usr/bin/env python3
"""Export validated play counts when 72 hours have passed since the last snapshot."""
import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import errno
import json
import os
from pathlib import Path
import sqlite3
import tempfile

try:
    import fcntl
except ImportError:  # Keep the same exporter testable on Windows development machines.
    fcntl = None
    import msvcrt

SLUGS = ("primordial", "primordial-tactics", "bagbrawl", "deadpoint", "headsup", "grove", "emberwild", "emberfell", "pelaglyph", "hypercycle", "litigation", "hollowtide")
PRE_BRIDGER_SLUGS = tuple(slug for slug in SLUGS if slug not in ("litigation", "hollowtide"))
PRE_HYPERCYCLE_SLUGS = tuple(slug for slug in PRE_BRIDGER_SLUGS if slug != "hypercycle")
INTERVAL = timedelta(hours=72)
STAMP = "%Y%m%dT%H%M%S%fZ"


def validate_counts(counts, *, historical=False):
    # Retained nine- and ten-game exports preserve the 72-hour schedule.
    # New snapshots require all twelve games; historical files are not rewritten.
    expected = SLUGS
    if historical and isinstance(counts, dict):
        for catalog in (PRE_HYPERCYCLE_SLUGS, PRE_BRIDGER_SLUGS):
            if set(counts) == set(catalog):
                expected = catalog
                break
    if not isinstance(counts, dict) or set(counts) != set(expected):
        raise ValueError("A snapshot must contain every game in its catalog")
    if any(type(count) is not int or count < 0 for count in counts.values()):
        raise ValueError("Play counts must be nonnegative integers")
    return {slug: counts[slug] for slug in expected}


@contextmanager
def output_lock(directory):
    descriptor = os.open(directory / ".export.lock", os.O_CREAT | os.O_RDWR, 0o600)
    locked = False
    try:
        if fcntl is None and os.fstat(descriptor).st_size == 0:
            os.write(descriptor, b"0")
        os.lseek(descriptor, 0, os.SEEK_SET)
        try:
            if fcntl:
                fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
            else:
                msvcrt.locking(descriptor, msvcrt.LK_NBLCK, 1)
            locked = True
        except OSError as error:
            if error.errno not in (errno.EACCES, errno.EAGAIN):
                raise
        yield locked
    finally:
        if locked:
            if fcntl:
                fcntl.flock(descriptor, fcntl.LOCK_UN)
            else:
                os.lseek(descriptor, 0, os.SEEK_SET)
                msvcrt.locking(descriptor, msvcrt.LK_UNLCK, 1)
        os.close(descriptor)


def latest_snapshot(directory):
    snapshots = []
    for path in directory.glob("plays-*.json"):
        try:
            stamp = datetime.strptime(path.name[6:-5], STAMP).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        snapshots.append((stamp, path))
    if not snapshots:
        return None
    stamp, path = max(snapshots)
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("exported_at") != stamp.isoformat().replace("+00:00", "Z"):
        raise ValueError("Latest export has invalid timestamp metadata")
    validate_counts(data.get("counts"), historical=True)
    return stamp


def export_counts(db, output, *, force=False, now=None):
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError("Export time must include a timezone")
    now = now.astimezone(timezone.utc)
    directory = Path(output).expanduser().resolve()
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    with output_lock(directory) as locked:
        if not locked:
            return None
        latest = latest_snapshot(directory)
        if latest is not None and (now == latest or (not force and now - latest < INTERVAL)):
            return None
        # mode=ro is essential: a misspelled/missing source must never create a DB.
        uri = Path(db).expanduser().resolve().as_uri() + "?mode=ro"
        with closing(sqlite3.connect(uri, uri=True, timeout=10, isolation_level=None)) as connection:
            connection.execute("PRAGMA query_only=ON")
            connection.execute("BEGIN")
            rows = dict(connection.execute("SELECT slug, count FROM plays"))
            counts = validate_counts({slug: rows[slug] for slug in SLUGS if slug in rows})
        data = {"exported_at": now.isoformat().replace("+00:00", "Z"), "counts": counts}
        destination = directory / ("plays-" + now.strftime(STAMP) + ".json")
        if destination.exists():
            raise ValueError("An export already exists at this timestamp")
        descriptor, name = tempfile.mkstemp(prefix=".plays-", suffix=".tmp", dir=directory)
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as stream:
                os.chmod(temporary, 0o600)
                json.dump(data, stream, indent=2, ensure_ascii=True)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, destination)
            if os.name != "nt":
                descriptor = os.open(directory, os.O_RDONLY | os.O_DIRECTORY)
                try:
                    os.fsync(descriptor)
                finally:
                    os.close(descriptor)
        finally:
            temporary.unlink(missing_ok=True)
        return destination


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", default="/var/lib/gameslop-plays/plays.sqlite3")
    parser.add_argument("--output", default="/var/backups/gameslop/plays")
    parser.add_argument("--force", action="store_true", help="Export now regardless of the 72-hour interval")
    args = parser.parse_args()
    try:
        result = export_counts(args.db, args.output, force=args.force)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(1, f"Play-count export failed: {error}\n")
    print(f"Exported {result}" if result else "Export not due, or another exporter is running.")


if __name__ == "__main__":
    main()
