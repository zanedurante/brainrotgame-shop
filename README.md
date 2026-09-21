# brainrotgame.shop

The front door for the games: one static page with a card and a link for each of them.

- **Bag Brawl** — https://bagbrawl.app
- **Deadpoint** — https://deadpoint.bagbrawl.app
- **Heads Up** — https://headsup.bagbrawl.app

## How it is served

GitHub Pages, straight from the `main` branch root. There is no build step: `index.html` is the whole
site, and `CNAME` tells Pages which domain it answers to. Push to `main` and the site updates within a
minute.

## Adding a game

Copy one of the `<article class="card">` blocks in `index.html`, give it a `--accent` colour, a short
blurb, the meta chips and the link. Keep it to what the game is and how many can play; the game's own
page does the selling.

## DNS (Porkbun)

The domain's records point at GitHub Pages:

| type  | host | answer                    |
|-------|------|---------------------------|
| A     | @    | 185.199.108.153           |
| A     | @    | 185.199.109.153           |
| A     | @    | 185.199.110.153           |
| A     | @    | 185.199.111.153           |
| CNAME | www  | zanedurante.github.io     |

Porkbun's default parking records (the ALIAS/CNAME it creates on a new domain) must be removed first or
they conflict with the A records. Once the records resolve, GitHub Pages issues the certificate itself
and "Enforce HTTPS" can be switched on in the repository's Pages settings.
