# brainrotgame.shop · gameslop.now

The front door for ten games, answering on two domains. Each card shows the shared total of Play
button clicks. The sort menu defaults to **Sort by number of plays**, with **Sort by newest update**
and **Trending** (play clicks in the last seven days) also available. The header and title say
whichever name the visitor typed; both domains use the same counters.

- **Bag Brawl** — https://bagbrawl.app
- **Deadpoint** — https://deadpoint.bagbrawl.app
- **Heads Up** — https://headsup.bagbrawl.app

## How it is served

From the same droplet as the games: Caddy serves `/opt/brainrotgame/site` off disk and proxies `/api/*`
to the Python standard-library counter service on `127.0.0.1:3012`. Its own site file
(`/etc/caddy/brainrotgame.caddy`) is imported by the main Caddyfile. Both bare names share that root
and counter database; each `www` redirects to its bare name. No JavaScript build or Python packages
are needed. Python 3.10+ is required; production uses Python 3.12.

- `npm run provision` — writes the web root and the Caddy site file on the droplet for every name in
  `PUBLIC_HOSTS` (`ops/server.env`). Safe to rerun; rerun it after adding a name.
- `npm run deploy` — installs the page, browser script, counter service, and API route. It preserves
  the database, validates Caddy, verifies the public page/script/API, and restores the previous portal
  on failure. Portal backups live under `/opt/brainrotgame/backups/`.
- `npm run serve` — page and working local API on http://127.0.0.1:3011; stores local counts in ignored
  `var/plays.sqlite3`. You can also run `python counter/server.py --port 3011 --site-root .` directly.
- `npm test` — HTTP, concurrency, persistence, and API rejection tests using temporary databases.
- `npm ci`, `npx playwright install chromium`, then `npm run test:browser` and `npm run test:integration`
  — browser navigation/ranking checks and a full browser-to-SQLite test. The latter saves ignored
  desktop/mobile previews in `test-results/`. Set `PORTAL_BROWSER_CHANNEL=chrome` to use installed
  Chrome instead, and `PORTAL_PYTHON` if Python is not on your PATH.

Both need SSH to the droplet as root with the owner's key; the address is in `ops/server.env`.

## Shared play counts

`GET /api/plays` returns all ten fixed game IDs in `counts` (lifetime plays), `weeklyCounts`
(plays in the rolling last seven days), and `lastUpdated` (UTC date strings or null). It also
returns `weeklyTrackingStartedAt` and an increasing `asOf` timestamp so delayed responses cannot
replace fresher rankings. `POST /api/plays/<game-id>` with an empty body adds one real play event
and returns the updated snapshot. The browser
sends this request without delaying navigation, including keyboard activation and new-tab clicks.
Counts measure clicks from the portal, not sessions, unique people, or visits directly to a game.
No accounts, cookies, IP addresses, or other visitor identifiers are stored by the counter.

The owner requested initial totals of **225 for Deadpoint**, **30 for Bag Brawl**, **10 for Primordial**,
and **0 for every other game**. These initialize new database rows only; restarts and redeployments
never reset existing totals. The default sort ranks games by the latest shared totals, highest first.
Equal totals retain the original catalog order (Primordial, then Primordial: Tactics, followed by
the other games). Hovering or focusing a card does not freeze the ranking, and keyboard focus stays
on the same link when cards move. Reordering waits only while a pointer button or activation key
is held, then applies after the gesture so the intended link still opens. Successful count responses,
including Play increments, update the ranking. Returning to the portal tab or restoring it through
the browser's back/forward cache refreshes both totals and order.
The selected sort is remembered within the current tab. Visible pages refresh statistics every
minute so the weekly window can change without another click.

Trending counts only timestamped clicks in the interval `(now - 7 days, now]`. Existing totals and
seeded plays have no click dates, so they are not backfilled into Trending. The interface shows
when weekly tracking began while less than a full week has been collected. Each increment updates
the lifetime count and records its timestamp in one SQLite transaction. Only the game ID and time
are stored; no visitor identity is collected. Old events are pruned after eight days without
changing lifetime totals. Weekly totals can decrease as clicks leave the seven-day window.

### Game update dates

The root-owned `counter/release_dates.py` collector scans only known deployed game code/assets,
without executing game code. `/etc/cron.d/gameslop-catalog` runs it every five minutes and writes
`/var/lib/gameslop-catalog/updates.json` atomically. Content fingerprints keep an unchanged game
at its original date when a sibling game is deployed. The initial dates use available deployment
history or game-file timestamps; an unavailable date is reported as null and sorts last.
Hypercycle's fingerprint includes its public files plus the three fixed server files
`realtime/serve.mjs`, `realtime/hypercycle.mjs`, and `realtime/websocket.mjs` in the same release.
Its first date comes from the first manifest containing that game and runtime; adding it does not
change the dates of the existing games. Server-only Hypercycle releases also count as updates.

The counter service reads only the dates from that file via `GAMESLOP_UPDATES_FILE`. A missing or
invalid file leaves play counts working. Collector errors are logged to `/var/log/gameslop-catalog.log`.
For local date fixtures, run the server with `--updates-file <file>` containing a `lastUpdated` map.
The normal portal deployment installs the collector and its schedule before updating the counter.

