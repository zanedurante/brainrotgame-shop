# brainrotgame.shop · gameslop.now

The front door for sixteen games, answering on two domains. Each card shows the shared total of Play
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

## AdSense preparation

The homepage contains the ownership meta tag for publisher `ca-pub-3292344753796518`.
`/ads.txt` declares `google.com, pub-3292344753796518, DIRECT, f08c47fec0942fa0`, and
`/robots.txt` is a real plain-text file. `/about.html` and `/privacy.html` are public information
pages linked from the homepage. Both portal domains serve these same files. The privacy page lists
`support@gameslop.now` as the public contact and explains support-email forwarding through Porkbun
to Gmail.

**Advertising is not enabled by this change.** There is no Google advertising script, ad slot,
or consent-message script. The meta tag is one of Google's supported ownership-verification
methods, and publishing ads.txt does not request ads.

Before enabling ads, check gameslop.now's status in AdSense, resolve any review issues,
and update the privacy page to reflect the actual advertising configuration. Configure the
appropriate certified consent message in AdSense Privacy & messaging. The requested placement is
one manual display ad in each sidebar on wide screens, clear of Play controls, with Auto ads off
and no ads on narrow or mobile screens. Scope advertising to gameslop.now; do not load ad code on the alias,
privacy page or game subdomains. Google approval and account setup cannot be established from the
ownership-verification check alone.

Official references: [site connection](https://support.google.com/adsense/answer/7584263?hl=en),
[site status](https://support.google.com/adsense/answer/12170222?hl=en),
[ads.txt](https://support.google.com/adsense/answer/12171612?hl=en),
[required privacy disclosure](https://support.google.com/adsense/answer/1348695?hl=en), and
[consent requirements](https://support.google.com/adsense/answer/13554116?hl=en).

## Shared play counts

`GET /api/plays` returns all sixteen fixed game IDs in `counts` (lifetime plays), `weeklyCounts`
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
are stored; no visitor identity is collected. Events older than eight days are pruned at service
startup and subsequent click writes without changing lifetime totals. This is not a guaranteed
deletion deadline, and operational database backups can retain older events. Weekly totals can
decrease as clicks leave the seven-day window.

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
export timestamp and a `counts` map for all sixteen games. The export reads a consistent SQLite
snapshot, writes atomically, and never changes live counters. Old exports are retained. Failures
leave the previous successful snapshot intact and are logged in `/var/log/gameslop-plays-export.log`.
This folder is on the same server; it is not an off-server disaster recovery backup.
Exports made before Hypercycle, the first two Bridger games, Grand Strategy, ViperTCG, Battle Lines, or Wowzaworka
retain their original nine-, ten-, twelve-, thirteen-, fourteen-, or fifteen-game map. They remain valid history
for the 72-hour schedule; new exports require all sixteen games and do not rewrite old files.

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

## Litigation and Hollowtide

- Litigation — https://litigation.gameslop.now — solo pixel horror with keyboard controls and checkpoint saves.
- Hollowtide — https://hollowtide.gameslop.now — fantasy exploration for 1–4 players, with online co-op or solo play and keyboard/mouse controls.

Their private source repositories are `bridger2500/litigation` and `bridger2500/hollowtide`.
Each builds independently with Vite. Caddy serves only the production assets under
`/opt/gameslop-static/<slug>/current/site`; development servers and editor write endpoints are
not exposed. Successful checks on a push or merge to each repository's `main` publish that
exact build using its own restricted deployment key. PRs still require an ordinary merge.

The collector hashes each active `site/` and uses the matching `release.json` deployment date
for its first observation. Later content changes update that game's date while unchanged games
retain theirs. Both new counter rows start at zero and preserve existing totals and export history.
Hollowtide's online rooms use its same-origin co-op service. One browser hosts the shared world;
the host must keep the game open. Quests, enemies, dungeon trips and the sloop are shared.
The host's separate party save preserves progression for returning players, while solo saves
remain separate.

## MDCCCII — Grand Strategy, World 1754

- MDCCCII — https://grandstrat.gameslop.now — solo or online grand strategy on a world map from May 1754,
  with one player per controllable nation and up to 16 players per campaign. Create a campaign, share its
  invitation link, and choose distinct nations; the AI runs unclaimed nations. The host controls
  the shared clock. Campaigns save on the server and players can reconnect to their seats.
  Exploration, colonies, trade, diplomacy, armies, fleets, and tactical battles support keyboard, mouse, and touch.

The source repository is `bridger2500/grandstrat`. Its Vite build is served independently from
`/opt/gameslop-static/grandstrat/current/site`. The `grandstrat` counter starts at zero while existing
lifetime totals, weekly events, and the weekly tracking start remain intact. The collector fingerprints
only the active public assets and reads their matching `release.json` deployment date. Adding this
card or redeploying unchanged game files does not change the existing games' update dates. Historical
twelve-game exports remain valid for the same 72-hour schedule.

## ViperTCG

- ViperTCG — https://vipertcg.gameslop.now — an animal trading card game for one or two players.
  Play the AI or invite a friend to a private room for a match or a shared draft. Build decks or edit cards.
  The game uses mouse controls; card and deck customizations are saved in this browser.

The source repository is `adamxu1999-hub/ViperTCG`. Its plain JavaScript modules and CSS are
served from `/opt/gameslop-static/vipertcg/current/site`. Friend rooms use the same-origin
`/multiplayer` WebSocket endpoint and a private server runtime; they do not use PeerJS or
browser-to-browser connections. The independent checked-release workflow publishes tested
client and server builds through its restricted deployment account. The portal does not deploy game code.

The new `vipertcg` counter starts at zero without resetting any existing lifetime totals, weekly
events, or the weekly tracking start. Its update date comes from the matching static release
manifest, and unchanged content retains its original date. The exporter accepts all prior catalog
sizes as history while requiring all sixteen game counters in new snapshots.

## Battle Lines: World at War

- Battle Lines: World at War — https://battlelines.gameslop.now — solo first-person conquest on a
  Verdun-inspired battlefield. Choose France or Germany, fight alongside 100 AI soldiers per army,
  capture command posts and exhaust the enemy reinforcement tickets. Requires a desktop browser
  with WebGL, pointer lock, and keyboard/mouse controls. This release does not include multiplayer.

Its independent production build is served from `/opt/gameslop-static/battlelines/current/site`.
The portal does not deploy game code. Its counter starts at zero; adding it preserves the other
fourteen games’ lifetime totals, weekly events, tracking start, update dates, and export history.
The collector uses its matching release manifest for the initial update date and only advances
that date when the game content changes. New exports include all sixteen counters; historical
fourteen-game exports retain their existing 72-hour schedule. Verify the game is live before
publishing this catalog entry.

## Wowzaworka

- Wowzaworka — https://wowzaworka.gameslop.now — a solo neon arcade game with keyboard and touch controls. Collect wowzas, dash through grumps, and chain combos for a WOWZA! blast.

This game is part of `zanedurante/gameslop-games`, served from
`/opt/gameslop/current/games/wowzaworka`. Its shared lifetime and seven-day play
counters start at zero. Adding it preserves the other fifteen games’ totals,
recent events, tracking start, update dates, and export history.

The catalog collector follows the monorepo release manifest for the first
publication date and only changes it when Wowzaworka’s content changes. Sibling
game releases do not make it appear newly updated. New exports include all
sixteen counters, while historical fifteen-game exports retain the existing
72-hour schedule. Verify the game is live before publishing the portal card.
