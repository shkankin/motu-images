# MOTU Collector — Pricing Backend

Market values in MOTU Collector are **optional** and powered by a tiny
backend **you deploy yourself** — a single Cloudflare Worker
(`pricing-worker.js`). The app never talks to eBay directly: eBay
credentials need a server, and this keeps yours out of the client.

No backend configured? The app works fully — the market-value sections in
Stats, figure details, and the itemized report simply stay hidden.

**Cost: $0.** Cloudflare Workers' free tier (100k requests/day) and Workers
KV comfortably cover a personal collection; the worker caches every
positive lookup for 24h, so most days it barely works at all.

## What it does

| Route | Purpose |
| --- | --- |
| `GET /pricing/<figId>` | Price data for one figure, in the shape the app expects |
| `POST /pricing/bulk` | Batch lookup, 1–50 figure ids (used by "Fetch prices") |
| `GET /health` | Status + which provider chain is active |
| `POST /admin/community/<figId>` | Write a curated price (requires `ADMIN_TOKEN`) |

Prices come from a **provider chain** (`PROVIDER_CHAIN` env var), tried in
order until one answers:

- `community` — your own curated prices in Workers KV. Zero API cost,
  authoritative when present.
- `ebay-sold` — eBay Marketplace Insights (true *sold* prices). Requires
  eBay partner approval; errors until your account has it.
- `ebay-active` — eBay Browse API (*asking* prices). No special approval
  needed; the app labels these as asking prices, honestly.
- `apify-sold` — real eBay *sold* prices from the last 90 days, through an
  Apify scraper (`caffein.dev~ebay-sold-listings` unless `APIFY_SOLD_ACTOR`
  says otherwise). Unofficial and paid per result, so it is cost-guarded: a
  paid lookup starts only when the app asks with `?sold=1` (the figure
  screen's "Check sold" button), runs in the background and is collected by
  the app's next request; results are kept `SOLD_CACHE_DAYS` (default 30);
  at most `APIFY_DAILY_RUNS` (default 15) runs a day, each capped at 25
  results and $0.25. Every other lookup only reads saved sold results.
- `stub` — deterministic fake data for development.

Default chain: `community,ebay-active`. Once/if eBay approves Marketplace
Insights for your account, switch to `community,ebay-sold,ebay-active`.

**Turning on sold prices (Apify):** in the worker's Settings → Variables,
add the secret `APIFY_TOKEN` (your Apify API token) and set
`PROVIDER_CHAIN` to `apify-sold,ebay-active`. Optional variables:
`APIFY_SOLD_COUNT`, `APIFY_SOLD_DAYS`, `APIFY_DAILY_RUNS`, `SOLD_CACHE_DAYS`.

## Deploy (about 15 minutes)

1. **Cloudflare account** (free) → install `wrangler` (`npm i -g wrangler`,
   then `wrangler login`).
2. **eBay developer keys** (free): create an app at
   [developer.ebay.com](https://developer.ebay.com) → note the **App ID**
   and **Cert ID** (production keyset).
3. **Create KV namespaces**:
   ```sh
   wrangler kv namespace create PRICING_CACHE
   wrangler kv namespace create COMMUNITY_PRICES
   ```
   Put the returned ids in `wrangler.toml` alongside this worker.
4. **Set secrets**:
   ```sh
   wrangler secret put EBAY_APP_ID
   wrangler secret put EBAY_CERT_ID
   wrangler secret put ADMIN_TOKEN     # any long random string; guards /admin
   wrangler secret put APP_KEY         # recommended: any long random string; see "App key" below
   wrangler secret put EBAY_AUTH_TOKEN # optional: Trading API token for watched sales
   ```
5. **Set vars** in `wrangler.toml`: `ALLOWED_ORIGINS` — your app's origin(s),
   comma-separated (CORS allow-list; requests from anywhere else are
   refused). Optionally `PROVIDER_CHAIN` and `MIN_SAMPLES`.
6. **Deploy**: `wrangler deploy pricing-worker.js` → note the
   `https://….workers.dev` URL.
7. **Point the app at it**: in MOTU Collector, open the Stats sheet's
   market-value section (or Settings) → enter the worker URL. `/health`
   in a browser should answer `{"status":"ok", …}` — if it does, the app
   will too. The URL rides the settings export, so a new device restores it.

## Good to know

- **App key (recommended).** Without it, anyone who learns your worker's
  address can start a paid sold lookup, force live eBay calls or add figures
  to the watch list. Add the secret `APP_KEY` (any long random string), then
  enter the same value in the app under Menu → Pricing Backend → API key.
  Sold lookups, refreshes and watch-list adds then need that key; ordinary
  cached lookups do not. Open `<your worker>/health` — `"appKey": true`
  means the check is on. Leave `APP_KEY` unset and nothing changes.

- **Caching:** positive results cache in KV for 24h; the app caches
  on-device for 24h (usable for 7 days). Negative results are never
  cached, so a figure with no listings retries naturally.
- **Rate limiting:** cache-*bypass* lookups (`?fresh=1` / bulk `fresh`)
  are limited to 10/minute per IP. Normal cached reads are unlimited —
  they're cheap KV hits.
- **Watched sales (sold history):** every figure the app looks up is
  watched. An hourly Cron Trigger (`17 * * * *`) searches eBay for its
  auctions and Buy It Now listings, and once a listing ends it asks the
  Trading API (`GetItem`, which still reads ended listings) whether it sold
  and for how much, shipping included. Needs one more secret,
  `EBAY_AUTH_TOKEN` — an Auth'n'Auth user token from developer.ebay.com
  (User Tokens page). Without it listings are watched but no sales are
  recorded. `/health` shows the last run. Free-plan safe: 4 searches and
  15 GetItem calls per run.
- **Asking vs sold:** every answer carries `asking` (current Buy It Now)
  and `sold` (watched sales plus any Apify sold lookups, duplicates
  dropped, last 90 days) side by side — they are never averaged together.
- **Community prices:** `POST /admin/community/<figId>` with your
  `ADMIN_TOKEN` writes an authoritative price and busts that figure's
  cache. Useful for figures eBay searches match poorly.
- **Security posture:** eBay secrets live only in Worker secrets; the
  app-facing endpoints are read-only; the one write endpoint requires the
  admin token; CORS restricts which sites a BROWSER will expose the response to — it does not stop scripts or servers calling the worker directly.

This README documents capabilities, not versions — the worker's changelog
lives at the top of `pricing-worker.js`.