The `gameslop-plays.service` systemd unit starts on boot, runs with a restricted dynamic user, and
stores SQLite state at `/var/lib/gameslop-plays/plays.sqlite3` outside the public directory. SQLite
increments are atomic. Every deployment backs up the database using SQLite's online backup API;
rollback preserves the current database so it does not discard new clicks. API responses bypass
caches. Unknown game IDs, oversized/nonempty bodies, and cross-site POST origins are rejected.
The public counter is deliberately unauthenticated; it is a simple popularity indicator, not a
fraud-resistant analytics system. Browser/network failures can prevent a click from being counted.

Operations: `systemctl status gameslop-plays`, `journalctl -u gameslop-plays`, and
`curl http://127.0.0.1:3012/api/plays`. Use SQLite's backup API for an online copy (do not copy only the
database file while its WAL is active). Do not replace the state directory during a portal release.
The service runs independently of the game deployment account and does not change game releases.

### Scheduled JSON exports

`/etc/cron.d/gameslop-plays-export` checks hourly at minute 17; the exporter writes a snapshot only
once 72 hours have passed since the previous successful export. This avoids the shorter intervals
that a day-of-month `*/3` cron expression creates at month boundaries. After server downtime, the
next check saves an overdue snapshot. The first export is created during installation.

Snapshots are private, timestamped JSON files in **`/var/backups/gameslop/plays`**, containing a UTC
export timestamp and a `counts` map for all ten games. The export reads a consistent SQLite
snapshot, writes atomically, and never changes live counters. Old exports are retained. Failures
leave the previous successful snapshot intact and are logged in `/var/log/gameslop-plays-export.log`.
This folder is on the same server; it is not an off-server disaster recovery backup.
Exports made before Hypercycle was added retain their original nine-game map. They remain valid
history for the 72-hour schedule; new exports require all ten games and do not rewrite old files.

The normal deployment preserves the schedule and export history. To install only this job, upload
`counter/export_counts.py`, `ops/gameslop-plays-export.cron`, and `ops/install-exports.sh` into a
`/tmp/gameslop-portal.<id>` directory and run `bash <directory>/ops/install-exports.sh <directory>` as
root. For an extra manual snapshot, run the cron command with `--force` (without the log redirection).

## Adding a game

Copy one of the `<article class="card" data-game="...">` blocks in `index.html`, give it a unique
`data-game` ID, `--accent` colour, short blurb, meta chips, Play link, and `data-play-count` label.
Add the same ID with a zero starting total to the backend's fixed game map in `counter/server.py`.
Update the exporter, release-date collector, installer API validation, and their test fixtures with
the same ID. Preserve existing database rows and accept older catalog exports only as history.
Keep it to what the game is and how many can play; the game's own page does the selling. Publish
and verify the game before the portal release, then run the tests and `npm run deploy`.

## Adding a domain

Add the bare name to `PUBLIC_HOSTS` in `ops/server.env`, give it a brand entry in the small script at
the foot of `index.html`, add its exact HTTPS origin to the backend allowlist and its Caddy block to
`ops/brainrotgame.caddy`, run `npm run provision`, then `npm run deploy`, and point its DNS as below.

## DNS (Porkbun)

Each domain points at the droplet, like the games' hostnames do:

| domain            | type | host | answer            |
|-------------------|------|------|-------------------|
| brainrotgame.shop | A    | @    | 24.199.123.123    |
| brainrotgame.shop | A    | www  | 24.199.123.123    |
| gameslop.now      | A    | @    | 24.199.123.123    |
| gameslop.now      | A    | www  | 24.199.123.123    |

Porkbun's default parking records (the ALIAS/CNAME it creates on a new domain) must be removed first or
they conflict. Once the records resolve, Caddy fetches certificates for the names itself.
## Games added September 2026

These six single-player games share the existing droplet and use Caddy static hosting:

- Grove — https://grove.gameslop.now
- Emberwild — https://emberwild.gameslop.now
- Emberfell — https://emberfell.gameslop.now
- Pelaglyph — https://pelaglyph.gameslop.now
- Primordial: Tactics — https://primordial.gameslop.now
- Primordial — https://primordial-action.gameslop.now

Each hostname has a Porkbun A record pointing to `24.199.123.123` (TTL 600). Caddy serves `/opt/gameslop/current/games/<slug>` through the separate `/etc/caddy/gameslop-games.caddy` import. No new Node services are needed. `current` points to a versioned release under `/opt/gameslop/releases`; rollback backups are under `/opt/gameslop/backups`.

The six game source projects and snapshot/deployment scripts are in `C:/Users/Zane Durante/Documents/New project`; see `gameslop-rollout/README.md` there for the source mapping and release commands. `npm run deploy` in this hub repository updates the catalog and its counter service. Game changes require a new verified static release, managed independently in the private `zanedurante/gameslop-games` repository.

The two Primordial entries refer to different games. Keep their public roots and hostnames separate. Existing browser saves from localhost or private preview domains do not automatically transfer to these new hostnames.

## Hypercycle

- Hypercycle — https://hypercycle.gameslop.now

Neon light-cycle combat for 2–8 online riders, with solo CPU opponents and keyboard/gamepad
controls. The source does not provide touch driving controls. Its static game files share the
versioned game bundle, while online play uses the bundled realtime server managed separately
from this portal. The new `hypercycle` counter row starts at zero; adding it preserves all existing
lifetime totals, weekly events, the weekly tracking start, update dates, and export history.
