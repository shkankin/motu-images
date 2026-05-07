# MOTU Vault

A catalog and collection tracker for Masters of the Universe action figures.
Mark what you own, build a wishlist, share it with friends, and track copies,
accessories, and prices paid.

**Live app:** [shkankin.github.io/motu-images/motu-vault.html](https://shkankin.github.io/motu-images/motu-vault.html)

---

## What it does

- **Catalog of every figure** across Origins, Masterverse, Classics, 200X,
  Vintage, Eternia Reissues, He-Man (2002), New Adventures, Princess of
  Power, MOTU Movie, Kids Core, and more — pulled from
  [ActionFigure411](https://www.actionfigure411.com/masters-of-the-universe/).
- **Mark what you own** — Owned, Wishlist, Ordered, For Sale. Multiple
  copies per figure with separate condition, paid price, variant,
  accessories, and notes for each.
- **Photos** stored locally (OPFS where available, localStorage fallback)
  with pinch-zoom, swipe navigation, and per-photo labels.
- **Wishlist sharing** — generate a QR code or short URL of your wishlist.
  Anyone can scan/open it without an account; viewed wishlists are saved
  in their history for re-opening later.
- **Stats** — collection progress per line, total spent, monthly activity,
  spend by year.
- **Custom figures** — add things the catalog doesn't cover via a separate
  editor.
- **Themes** — Eternia, Castle Grayskull, He-Man, Skeletor, and more.
- **Loadouts** — per-figure accessory checklists with completion tracking.
- **Pricing backend (optional)** — connect to a Cloudflare Worker for
  recent-sold averages from eBay or community-curated data; see
  `backend/README.md` if you want to deploy your own.

## What makes it different

- **Works offline.** Service worker pre-caches the app shell. Once loaded,
  the catalog and your collection are available without a network.
- **No account, no signup.** Your data lives in your browser's local
  storage. Nothing leaves your device unless you explicitly export a
  backup or configure a pricing backend.
- **No ads, no tracking.** Static site on GitHub Pages. The only network
  request the app makes by default is for the figure catalog.
- **Free to install as a PWA** on iOS and Android — feels like a native
  app, no app store, no review delays.

## Install on your phone

### iPhone / iPad (Safari)

1. Open [the app](https://shkankin.github.io/motu-images/motu-vault.html) in
   Safari (iOS install only works from Safari, not Chrome on iOS).
2. Tap the **Share** button at the bottom of the screen.
3. Scroll down and tap **Add to Home Screen**.
4. Tap **Add** in the top-right corner.

The app icon now lives on your home screen and launches full-screen.

### Android (Chrome / Edge / most browsers)

1. Open [the app](https://shkankin.github.io/motu-images/motu-vault.html) in
   Chrome.
2. Tap the **⋮** menu in the top-right corner.
3. Tap **Add to Home screen** (or **Install app** if shown).
4. Confirm.

You also get app shortcuts via long-press on the icon: Share Want List,
Stats, Quick Sync, Settings.

### Desktop

In Chrome/Edge: an install prompt appears in the address bar (look for the
small monitor-with-down-arrow icon). Click it. The app gets its own window
and launcher entry.

## Reporting bugs / requesting features

[Open an issue on GitHub](https://github.com/shkankin/motu-images/issues).
Include:
- Browser + OS (e.g. "iOS 18 Safari", "Android 14 Chrome")
- What you were trying to do
- What happened vs. what you expected
- A screenshot if it's a visual issue

## Privacy

- Your collection lives in your browser's `localStorage` and OPFS (for
  photos).
- The only outbound request the app makes by default is `figures.json`
  from `raw.githubusercontent.com` (the catalog).
- Optional pricing backend: if you connect one in Settings, the app sends
  figure IDs to your configured URL. No identity, no cookies. See
  `backend/README.md` for what the reference Cloudflare Worker does.
- No analytics, no telemetry, no third-party scripts.
- Backups (JSON exports) stay on your device.

## Built by

**Brandon R.**

With:
- [ActionFigure411](https://www.actionfigure411.com/masters-of-the-universe/)
  as the figure catalog source
- [Claude](https://www.anthropic.com/claude) (Anthropic) as a coding
  collaborator

## License

[CC BY-NC 4.0](https://creativecommons.org/licenses/by-nc/4.0/)

Free to use, share, and modify for personal or non-commercial purposes.
Please credit the original work. Not for sale or commercial redistribution.

## Disclaimer

Masters of the Universe is a trademark of Mattel. This is an unofficial
fan-made tool and is not affiliated with, endorsed by, or sponsored by
Mattel.
