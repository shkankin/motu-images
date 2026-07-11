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
- `stub` — deterministic fake data for development.

Default chain: `community,ebay-active`. Once/if eBay approves Marketplace
Insights for your account, switch to `community,ebay-sold,ebay-active`.

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

- **Caching:** positive results cache in KV for 24h; the app caches
  on-device for 24h (usable for 7 days). Negative results are never
  cached, so a figure with no listings retries naturally.
- **Rate limiting:** cache-*bypass* lookups (`?fresh=1` / bulk `fresh`)
  are limited to 10/minute per IP. Normal cached reads are unlimited —
  they're cheap KV hits.
- **Community prices:** `POST /admin/community/<figId>` with your
  `ADMIN_TOKEN` writes an authoritative price and busts that figure's
  cache. Useful for figures eBay searches match poorly.
- **Security posture:** eBay secrets live only in Worker secrets; the
  app-facing endpoints are read-only; the one write endpoint requires the
  admin token; CORS restricts which sites may call it at all.

This README documents capabilities, not versions — the worker's changelog
lives at the top of `pricing-worker.js`.
