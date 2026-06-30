# ASE Live — Mobile Prices

A lightweight, mobile-first web app showing live prices from the **Amman Stock Exchange (ASE)**, sourced from the public ASELive market-watch endpoints.

A small zero-dependency Node proxy holds an ASELive session, fetches the JSONP market endpoints, parses them into clean JSON, and serves a single mobile page.

## Features

- **Live price list** — all ~97 instruments with last price and % change, color-coded, auto-refreshing every few seconds.
- **Company names** beside every symbol.
- **Market index header** — ASE general index value, change, volume, turnover, trades.
- **Tabs** — All · Watch · Gainers · Losers · Active.
- **Watchlist** — star any symbol; persisted per-device in `localStorage`.
- **Symbol detail sheet** — tap any symbol for:
  - Current price, Open, Previous Close, High, Low
  - A mini intraday price chart (with previous-close baseline)
  - 5-level order book (bid/ask) and the recent-trades tape
- **Resilient session** — auto re-logs-in if the upstream session expires, plus a periodic keep-alive.

## Live

- **GitHub Pages (static, no backend):** https://projectsarta.github.io/ASE/
- **Cloudflare Worker:** https://ase-live.iyas85.workers.dev

## Builds

There are three interchangeable ways to run the same UI:

| Build | File(s) | Backend? | Host |
|---|---|---|---|
| **Static** | `docs/index.html` | None — calls the ASE JSONP endpoints directly via `<script>` injection | GitHub Pages / any static host |
| **Cloudflare Worker** | `src/worker.js` + `public/index.html` | Edge worker proxies the ASE endpoints | Cloudflare |
| **Node** | `server.js` + `public/index.html` | Local Node proxy | localhost |

The static build is the simplest — no server, no session, just a single HTML file.

## Run locally

Requires **Node 18+** (uses the built-in `fetch`). No runtime dependencies.

```bash
node server.js
# → http://localhost:3737
```

Change the port with `PORT=8080 node server.js`.

## Deploy (Cloudflare Worker)

The same app also runs on Cloudflare Workers — `public/index.html` is served as a
static asset and `src/worker.js` handles the `/api/*` routes by fetching the public
ASE endpoints from the edge (no session needed). Config is in `wrangler.jsonc`.

```bash
npm install        # installs wrangler (dev dependency)
npx wrangler login # one-time browser auth
npx wrangler deploy
```

## Project structure

```
server.js          # session + proxy + JSONP→JSON + API + static serving
public/index.html  # mobile-first UI (single file)
package.json
```

## API (proxy → clean JSON)

| Route | Description |
|---|---|
| `GET /api/ticker` | All symbols: `{ sym, name, last, chg }` |
| `GET /api/index` | ASE index: value, change, OHLC, volume, turnover, trades |
| `GET /api/quote?symbol=X` | Per-symbol OHLC: current, open, high, low, prevClose, change |
| `GET /api/depth?symbol=X` | 5-level order book (bid/ask) |
| `GET /api/intraday?symbol=X` | Today's trade tape |
| `GET /api/gainers` · `/api/losers` · `/api/active` | Named lists |

## How the data is sourced

The ASE data endpoints (`ticker`, `index`, `gainers`, `losers`, `depth`, `intraday`)
are served by ASELive's market-watch site. The proxy parses their JSONP responses
(`fn(new Array(...), ...)`) into JSON. Per-symbol OHLC is built from the intraday
trade tape, with previous-close derived from the ticker's last price and change%
(verified to match the official market-watch figures).

> **Note:** Data is delayed (~1.5s per ASE) and reflects only what ASELive exposes.
> This project is intended for **personal / educational use**. Before deploying it
> publicly or in front of clients, confirm you have the right to redistribute ASE
> market data (ASE data licensing / ICE).

## Disclaimer

Not affiliated with or endorsed by the Amman Stock Exchange. Provided as-is, with no
guarantee of accuracy or availability. Do not rely on it for trading decisions.
