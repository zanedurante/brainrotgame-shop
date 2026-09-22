# brainrotgame.shop

The front door for the games: one static page with a card and a link for each of them.

- **Bag Brawl** — https://bagbrawl.app
- **Deadpoint** — https://deadpoint.bagbrawl.app
- **Heads Up** — https://headsup.bagbrawl.app

## How it is served

From the same droplet as the games, the way Heads Up is: Caddy serves `/opt/brainrotgame/site` straight
off disk, with its own site file (`/etc/caddy/brainrotgame.caddy`) imported by the main Caddyfile. There
is no build step and no service to restart. `index.html` is the whole site.

- `npm run provision` — one-time: writes the web root and the Caddy site file on the droplet (safe to rerun).
- `npm run deploy` — copies the page up. That is the whole release.
- `npm run serve` — the page on http://127.0.0.1:3011 for a look before deploying.

Both need SSH to the droplet as root with the owner's key; the address is in `ops/server.env`.

## Adding a game

Copy one of the `<article class="card">` blocks in `index.html`, give it a `--accent` colour, a short
blurb, the meta chips and the link. Keep it to what the game is and how many can play; the game's own
page does the selling. Then `npm run deploy`.

## DNS (Porkbun)

The domain points at the droplet, like the games' hostnames do:

| type | host | answer            |
|------|------|-------------------|
| A    | @    | 24.199.123.123    |
| A    | www  | 24.199.123.123    |

Porkbun's default parking records (the ALIAS/CNAME it creates on a new domain) must be removed first or
they conflict. Once the records resolve, Caddy fetches certificates for both names itself; `www` is
redirected to the bare domain.
