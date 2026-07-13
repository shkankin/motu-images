# MOTU Collector

A fast, private, installable web app for tracking a Masters of the Universe
action-figure collection — every line from vintage to Origins, Masterverse,
Turtles of Grayskull, and beyond.

**Official site: [motucollector.app](https://motucollector.app)**

**No account. No server holding your data. No ads. Free.**
Your collection lives on your device; the app is just a static site.

> Formerly known as *MOTU Vault*. Internal storage identifiers keep the old
> name on purpose — see [Data & privacy](#data--privacy).

## Why this instead of CLZ / hobbyDB / iCollect

- **Local-first and private.** Everything is stored on your device
  (IndexedDB). There is no account, no sync server, and nothing to subscribe
  to. Backups are files you own.
- **Completeness tracking nobody else has.** Every figure carries its
  accessory loadout — mark what each of your copies actually includes and
  the app computes per-copy completeness, not just "owned."
- **Value tracking without a paywall.** Market values from eBay sold
  listings (bring your own pricing backend), a daily collection-worth
  history with trend chart, and spend/value stats — features competitors
  charge monthly for.
- **Scan-to-verdict.** Point the barcode scanner at a figure in a store and
  the app answers the only question that matters: *do I already own this?*
- **Insurance-grade documentation.** One tap builds a printable itemized
  inventory (condition, paid, acquired, market value, photos) for
  insurance or estate purposes.
- **Built for one collection done deeply, not a thousand done shallowly.**
  Multi-copy support with per-copy condition/price/photos, sold-log with
  realized gains, want-list share links with QR codes, celebration
  milestones, and a theming system with more Easter eggs than is strictly
  responsible.

## Quick start

1. **Open the app** and (on mobile) choose *Add to Home Screen* — it
   installs as a full app and works offline.
2. **Mark what you own.** Tap the status ring on any figure: wishlist →
   ordered → owned → for sale. Long-press for multi-select batch actions.
3. **Add detail as you go.** Each owned figure supports multiple copies,
   each with condition, price paid, acquisition date, storage location,
   photos, and accessory completeness.
4. **Find anything.** Search, per-line browsing, and a filter sheet
   covering status, condition, wave, faction, variants, loadout gaps, and
   data completeness.
5. **Back up.** Export → full JSON backup (includes photos). Do this
   periodically; the app will nag you when you're overdue. Settings and
   photos can also be exported separately.

## Feature tour

- **Collection** — owned / ordered / for-sale view with spend totals,
  recently-changed strip, list or grid display, rich sorting.
- **Lines** — per-line progress with sublines, hide lines you don't chase.
- **Stats** — completion, spend by year, activity timeline, market-value
  dashboard, collection-worth-over-time chart, milestones, data-gap audit.
- **Pricing** — optional self-hosted pricing worker fetches eBay sold
  medians; values are cached on-device and drive stats and reports.
  Setup guide: [`backend/README.md`](backend/README.md).
- **Photos** — per-figure photo gallery with per-copy assignment, stored
  on-device (OPFS), exportable as a ZIP.
- **Sharing** — compact want-list links (with QR) that open a read-only
  view for trading partners; no account needed on either side.
- **Import/Export** — JSON backup/restore, CSV export, CSV import
  (including AF411-format), settings-only transfer for new devices.
- **Desktop / tools** — `desktop.html` (read-only desktop viewer and
  shared-list target; plain desktop-browser visits to the app are routed
  here automatically — "Use the full app →" opts out, remembered),
  `figures-editor.html` (catalog maintenance), `deploy.html` (release
  tool).

## Data & privacy

All collection data lives in your browser's IndexedDB under the database
name `motu-vault` (the app's original name — kept so no user's data is ever
orphaned by a rebrand). Storage keys, backup format identifiers
(`motu-vault-backup-v*`), and the installed app's start URL likewise keep
their original names for compatibility. Nothing leaves your device except:
requests for the figure catalog/images, optional pricing lookups to a
backend **you** configure, and want-list links you explicitly share.

Backups are plain JSON — readable, portable, yours.

## Development

Static site, no build step, no framework: vanilla ES modules + a service
worker. CI runs three gates on every push — inline-handler/action wiring,
window-bridge integrity, and ESLint `no-undef` — each of which exists
because it would have caught a real shipped bug.

**The versioned changelog lives at the top of `sw.js`** and is the single
source of truth for what changed when. This README deliberately documents
*capabilities, not versions*, so it stays accurate between releases; if a
feature is added or removed, update the relevant section here in the same
release.

## Credits

Catalog data and figure imagery sourced from
[ActionFigure411](https://www.actionfigure411.com/) — go browse their
site; this app links every figure back to its AF411 page. This is a
non-commercial fan project, unaffiliated with Mattel or AF411.
