# brainrotgame.shop · gameslop.now

The front door for nine games, answering on two domains. Each card shows the shared total of Play
button clicks, and the catalog ranks games by that total. The header and title say whichever name
the visitor typed; both domains use the same counters.

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

`GET /api/plays` returns `{ "counts": { "deadpoint": 225, ... } }` for all nine fixed game IDs.
`POST /api/plays/<game-id>` with an empty body adds one and returns the updated snapshot. The browser
sends this request without delaying navigation, including keyboard activation and new-tab clicks.
Counts measure clicks from the portal, not sessions, unique people, or visits directly to a game.
No accounts, cookies, IP addresses, or other visitor identifiers are stored by the counter.

The owner requested initial totals of **225 for Deadpoint**, **30 for Bag Brawl**, **10 for Primordial**,
and **0 for every other game**. These initialize new database rows only; restarts and redeployments
never reset existing totals. Equal totals retain the original catalog order (Primordial, then
Primordial: Tactics, followed by the other games). Once a visitor interacts with a card, its position
stays stable for that visit so links do not move under the pointer or keyboard focus. Counts still
refresh when returning through the browser's back/forward cache.

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

## Adding a game

Copy one of the `<article class="card" data-game="...">` blocks in `index.html`, give it a unique
`data-game` ID, `--accent` colour, short blurb, meta chips, Play link, and `data-play-count` label.
Add the same ID with a zero starting total to the backend's fixed game map in `counter/server.py`.
Keep it to what the game is and how many can play; the game's own page does the selling. Run the tests
and then `npm run deploy`.

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
