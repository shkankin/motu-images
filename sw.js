// MOTU Vault — Service Worker v7.15
// HTML: network-first with cache fallback (always current version on load)
// figures.json: network-first
// Images: cache-first + time-bucketed background revalidation (v6.98)
//
// v7.25 changelog:
//   • CACHE bumped to v7.25. SHELL: data.js + app.js + render.js +
//     share.js + state.js. App v7.51. Also ships deploy.html v1.11,
//     eslint.config.mjs (new), lint.yml (new CI step).
//   • FIX (user-reported with screenshot — the v7.50 error toast working
//     as designed): both report buttons failed with "getCachedAskingPrice
//     is not defined". buildInsuranceReport (v6.69) called it without
//     importing it from pricing.js — the report has thrown on its first
//     market-value lookup since the day it shipped; pre-v7.50 that was a
//     silent unhandled rejection.
//   • That's the SECOND shipped bare-identifier ReferenceError (after
//     v7.45's sourceName), so the promised permanent gate is now in:
//     eslint no-undef in CI (single-rule config, eslint.config.mjs). Its
//     first run found FOUR more: two real crashes — app.js journal
//     recovery called bigSet unimported inside a silent catch{}, so
//     recovered journal changes were applied in-memory but never
//     persisted and the journal was then deleted (quiet data-loss path);
//     render.js's Kids Core admin sheet used KIDS_CORE_KEY unimported and
//     crashed on open — and two working-by-luck bare references to
//     window-assigned functions (data.js handleCSV, share.js qrEncode)
//     plus state.js's quota-warning toast, all made explicit window.*
//     calls. ESLint now passes clean on all 15 modules + sw.js.
//
// v7.24 changelog:
//   • CACHE bumped to v7.24. SHELL: data.js + render.js. App v7.50.
//   • FIX (user-reported): Itemized Report (HTML) — "without photos"
//     failed instantly, "with photos" silently did nothing for 10+
//     minutes. Two root causes:
//     (1) Delivery: the report revoked its blob object-URL synchronously
//     after a.click(). The click only QUEUES the download — Android's
//     download manager fetches the blob URL afterwards, and a revoked
//     URL fails the download on the spot. Small files (JSON backup)
//     usually won the race; the larger HTML report lost it. New
//     _downloadBlobSafe() helper revokes after 60s; ALL six blob
//     download sites converted (report, JSON backup, both CSVs, photo
//     ZIP, settings) so the race is dead app-wide.
//     (2) Scale: with-photos embedded each photo's FULL-SIZE data URL
//     and grew the document by quadratic string concatenation — a
//     multi-hundred-MB string build that ground silently. Photos are
//     now canvas-downscaled to 320px JPEG (~20–40KB each) via
//     _shrinkForReport(), the document assembles as an array of parts
//     handed straight to the Blob, a progress toast ticks every 100
//     figures, and the whole build is try/caught with a visible error
//     toast (previously an unhandled rejection with zero feedback). The
//     success toast now reports the file size.
//
// v7.23 changelog:
//   • CACHE bumped to v7.23. SHELL: render.js. App v7.49.
//   • Removed the v7.46 status chip row from the Collection tab (user
//     feedback with screenshot): every option it offered (All / Owned /
//     Ordered / Want List / For Sale) already exists as a Status chip in
//     the filter sheet, so the row was redundant UI occupying prime list
//     space. The v7.46 semantics stay: wishlist remains excluded from the
//     default Collection view and reachable via the filter sheet; the
//     Recently-changed fix and the aligned nav badge are untouched.
//
// v7.22 changelog:
//   • CACHE bumped to v7.22. SHELL: eggs.js + render.js. App v7.48.
//   • FIX round 2 (user-reported with screenshot): AF411 still blocked by
//     Cloudflare from inside the PWA after v7.47. The screenshot confirmed
//     v7.47 did produce a real Custom Tab — but AF411's WAF serves the
//     hard "Attention Required" block for it anyway. A Custom Tab
//     launched from an installed web app is still distinguishable from
//     plain Chrome (app-origin Referer; X-Requested-With package header
//     on many versions) and web code cannot strip either. openExternal()
//     now escapes the Custom Tab entirely: on Android in standalone
//     display mode it navigates to an intent:// URL, which Android
//     resolves to the DEFAULT BROWSER APP — the exact context the user
//     confirmed works — with S.browser_fallback_url preserving the old
//     behavior anywhere intents don't resolve. Non-standalone and
//     non-Android contexts keep the anchor path, now with noreferrer so
//     the PWA origin is never sent as a Referer.
//
// v7.21 changelog:
//   • CACHE bumped to v7.21. SHELL: eggs.js + render.js. App v7.47.
//   • FIX (user-reported): the AF411 button on the figure detail screen
//     opened a "blocked by Cloudflare" page from inside the installed PWA
//     while the same URL opened fine in Chrome. openAF411 used
//     window.open(url, '_blank', 'noopener') — a window-FEATURES string as
//     the third argument makes the call a POPUP, and from a standalone
//     PWA on Android that popup gets a stripped browsing context
//     (partitioned cookies, popup disposition) that fails Cloudflare's
//     bot challenge. All three AF411 open paths (figure deep link, group
//     index, all-figures fallback) now go through a new openExternal()
//     helper that synthesizes a real anchor click — normal navigation
//     semantics, so Android hands the URL to a full Chrome Custom Tab
//     with first-party cookies, matching Chrome-app behavior. These were
//     the only three window.open call sites in the app; the static
//     external links in the About/onboarding sheets were already real
//     <a target="_blank"> anchors and were never affected.
//
// v7.20 changelog:
//   • CACHE bumped to v7.20. SHELL: render.js + data.js. App v7.46.
//   • FIX (user-reported with screenshot): "Recently changed" on the
//     Collection tab kept showing a figure whose status change had been
//     UNDONE (accidental "owned" tap, reverted). The pinned strip rendered
//     the recent ids with no status check, so a figure that was no longer
//     in the collection stayed pinned on the collection page. The strip
//     now pins only figures whose current status is part of the
//     collection view; the id stays in the recent ring so re-statusing a
//     figure brings it back.
//   • Collection tab semantics (user feedback): the tab now means
//     "figures in or on the way into your possession" — owned, for-sale,
//     and ordered. Wishlist is out of the DEFAULT view (a want list is a
//     shopping list, not a collection; ordered stays because it's
//     paid-for and incoming) but one tap away via a new status chip row
//     on the tab: All · Owned · Ordered · Want List · For Sale, with live
//     counts. Chips reuse the existing filterStatus plumbing, so the
//     filter sheet and "Reset all filters" stay in sync. The bottom-nav
//     Collection badge now counts owned + ordered + for-sale to match
//     what the default view actually shows (previously owned only, while
//     the list displayed every status including wishlist).
//
// v7.19 changelog:
//   • CACHE bumped to v7.19. SHELL: ui-sheets.js + render.js. App v7.45.
//   • FIX (user-reported with screenshot): tapping Edit on the figure
//     detail screen crashed to the error boundary with "sourceName is not
//     defined". ui-sheets.js's edit sheet Name row referenced a bare
//     `sourceName` identifier — a ReferenceError thrown the moment the
//     sheet rendered, for EVERY figure, since the line landed. (Bare
//     identifiers in template literals are valid syntax, so node --check
//     and the handler lint can't see this class; it only explodes at
//     render time.) Now `f.sourceName && !ov.name`, the same source-hint
//     pattern as the group/wave/year/retail rows beside it. A heuristic
//     sweep of all 15 modules for the same bug class (bare identifiers in
//     ${...} with no declaration in scope) found no other genuine
//     instance — every other hit resolved to a declared local or
//     parameter on inspection.
//
// v7.18 changelog:
//   • CACHE bumped to v7.18. SHELL: pricing.js + app.js + render.js. App
//     version v7.44.
//   • FIX (user-reported): bulk-fetched prices vanished "hours later" —
//     i.e. on the next launch. Root cause: pricing.js persisted the whole
//     cache as ONE localStorage blob via store.set(), which catches
//     QuotaExceededError and returns false, and _saveCache() never checked
//     the return. On a large collection sharing localStorage's ~5MB with
//     the collection journal, photo labels, etc., the write silently
//     failed; the in-memory copy kept working all session (everything
//     looked fine), then the next boot loaded the last blob that DID fit —
//     stale or empty. motu-pricing-cache and motu-pricing-history now live
//     in the IndexedDB big-value store (idb-store.js), same engine as the
//     collection: synchronous memory mirror, background IDB writes
//     (hundreds-of-MB quota), localStorage only as a fallback. Both keys
//     are hydrated at boot; hydrate()'s native migration adopts any legacy
//     localStorage copy into IDB and frees the old key after a CONFIRMED
//     write — which also returns that quota to everything still in
//     localStorage. Reads are guarded against memoizing a pre-hydration
//     fallback (which could otherwise shadow and later overwrite the real
//     persisted cache). If persistence genuinely can't happen (no IDB AND
//     localStorage broken), a loud one-time toast says so instead of the
//     old silent loss. Verified with a full-lifecycle simulation:
//     legacy-migration boot → 600-figure bulk fetch → fresh launch, cache
//     intact.
//
// v7.17 changelog:
//   • CACHE bumped to v7.17. SHELL: eggs.js + render.js. App version v7.43.
//   • Milestone ladder: 666 → 600. User-reported: at 588 owned, the next
//     unlock displayed as 666, which reads as anything but celebratory.
//     Orphaned ms:666 keys (none should exist) are ignored harmlessly —
//     getMilestoneDates() only surfaces thresholds present in MILESTONES.
//
// v7.16 changelog:
//   • CACHE bumped to v7.16. SHELL: stats.js + eggs.js + photos.js + app.js
//     + render.js. App version v7.42 — feature release after a competitive
//     audit of hobbyDB, CLZ, and iCollect Everything.
//   • Vault Worth over time (stats.js): one compact local snapshot per day
//     {ts, owned, copies, paid, est. value} recorded on boot (deferred 3s,
//     throttled to ~20h, same-day refresh when value moves >1% so a bulk
//     price-fetch shows immediately), capped at 730 entries under
//     motu-value-history. Stats sheet gains a dual-line SVG trend chart
//     (market value vs cumulative paid) with a 30-day delta. Per-copy value
//     precedence matches the insurance report: cached asking price →
//     retail → paid. This is hobbyDB's flagship paid feature, here local
//     and free.
//   • Scan-to-verdict (photos.js): the barcode scanner now announces the
//     ownership verdict at the shelf instead of echoing digits — "⚠
//     ALREADY IN YOUR VAULT — <name> (N copies)" / on your want list /
//     already ordered / found-but-unowned. UPC matching strips leading
//     zeros on both sides so UPC-A scans match EAN-13 stored codes and
//     vice versa. Kills the duplicate-purchase story every competitor's
//     marketing opens with.
//   • Collection milestones (eggs.js): crossing 10/25/50/…/2000 owned
//     figures fires the existing confetti+horn celebration once (a bulk
//     import that jumps several thresholds celebrates only the highest;
//     the skipped ones are still marked achieved). Achievement DATES are
//     recorded (Date.now() in the same motu-celebrated store; legacy
//     line/subline booleans untouched). Stats sheet gains a Milestones
//     section: achieved trophy chips with dates + a progress bar to the
//     next threshold. Milestone check runs before line/subline completion
//     so one action produces at most one celebration.
//
// v7.15 changelog:
//   • CACHE bumped to v7.15. SHELL: data.js + render.js + delegate-handlers.js
//     + share.js. App version v7.41. Also ships desktop.html v1.7 and
//     lint_handlers.mjs v1.1 (neither is SHELL-cached).
//   • share.js: want-list encoding no longer assumes catalog trailing
//     numbers are unique — a real collision exists in the live catalog
//     (13924: "Battle for Eternia" vs "Grayskull and Snake Mountain
//     Strongholds", both kids-core), the same silent-substitution failure
//     v7.35 fixed for manual figures, found by round-tripping the entire
//     catalog through encode→decode→resolve. Ambiguous figures now encode
//     by FULL id inside the existing 0x01 string-token type (no new type
//     byte — old links and old decoders unaffected); resolution in both
//     checkShareLink and desktop.html tries the manual-code map, then a
//     new full-id map. Verified: all 1291 catalog figures round-trip
//     exactly, zero shadowing between manual codes and full ids.
//   • Follow-up: the 13924 "collision" turned out to be one product, not
//     two — AF411 edited record 13924 in place (renamed "Battle for
//     Eternia" → "Grayskull and Snake Mountain Strongholds"), and
//     sync_af411 (which matches by full slug-based id) saw the new slug as
//     a brand-new figure and appended a duplicate. Three-part fix:
//     (1) figures.json: duplicate removed; the original entry keeps its
//     user-stable id and slug/image and adopts AF411's updated name and
//     retail (manual line/group protections preserved). Catalog back to
//     zero trailing-number collisions. (2) sync_af411.py v1.8: "new"
//     candidates whose trailing AF411 number already belongs to an
//     existing or pending record are classified as renames — suppressed,
//     never queued, existing record untouched, reported loudly in the
//     console and CI summary for manual reconciliation. (3) data.js:
//     FIG_ID_ALIASES remap in migrateColl() — user data saved against the
//     duplicate id migrates to the canonical id on load, merging copies
//     with re-issued ids if data exists under both. The share-encoding
//     ambiguity guard above stays as defense in depth for any future
//     rename that slips through.
//   • The deliberate window-bridge sweep (handoff §1),
//     done proactively this time:
//       – delegate-handlers.js: removed a dead block registering the five
//         'title-tap-*' actions against window.titleTap* functions that were
//         never defined anywhere — the block was silently overwritten by the
//         later (correct) registrations mapping to eggs.js's trigger*Egg
//         bridges, while emitting five '[delegate] re-registering' console
//         warnings at every boot;
//       – 'title-tap-skeletor' pointed at window.triggerSkeletorEgg, which
//         does not exist (Skeletor's egg is the title-cycle path) — now a
//         documented render() fallback, same as the light theme;
//       – lint_handlers.mjs v1.1 adds a third check that makes this whole
//         bug class a CI failure: every window.X read/call in a window-only
//         module must have a window.X assignment somewhere in the app.
//     data.js: _mergeCustomSublines() is now a true clear-then-merge sync
//     (merged entries carry a _custom marker, stripped before each merge) —
//     fixes the documented trap where stale custom sublines persisted in an
//     open tab's memory after loadouts.json was corrected, until a full
//     reload — and the merge call site now runs unconditionally with a {}
//     fallback, so deleting the customSublines key entirely (its current
//     state in the live file) syncs the same way as emptying it. Also
//     removed the dead PER_COPY_FIELDS const/export and its
//     unused import in render.js (flagged in v7.28, confirmed no consumers).
//
// v7.14 changelog:
//   • Both the HTML/navigate fetch and the "everything else" (JS/CSS/etc.)
//     fetch were already coded network-first (v6.16), but neither set an
//     explicit cache mode on the fetch() call — meaning the browser's own
//     HTTP cache (not this SW's Cache API, a separate layer) could still
//     satisfy the request without a real round-trip, serving a stale
//     response the SW would have no way to detect. Reported symptom: v7.13
//     didn't show up in a normal window, only a private one (which had no
//     prior HTTP cache entries to serve stale). Added {cache:'reload'} to
//     both fetch() calls — bypasses the local HTTP cache, still allows the
//     server/CDN to answer 304-not-modified, still populates the SW cache
//     for offline fallback. Also bumped CACHE below to match, so the SW
//     script's own bytes change and the browser's SW-update check (which
//     only fires on a byte diff) actually triggers an activate cycle
//     instead of the old worker just running forever unnoticed.
//
// v7.11 changelog:
//   • state.js SUBLINES: pruned 8 sublines that match zero figures in the
//     current catalog — origins Deluxe, classics Filmation + Other, kids-core
//     Vehicles & Playsets, chronicles Core (Non-Movie), new-adventures Vehicles
//     + Playsets (superseded by the combined entry), cross-brand minis-games.
//
// v7.10 changelog:
//   • state.js SUBLINES: rebuilt the per-line subline definitions that had
//     lived in local storage and were lost — origins (+6), chronicles (+1),
//     new-adventures (+1), cross-brand (+1 Loyal Subjects), and a new
//     mighty-masters entry. Group strings verified against figures.json.
//
// v7.09 changelog:
//   • Finished the v7.00 CSP migration: the long-press context menu and a
//     handful of image onerror fallbacks were still inline handlers (blocked
//     by script-src 'self') — now delegated. getThemeSounds() now resolves
//     theme audio against ROOT (was IMG), fixing the Skeletor title sounds.
//   • Image/sound fetch now caches only res.ok responses (was caching 404s).
//
// v7.08 changelog:
//   • Critical fix: IMG constant pointed to images/ subdir, breaking
//     figures.json, loadouts.json, kids-core.json, and audio file fetches.
//     Split into ROOT (repo root) and IMG (images/ subdir). Data files
//     and audio now use ROOT; figure thumbnails still use IMG.
//   • Removed FigureRealm scraper (sync_figurerealm.py, sync-figurerealm.yml,
//     scripts/fr_cache/, download_fr_images.ps1) — scraping abandoned.
//   • Deploy tool: FigureRealm entries removed from PATH_MAP; Pages status
//     now shows green for non-web commits that do not trigger a Pages rebuild.
//   • IMG path updated: images now served from /images/ subdirectory
//     in the motu-images repo (was repo root). One-line change to the
//     IMG constant in state.js — all figure thumbnails, line cards,
//     theme icons, and photo references inherit this automatically.
//
//     and Accessory Picker were all broken by the v7.00 strict CSP —
//     inline onclick handlers in data.js, stats.js, and share.js were
//     missed in the original migration and silently blocked by
//     script-src 'self'. All migrated to data-action delegation.
//     152 registered actions total (was 131).
//   • deploy.html v1.3: Pages status card added; deploy button restored
//     (was accidentally dropped when Pages card was inserted).
//
//     – New line: MOTU Giants (id: motu-giants, 2014, Mattel, 12")
//     – Mighty Masters year corrected: — → 2026
//     – "Mattel Classics" renamed to "Classics" (id unchanged)
//     – "Mattel 200x" renamed to "200x" (id unchanged)
//     – SERIES_MAP updated with new aliases; legacy names kept for import compat
//     – motu-giants added to pricing worker term maps
//
//   • CACHE bumped to v6.102. Multi-select batch editing reworked: the action
//     bar's button is now "Batch Edit…" and its sheet has a mode toggle —
//     "Update existing" (default) writes the filled-in fields (status,
//     condition, price, date acquired, location, notes) onto each selected
//     figure's existing copy with NO duplicate copies, vs "Add new copy" which
//     keeps the old append behavior. So condition/price/date/etc. can be set on
//     the current selection directly, not only by adding a copy.
//
// v6.101 changelog:
//   • CACHE bumped to v6.101. Three detail/multi-select improvements:
//     – Multi-select batch editor (Add Copy…) now also sets Date Acquired and
//       Location, not just status/condition/price/notes.
//     – Detail Price Paid prepopulates with the figure's Original Retail and
//       selects-all on focus, so it's a one-tap default that's easy to override.
//     – Acquired (MM/YYYY) editing fixed: backspacing a month digit no longer
//       cascades the year or jumps the caret to the end (formatAcquired now
//       respects the slash boundary and preserves caret position).
//
// v6.100 changelog:
//   • CACHE bumped to v6.100. render.js: the deferred remainder of a large
//     figure grid (everything past the first 80) now renders in frame-sized
//     chunks instead of one big innerHTML, so opening a big line no longer
//     hitches on a single long frame. No data/shell-list change otherwise.
//
// v6.99 changelog:
//   • CACHE bumped to v6.99. Catalog data-model update in state.js (and mirrored
//     in figures-editor.html): the "Original" line is renamed "Vintage" (display
//     name only — id stays 'original', so all figures keep working); two new
//     sublines, Meteorbs and Commemorative Series, are added under it; and a new
//     "Mighty Masters" line is added (appended for users with a saved line
//     order). render.js version stamp bumped to v6.99.
//
// v6.98 changelog:
//   • CACHE bumped to v6.98. Image cache revalidation (fixes the "corrected art
//     never propagates" gap): figure images are still served cache-first and
//     instantly, but a cached entry older than 7 days now triggers a BACKGROUND
//     refresh, so a re-uploaded image (same slug, new bytes) eventually reaches
//     users who already cached the old one. Last-fetch times are tracked in a
//     small SW-owned IndexedDB store (image responses are opaque); revalidation
//     re-fetches with CORS and only replaces the cache on a real 200, so a
//     transient error can't clobber a good image. Fails safe + bandwidth-bounded
//     (each image refreshes at most weekly, only when actually viewed). No SHELL
//     change; render.js version stamp bumped to v6.98.
//
// v6.97 changelog:
//   • CACHE bumped to v6.97. SHELL: state.js + vault.css + eggs.js + render.js
//     updated. Theme reshuffle + a scroll fix:
//       – The dark default theme (key `eternia`) is renamed "Snake Mountain"
//         with a new purple/blue palette (snake.html); its Orko title-tap egg
//         is now the Snake Mountain egg. The light theme (key `light`) is
//         renamed "Eternia" with a Filmation-Sorceress sky-blue/orange palette
//         (sorcespreview.html). Theme KEYS are unchanged, so saved preferences
//         keep working with no migration.
//       – Lines tab now preserves scroll position when popping back out of a
//         subline (per-scope scroll memory in render.js); previously only the
//         flat tabs held position because the drill-down changed the scope key.
//
// v6.96 changelog:
//   • CACHE bumped to v6.96. SHELL: app.js + data.js + render.js updated.
//     Storage headroom (phase 2): the COLLECTION (motu-c2) now persists to
//     IndexedDB instead of localStorage — the blob that actually grows over
//     time. The in-memory S.coll stays the live source of truth and mirrors to
//     IndexedDB on every (debounced) change; on tab-hide a synchronous
//     localStorage "journal" snapshot is written as a crash-safety net (an
//     async IDB write started in pagehide may not commit before the page is
//     killed) and reconciled on the next boot, so the last change can't be
//     lost. The journal is cleared on resume and only used when IndexedDB is
//     the active backend; localStorage-fallback behavior is unchanged. A
//     one-time migration moves any existing motu-c2 out of localStorage on
//     first boot. The _collLoaded wipe-guard is preserved.
//
// v6.95 changelog:
//   • CACHE bumped to v6.95. SHELL gains js/idb-store.js, and app.js + data.js
//     + ui-sheets.js updated. Storage headroom (phase 1): the catalog cache
//     (motu-figs-cache, ~1,200 figures) and its loadouts companion
//     (motu-loadouts-cache) now persist in IndexedDB instead of localStorage,
//     relieving the ~5 MB localStorage ceiling. A one-time migration moves any
//     existing copy out of localStorage on first boot; if IndexedDB is
//     unavailable the app falls back to localStorage transparently. (The
//     collection itself, motu-c2, is a separate phase — see idb-store.js.)
//
// v6.94 changelog:
//   • CACHE bumped to v6.94. SHELL: vault.css + state.js + ui-sheets.js +
//     eggs.js + app.js + render.js. Adds the first LIGHT theme ("Daylight"):
//       – New [data-theme="light"] palette in vault.css (token-driven; status
//         + accent colors deepened one step to clear WCAG AA on light surfaces).
//       – THEMES gains the light entry plus per-theme fg/fg2 text colors so the
//         theme picker renders every option legibly regardless of active theme.
//       – setTheme + boot now sync <meta name="theme-color"> to the active
//         theme so the mobile browser chrome matches (esp. in light mode).
//
// v6.93 changelog:
//   • CACHE bumped to v6.93. SHELL: render.js + vault.css + pricing.js.
//       – Accessory chips: render classes reverted to .acc-chip/.acc-chips/
//         .acc-add with the exact v6.80 sizing, fully decoupled from the
//         generic .chip rule that was inflating them (min-height:44).
//       – eBay Asking now renders next to Original Retail INSIDE the For Sale
//         copy databox (removed the orphaned header slot that wasn't showing).
//       – Status pills no longer "bounce": patchDetailStatus preserves and
//         restores the detail-scroll position across the state swap.
//       – Removed the redundant "↳ Variant of …" text line above the variant
//         strip (the strip already shows the family).
//
// v6.92 changelog:
//   • CACHE bumped to v6.92. SHELL: render.js + vault.css + pricing.js.
//       – The eBay-derived market price line is renamed "eBay Asking" (to
//         distinguish it from the user's editable per-copy Asking Price) and
//         now renders ONLY on the For Sale screen, not above the status pills
//         on every status.
//       – Reverted the prior echo of the editable Asking onto the Original
//         Retail line; that field stays in the copy grid only.
//
// v6.91 changelog:
//   • CACHE bumped to v6.91. SHELL: render.js + vault.css. "Showcase"
//     detail-screen redesign, plus refinements:
//       – Accessory chips: scoped to `.chips .chip` so the filter-sheet
//         `.chip` rule (min-height 44) stops inflating them; back to compact.
//       – Wishlist "Price Watch" title rendered in the wishlist blue.
//       – Price Watch removed from the Ordered state (wishlist-only now).
//       – For Sale copy grid drops Acquired and pairs Asking with Location;
//         Asking Price is echoed next to Original Retail at the top.
//       – Add Copy button styled purple in the action bar.
//       – Extra spacing between "More details…" and the Mark Sold button.
//       – Variant figures: per-card trash removed; Delete now lives in the
//         databox header (and is dropped from the bottom action bar for them).
//       – Add Copy moved into the bottom action bar beside Add Variant; bar
//         goes 4-up and stacks icon-over-label when it carries four actions.
//       – Location inline with Acquired (owned); hero centered; hero carousel
//         allows pan-y so vertical drags scroll; "More details…" trimmed.
//
// v6.90 changelog:
//   • CACHE bumped to v6.90. SHELL: vault.css only. Detail-screen polish:
//       – Fix: "Add a copy" button was left-aligned/content-width; now fills
//         the 16px gutters to sit centered under the data box.
//       – Add :hover state for the add-copy button (desktop/secure-context
//         testing parity).
//       – Per-copy delete (trash) button now carries a faint resting red
//         tint so it reads as interactive before being pressed.
//       – Add-copy "+" glyph optically recentered against the label.
//
// v6.64 changelog:
//   • CACHE bumped to v6.89. SHELL: render.js + vault.css. Detail-screen
//     remodel (collection-management-first layout):
//       – New order: name + metadata subtitle → photo → variant strip →
//         STATUS (compact 2x2) → status-tinted DATA BOX (Collection Details /
//         Price Watch / Order Details, colored green/blue/orange/red) →
//         Add-a-copy button → AF411/Edit/Delete at the bottom.
//       – Detail title drops Cinzel for the UI sans (only this screen); the
//         floating metadata pill band is replaced by a one-line subtitle
//         under the name (line · wave · year · faction, middot-joined).
//       – Original Retail moved into the owned data box as a single anchor
//         line (figure-level, shown once) above per-copy Price Paid.
//       – "Add Variant" removed from the action bar (was redundant with the
//         variant strip's "+"); the strip now always renders so solo figures
//         still have an Add-variant entry point.
//     v6.89.1 corrections (same release, pre-deploy):
//       – Variant strip hides again for solo figures (the always-on version
//         looked wrong); Add Variant returns to the bottom action bar (gold).
//       – Bottom action buttons: icon + label on one inline row (were stacked
//         column, too tall + mismatched). Compact uniform height.
//   • CACHE bumped to v6.88. SHELL: render.js + data.js + pricing.js. The
//     pricing-backend URL (motu-pricing-backend) was never in the settings
//     backup, so a browser-storage clear wiped it permanently and silently
//     removed the market-value section from Collection Stats (the feature
//     code was always intact — it just gates on isPricingConfigured()). Added
//     the key to SETTINGS_KEYS so it rides settings export/import, plus a
//     reloadBackend() helper to refresh the in-memory cache after restore.
//   • CACHE bumped to v6.87. SHELL: render.js + vault.css. Fixes the v6.86
//     scan button: it was a normal-flow element inside the relatively-
//     positioned .search-wrap, so it dropped onto its own line below the
//     field. Now absolutely positioned at the right edge (right:10px); the
//     clear-X shifts to right:42px and the input gains right padding so both
//     sit inline. (Workflow sync-af411.yml also gained rebase-and-retry on
//     push to fix non-fast-forward rejections — not part of the app shell.)
//   • CACHE bumped to v6.86. SHELL: render.js + photos.js + vault.css.
//     Barcode CAMERA scanning (Android). A scan button in the search bar
//     opens a live camera overlay using the native BarcodeDetector API (no
//     library, no new dependency). On decode it strips to digits and feeds
//     the existing search via onSearch — which already matches figure.upc,
//     so a scan jumps straight to the figure. Defensive: clear messages when
//     BarcodeDetector is unsupported (iOS/old browsers), camera is missing,
//     or permission is denied; self-contained overlay with full teardown
//     (stops camera tracks + cancels RAF) on hit, close, or hardware-back.
//     Targets UPC-A/E + EAN-13/8 (retail toy packaging).
//   • CACHE bumped to v6.85. SHELL: render.js + vault.css. Photo fixes:
//       – STAR/DEFAULT BUG (root cause): the fullscreen viewer computed
//         "is this the default?" by strict equality on the explicit
//         S.defaultPhoto entry only, so the IMPLICIT default (first user
//         photo, no explicit entry) was wrongly shown as "Set as default."
//         Tapping it wrote a redundant entry that fought the implicit
//         fallback and broke list-thumbnail behavior. Viewer now resolves
//         the same EFFECTIVE default the carousel does (?? first user photo).
//       – Carousel swipe: touch-action:pan-x pinch-zoom so a rightward swipe
//         starting near the left screen edge no longer triggers the OS back
//         gesture and loads the previous figure. Pairs with the v6.84
//         overscroll-behavior fix (which only handled the left direction).
//   • CACHE bumped to v6.84. SHELL: render.js + vault.css. SW image-cache
//     architecture fix + photo/editor polish:
//       – IMAGE CACHE FIX (important): figure images + sounds now live in a
//         separate, UNVERSIONED cache (motu-vault-images). They previously
//         shared the versioned shell cache, so the activate cleanup wiped
//         every downloaded image on EVERY version bump — they then silently
//         re-fetched from GitHub as figures were re-viewed. Images are
//         immutable (slug-addressed), so they now persist across updates.
//         activate handler keeps both CACHE and IMG_CACHE.
//       – Photo carousel: overscroll-behavior-x:contain so swiping past the
//         first/last photo no longer chains to the browser back/forward
//         gesture (which was jumping to the prev/next figure).
//       – figures-editor: red "missing fields" badges on cards with catalog
//         gaps, so the Incomplete-data filter shows AT A GLANCE what's absent.
//   • CACHE bumped to v6.83. SHELL: render.js + data.js. Collection
//     data-completeness + UPC feature set (figures-editor.html also updated
//     but is not part of the runtime shell):
//       – Photo regression fix: "Add photo" split into Camera (capture) +
//         Gallery (no capture) buttons so BOTH are available again.
//       – Fill Missing Data round-trip: exportGaps() emits owned copies
//         missing condition/acquired/paid/location with a stable ID column;
//         doImportVault now matches by ID first, reads Acquired (MM/YYYY),
//         and lets blank-status gap rows patch existing owned figures.
//       – Data Completeness panel in Collection Stats with per-field missing
//         counts + one-tap "Export gaps to CSV".
//       – figures-editor: "Incomplete data only" filter (catalog gaps) in
//         both modes; UPC/barcode field captured on manual-add and edits,
//         persisted to figures.json.
//       – App search: all-digit queries (>=3) match against figure.upc, so a
//         typed/scanned barcode jumps straight to the figure.
//   • CACHE bumped to v6.82. SHELL: render.js + eggs.js + data.js +
//     ui-sheets.js. Six-item fix batch (no new module):
//       #1 variant figs in Recently Changed / New-to-Catalog no longer
//          render with the orphaned variant-nested indent (standalone flag
//          on renderFigRow/Card/Item);
//       #3 duplicate "2026" year header — grouping now normalizes year type
//          (string vs int), and applyOverrides coerces year/retail to Number;
//       #4 Add-photo input drops capture="environment" so the OS offers
//          gallery + files, not camera-only;
//       #5 "Recently Added" sort (added-desc) backed by a durable
//          motu-fig-added timestamp map (stamped on AF411 sync, survives
//          backup v5 via new figAdded field) so freshly captured figures
//          pin to the top regardless of release year;
//       #6 missing-wave chip in Collection Stats now dismisses the sheet
//          (openFig clears S.sheet) so the figure opens in front, not behind.
//   • CACHE bumped to v6.81. SHELL gains js/share.js. Want-List share
//     layer (buildShareURL/decodeShareURL, QR encoder, renderShareSheet,
//     copy/native/trade-list share actions, PWA shortcut dispatch, and
//     checkShareLink + renderWantListViewSheet, ~430 lines) extracted from
//     render.js into its own module. render.js 2288→1859 lines. One-way
//     import (share→render for toast); render()/openSheet() via window.*.
//   • CACHE bumped to v6.80. SHELL gains js/stats.js. Collection Stats
//     sheet (renderStatsSheet + fetchAllOwnedPricing + toggleWaveExpand,
//     ~330 lines) extracted from render.js into its own module. render.js
//     2616→2289 lines. No behavior change except the activity chart now
//     reads the event log directly (was a defensive always-empty guard).
//   • CACHE bumped to v6.79. SHELL: render.js + eggs.js + vault.css.
//     Dead-code cleanup (no behavior change): removed orphaned
//     .market-value-block CSS (~69 lines), retired .fig-var-badge rules,
//     deleted unused window.searchCharacter, trimmed render.js export
//     list to externally-consumed names only.
//   • CACHE bumped to v6.78. SHELL: render.js + vault.css. Waves in
//     Progress rows now expand (toggleWaveExpand) to list the specific
//     missing figures as deep-link chips + 'View whole wave' button.
//   • CACHE bumped to v6.77. SHELL: render.js + vault.css. Variant chips:
//     removed redundant 'Standard' pill (parent keeps its normal circular
//     status dot), chips now list only variants and are smaller (10px).
//   • CACHE bumped to v6.76. SHELL: render.js + vault.css. REGRESSION FIX:
//     v6.74 CSS cleanup regex deleted the detail-screen variant-tour,
//     action-bar, and mark-sold styles by accident — all restored. Chips
//     refined (smaller, top margin) + right-side dot hidden on parents
//     with variants (chips own the state).
//   • CACHE bumped to v6.75. SHELL: app.js + data.js + render.js +
//     state.js + ui-sheets.js + vault.css + manifest.json + motu-vault.html.
//     CRITICAL: custom variants lost on cold start — boot now re-merges
//     CUSTOM_FIGS_KEY over cached rows (+ cache refresh on add/delete).
//     App renamed MOTU Vault → MOTU Collector (manifest + about + shares).
//     Snake Mountain theme removed (saved theme sanitized). Variant rows
//     replaced by inline owned-aware chips on the parent row.
//   • CACHE bumped to v6.74. SHELL: handlers.js + render.js + vault.css.
//     Long-press fix round 2: fire-time validation (touched node must
//     still be in the DOM — kills the rapid-cycle race that survived
//     v6.73's cancel hooks). Text-selection suppressed on rows/cards;
//     stray selection cleared when the menu opens.
//   • CACHE bumped to v6.73. SHELL: handlers.js + render.js + vault.css.
//     BUG FIX: long-press menu firing after first status-cycle from
//     cleared (mid-touch DOM rebuild orphaned the timer cancel — global
//     cancelLongPress + document-level nets). Undo button slimmed.
//   • CACHE bumped to v6.72. SHELL: app.js + data.js + render.js +
//     state.js + vault.css. Text-only view REVERTED (persisted 'text'
//     viewMode sanitized back to list). CRITICAL FIX: collection writes
//     (saveColl/flushSaveColl) gated behind S._collLoaded so a failed
//     boot can never overwrite motu-c2 with the empty initial state on
//     pagehide/visibilitychange — the suspected wipe mechanism.
//   • CACHE bumped to v6.71. SHELL: render.js + handlers.js + vault.css.
//     Text-only view mode (3rd toggle), BUG FIX: stale immersive-hide
//     header after root-level back press (popstate now reconciles DOM
//     classes directly, not just S.barsHidden flags).
//   • CACHE bumped to v6.70. SHELL: data.js + render.js + vault.css updated.
//     UI polish round: detail action bar rebuilt as uniform grid (All
//     versions removed), per-copy Variant field legacy-only, Mark Sold
//     gated to for-sale, appPromptText top-anchored (keyboard fix),
//     nested variant rows restyled (curved connector, chips/VAR removed),
//     Has-variants filter repurposed to structured model.
//   • CACHE bumped to v6.69. SHELL: app.js + data.js + render.js +
//     pricing.js + vault.css updated. Price-watch (targetPrice + DEAL
//     badges + daily deal toast), price-history sparklines on detail,
//     trade-list text share, printable insurance report (HTML export).
//   • CACHE bumped to v6.68. SHELL: data.js + render.js + ui-sheets.js +
//     eggs.js updated. Backup schema v5 (soldLog + customFigs in export/
//     import), Waves-in-Progress checklist in Stats (goToWave + filterWave),
//     Locations browser sheet (Settings → Locations).
//   • CACHE bumped to v6.67. SHELL: app.js + data.js + render.js + handlers.js
//     + ui-sheets.js + pricing.js + vault.css updated. Backup nag (changes
//     counter + menu badge + boot toast), collection-value dashboard with
//     bulk price fetch, for-sale lifecycle (per-copy asking, Mark Sold,
//     sold log, realized gains in stats).
//   • CACHE bumped to v6.66. SHELL: handlers.js + render.js + vault.css updated.
//     In-app variant creation (Add Variant button / long-press / + chip),
//     appPromptText modal, deleteCustomFig for user-added figures.
//   • CACHE bumped to v6.65. SHELL: data.js + render.js + vault.css updated.
//     Variant nesting (variantOf/variantName) + detail-screen variant tour.
//   • CACHE bumped to v6.64. SHELL: pricing.js + render.js + vault.css updated.
//   • Market Value: replaced the big condition-split block with a single
//     inline "Asking" number rendered next to "Original Retail". Modern
//     lines use the sealed-bucket median; vintage (Original, New Adventures)
//     use loose. Low-sample data renders dimmed. No condition rows, no
//     source labels, no refresh button, no stale indicator — the worker's
//     keyword/junk/line filtering still runs underneath; we just stopped
//     showing the kitchen sink in the UI.
//   • Retail label renamed to "Original Retail".
//
// v6.63 changelog:
//   • CACHE bumped to v6.63. SHELL: handlers.js + render.js updated.
//   • Acquired date field (figure detail) auto-formats MM/YYYY as the user
//     types. The mobile numeric keyboard has no slash key, so typing
//     "042026" now becomes "04/2026" live. Backspace, paste, and existing
//     dates all behave naturally.
//
// v6.62 changelog:
//   • CACHE bumped to v6.62. SHELL: state.js + ui-sheets.js updated.
//   • Manage Collection: newly-added lines (e.g. cross-brand from v6.61)
//     are now mergeable into the stored line-order array on load, so the
//     up/down arrows can actually move them. Also strips stale ids from
//     the stored order (renamed/removed lines).
//   • Edit Figure Info: Group pills now use the EFFECTIVE line (override-
//     aware) instead of the source line, and fall back to canonical
//     SUBLINES groups when no figures yet exist in the target line.
//     Previously, moving a figure into a new/empty line showed zero pills.
//
// v6.61 changelog:
//   • CACHE bumped to v6.61. SHELL: state.js updated.
//   • New main line "Cross-Brand & Collabs" with four sublines: Designer &
//     Artist Collaborations, Fashion & Collector Dolls, Hot Wheels & Die-
//     Cast, Mini Figures/Building Sets/Games. Inserted in LINES between
//     Chronicles and Classics so the modern-Mattel cluster stays together.
//   • Worker: cross-brand and chronicles added to isModernLine list so
//     untagged listings classify as sealed (correct for modern packaging).
//     No required/negative line filters defined for cross-brand — the
//     category is too heterogeneous for keyword filtering; rely on per-
//     figure naming and manual community entries instead.
//
// v6.60 changelog:
//   • CACHE bumped to v6.60. SHELL: vault.css updated.
//   • Search bar: suppressed native browser clear-X (the input type="search"
//     added in v6.57 caused two X's). Custom .search-clear remains.
//   • Worker: substantial accuracy work consolidated through fix1..fix6 —
//     filter order swapped (required-line check runs before negative so
//     reissues mentioning vintage years are still accepted); expanded
//     SEALED_RE with MOSC / "in package" / "complete in card" / "still
//     sealed"; new LOOSE_RE with explicit loose markers; SEALED_HINT_RE
//     (bare "new" / "unpunched") only counts for modern lines; untagged
//     listings now rejected as ambig instead of force-bucketed; multi-
//     figure bundle detector via MOTU character names with separator-
//     context regex; "retro play" added to Origins required terms; ?debug=1
//     returns sample kept/rejected titles for tuning; ?fresh=1 bypasses
//     worker KV cache.
//
// v6.59 changelog:
//   • CACHE bumped to v6.59.
//   • No SHELL changes. Bumping CACHE forces eviction of v6.58 entries
//     so users pick up: strict per-line required-keyword filter on eBay
//     results (toss ambiguous unlabeled listings entirely) and a
//     force-fresh query param so the Refresh button bypasses the worker
//     KV cache instead of just the client cache.
//
// v6.58 changelog:
//   • CACHE bumped to v6.58.
//   • No SHELL changes. Bumping CACHE forces eviction of v6.57 entries
//     so users pick up: median-based headline pricing (was avg, easily
//     skewed), trimmed-mean stats, junk-listing filter (lots, customs,
//     repros, parts-only), per-line negative-keyword filter to reject
//     cross-line contamination (Origins query no longer pulls vintage),
//     and $5 price floor on eBay results.
//
// v6.57 changelog:
//   • CACHE bumped to v6.57.
//   • No SHELL changes. Bumping CACHE forces eviction of v6.56 entries
//     so users pick up: live MV-block re-render after pricing fetch,
//     refresh button on the loading placeholder, search Enter-dismisses
//     keyboard, scope-aware scroll preservation (no more line-list scroll
//     bleed from subline screens), and the $0/$0 range render fix.
//
// v6.56 changelog:
//   • CACHE bumped to v6.56.
//   • No SHELL changes. Bumping CACHE forces eviction of v6.38 entries
//     so users pick up updated pricing.js / render.js / vault.css with
//     honest source labels (ebay-active vs ebay-sold), confidence badges
//     for low-sample buckets, and matching backend chain support.
//
// v6.38 changelog:
//   • CACHE bumped to v6.38.
//   • No SHELL changes. Earlier intermediate bumps consolidated here.
//
// v6.33 changelog:
//
// v6.32 changelog:
//   • CACHE bumped to v6.32.
//   • SHELL gains main-theme.mp3 — background music for the About sheet,
//     pre-cached so it works offline. Also keeps the file out of the
//     stale-while-revalidate path the catalog uses.
//
// v6.31 changelog:
//   • CACHE bumped to v6.31.
//   • No SHELL changes. Bumping CACHE forces eviction of v6.30 entries
//     so users pick up data.js / render.js / ui-sheets.js / handlers.js /
//     delegate-handlers.js updates (stat history, wishlist history, About).
//
// v6.30 changelog:
//   • CACHE bumped to v6.30.
//   • No SHELL changes — modules unchanged. Bumping CACHE forces eviction
//     of the v6.29 entries so users pick up render.js / data.js / state.js
//     hardening fixes.
//
// v6.29 changelog:
//   • CACHE bumped to v6.29.
//   • SHELL gains js/delegate.js + js/delegate-handlers.js — new event
//     delegation infrastructure that replaces inline onclick="…" handlers
//     with data-action attributes resolved through a single document-level
//     dispatcher. First step toward strict CSP (drop 'unsafe-inline').
//
// v6.28 changelog:
//   • CACHE bumped to v6.28.
//   • SHELL gains js/pricing.js — new client-side pricing layer that
//     talks to a configurable backend for eBay sold-listing averages.
//   • New pass-through rule for the pricing backend itself: any URL
//     ending in /pricing/<id> or /health bypasses the SW entirely.
//     pricing.js has its own 24h cache with stale-while-revalidate;
//     a second SW layer would hide stale data and break the manual
//     refresh button.
//
// v6.19 baseline below.
//
// v6.00 changelog:
//   • CACHE bumped to v6.00.
//   • Major architecture change: monolithic motu-vault.html (8204
//     lines) split into a slim shell + vault.css + js/ ES modules
//     (app, state, photos, data, render, handlers, ui-sheets, eggs).
//   • SHELL precache list expanded to include vault.css and all 8
//     module files. Single-file install gives way to multi-file
//     install; install handler still tolerates 404s gracefully.
//   • No behavior changes intended. All inline `onclick=` window-
//     callable functions remain mirrored. Schema, storage keys,
//     theme palettes, and rendering model all unchanged from v5.06.
//   • 4 functions that previously relied on classic-script auto-
//     globalization (setStatus, fetchFigs, exportCSV,
//     dismissContextMenu) now have explicit window.* mirrors so they
//     remain reachable from inline-onclick handlers in module mode.
//

// v5.06 changelog:
//   • CACHE bumped to v5.06.
//   • Default theme palette swap: Obsidian base (#09090b/#121217/#1c1c24)
//     with violet accent (#7c3aed) and Power-Sword gold (#facc15). Named
//     themes (skeletor/heman/grayskull/snake) keep their identities.
//   • Radius bumped 14→16px (sm 10→12) for a more premium feel.
//   • Cards: plastic-edge inset highlight + deeper layered shadows. Status
//     variants get tinted inset rings (the rim "catches light").
//   • Status buttons now have per-status icons (check / heart / box / tag)
//     in addition to color, for visual redundancy.
//   • Status-pop spring animation when a status becomes active.
//   • Tap targets: .icon-btn 38→44px, .chip min-height 44px.
//   • t3 lifted #71717a → #8a8d9a for WCAG AA contrast on bg2/bg3.
//   • Inputs gain a 3px focus ring (was 1px border shift, easy to miss).
//   • Buttons get :focus-visible outline for keyboard nav.
//   • Section header weight bumped 700→800, color t3→t2 for legibility.
//
// v5.05 changelog:
//   • CACHE bumped to v5.05.
//   • Back-at-root: no longer closes app on first press. Shows
//     "Press back again to exit" toast; second back within 2.5s exits.
//   • Custom figures: year coerced to Number on load so they merge into
//     the same year-grouped section as AF411 entries (was creating a
//     duplicate "2026" section because string!==number under ===).
//
// v5.04 changelog:
//   • CACHE bumped to v5.04.
//   • Stagger entrance animation restored, gated to navigation only
//     (data-stagger attribute set on #app). Status toggles and in-place
//     patches no longer replay it.
//   • Lines view toggle restyled into a proper section header — line
//     count on left, segmented toggle on right, breathing room above.
//   • Custom figures: app now loads motu-custom-figs from localStorage
//     at sync time, IDs auto-prefixed with 'custom-' to avoid AF411
//     collision when official entries arrive. Use the standalone
//     custom-figs-editor.html to add/edit/delete.
//
// v5.03 changelog:
//   • CACHE bumped to v5.03.
//   • Per-figure accessory availability list. Tap "⚙ Limit list" in the
//     accessory picker to choose which accessories are even offered for
//     that figure (e.g. Battle Armor He-Man → just Sword, Battle Axe,
//     mini comic). Stored under motu-acc-avail (per-figure-id list).
//     Empty/unset = full ACCESSORIES catalog as before. Custom-added
//     accessories on a copy still show even if not in the limited list.
//
// v5.02 changelog:
//   • CACHE bumped to v5.02. v5.01 was amended in place (same CACHE
//     constant) so existing SW didn't re-activate, leaving stale assets
//     cached. Bumping forces a clean install.
//
// v5.01 changelog:
//   • CACHE bumped to v5.01.
//   • Empty Collection state: clearer prompt with CTAs to Lines / All
//     when user lands on Collection tab with nothing tracked yet.
//   • Lines screen now has list/grid view toggle (separate setting from
//     the figures-list view; key: motu-lines-view).
//   • Filter chip flicker fixed: chip taps now patch only the sheet body
//     in place via patchFilter() instead of a full app re-render.
//   • Splash screen markup commented out (per user request).
//   • Bars auto-reappear after 3.5s of scroll idle so you never get
//     stranded without nav after stopping to read.
//
// v5.00 changelog:
//   • CACHE bumped to v5.00.
//   • Bars reappear when scrolled to the bottom of the figures list (was
//     left in whatever state on entry — sometimes hidden, blocking nav).
//   • Pull-to-refresh now opt-in (default OFF). Threshold raised 80→120px.
//     Toggle in Menu → Sync section. Some touchscreens were sensitive
//     enough to fire PTR during normal upward scrolling.
//   • Removed the inline "Add Figure" button on the Kids Core line —
//     adding figures is now via the standalone kids-core-editor.html.
//     Existing entries can still be edited via the per-figure Edit flow.
//   • PWA app-icon shortcuts: long-press the installed icon for quick
//     actions (Share Want List, Stats, Sync, Settings). Requires the
//     updated manifest.json — see /mnt/user-data/outputs/manifest.json.
//
// v4.99 changelog:
//   • CACHE bumped to v4.99.
//   • Settings export/import: theme, sort, view mode, line order, hidden
//     items, recent changes, default photo, onboarding flag, celebrated
//     flags. NOT collection data or photos. Format detection on import
//     auto-routes the JSON to the right handler.
//
// v4.98 changelog:
//   • CACHE bumped to v4.98.
//   • AF411 button: removed source==='af411' gate (many figures are
//     AF411-sourced but just missing that field in figures.json).
//     Tiered fallback: deep link if id matches AF411's <slug>-<NNNNN>
//     pattern; else group's index page; else all-figures index.
//
// v4.97 changelog:
//   • CACHE bumped to v4.97.
//   • AF411 group slugs fixed against real URLs from the all-figures
//     index: 'origins|Exclusives' was 'exclusives' (now 'origins-
//     exclusives'); 'origins|Vehicles & Playsets' was 'vehicles-playsets'
//     (now 'origins-beasts-vehicles-and-playsets'); 'origins|WWE' was
//     'wwe' (now 'masters-of-the-wwe-universe-action-figures'); added
//     entries for Stranger Things, Thundercats, and Transformers crossovers.
//   • AF411 fallback no longer points at the broken WP search endpoint;
//     opens the all-action-figures index instead so Ctrl+F finds the
//     figure even when its source field is missing.
//
// v4.96 changelog:
//   • CACHE bumped to v4.96.
//   • AF411 URL fix: Origins Deluxe slug was 'deluxe', actual path is
//     'origins-deluxe'. Affected all Origins Deluxe figures (Beast Man
//     Deluxe, etc.).
//   • AF411 search fallback now strips "(Deluxe)"/"(Variant)" parens
//     from the figure name and appends the line name so the search
//     query is tighter and less likely to land on a homepage.
//
// v4.95 changelog:
//   • CACHE bumped to v4.95.
//   • AF411 button now shows on detail screen for any non-Kids-Core,
//     non-custom figure (was gated on source==='af411'); falls back to
//     AF411 site search when no group slug. Same in context menu.
//   • Header flash on scroll: 200ms hysteresis lockout + threshold
//     bumped 4→8px so small overshoot/correction motions during fast
//     scrolling no longer flap the bars on/off.
//   • Multi-copy CSV import: rows after the first are now appended as
//     additional copies (was: silently skipped). Round-trip tested.
//   • Grid card stack offsets bumped 5→8px and 10→16px with depth
//     shadow so the back card reads as a separate object instead of
//     a thick border.
//
// v4.94 changelog:
//   • CACHE bumped to v4.94.
//   • Audit fixes: orderedPaid===0 now migrates correctly (was falsy);
//     search input right padding 36→44px (long queries no longer overlap
//     the X clear button); .acc-chip-x tap target expanded via
//     padding+negative margin (visually identical, ~28×28 hit area);
//     deleteKidsCoreAdminFig now also clears overrides + photos.
//   • Stacked grid card visual: layered box-shadows give a clear depth
//     cue (was missing entirely; list-view stack offsets bumped 3→5px
//     and 6→10px with subtle shadows so the slivers read as cards
//     rather than a thick border).
//
// v4.93 changelog:
//   • CACHE bumped to v4.93 — activate() wipes old entries.
//   • Fixes:
//     - "Lines" breadcrumb now correctly returns to the lines grid. Was
//       broken since v4.91: crumbToLines reset activeLine but not S.tab,
//       which goToLine had set to 'all'. So clicking "Lines" dumped users
//       into the flat catalog list instead of the lines grid (giving the
//       "disappears, not functional" symptom).
//     - Kids Core admin: Faction is now a dropdown using the canonical
//       FACTIONS list, not free text. Prevents typos that would split
//       the Faction filter into unmergeable buckets.
//
// v4.92 changelog:
//   • Stacked-thumbnail visual on list rows for figures with multiple
//     copies. Pure CSS via ::before/::after — no extra DOM, no extra
//     image fetches. ::before peeks at copies≥2; ::after revealed at
//     copies≥3. patchFigRow preserves the .has-stack/.has-stack-3plus
//     classes when re-applying status on quick-tap.
//
// v4.91 changelog:
//   • Multiple bug fixes (cycle-dot ordered→owned migration, accessory
//     picker tap-off, location datalist refresh, breadcrumb crumb nav,
//     scroll-position carryover between tabs).
//   • Cycle-from-ordered now jumps directly to owned (matches "received
//     my order" intent and preserves the orderedFrom→notes migration).
//   • New "N NEW" badge on Lines and Sublines screens — see at a glance
//     which sections have recently-added figures.
//   • CSS-only addition for the new badge; the cache bump is otherwise
//     a soft formality.
//
// v5.06 changelog:
//   • CACHE bumped to v5.06.
//   • Default theme palette swap: Obsidian base (#09090b/#121217/#1c1c24)
//     with violet accent (#7c3aed) and Power-Sword gold (#facc15). Named
//     themes (skeletor/heman/grayskull/snake) keep their identities.
//   • Radius bumped 14→16px (sm 10→12) for a more premium feel.
//   • Cards: plastic-edge inset highlight + deeper layered shadows. Status
//     variants get tinted inset rings (the rim "catches light").
//   • Status buttons now have per-status icons (check / heart / box / tag)
//     in addition to color, for visual redundancy.
//   • Status-pop spring animation when a status becomes active.
//   • Tap targets: .icon-btn 38→44px, .chip min-height 44px.
//   • t3 lifted #71717a → #8a8d9a for WCAG AA contrast on bg2/bg3.
//   • Inputs gain a 3px focus ring (was 1px border shift, easy to miss).
//   • Buttons get :focus-visible outline for keyboard nav.
//   • Section header weight bumped 700→800, color t3→t2 for legibility.
//
// v5.05 changelog:
//   • CACHE bumped to v5.05.
//   • Back-at-root: no longer closes app on first press. Shows
//     "Press back again to exit" toast; second back within 2.5s exits.
//   • Custom figures: year coerced to Number on load so they merge into
//     the same year-grouped section as AF411 entries (was creating a
//     duplicate "2026" section because string!==number under ===).
//
// v5.04 changelog:
//   • CACHE bumped to v5.04.
//   • Stagger entrance animation restored, gated to navigation only
//     (data-stagger attribute set on #app). Status toggles and in-place
//     patches no longer replay it.
//   • Lines view toggle restyled into a proper section header — line
//     count on left, segmented toggle on right, breathing room above.
//   • Custom figures: app now loads motu-custom-figs from localStorage
//     at sync time, IDs auto-prefixed with 'custom-' to avoid AF411
//     collision when official entries arrive. Use the standalone
//     custom-figs-editor.html to add/edit/delete.
//
// v5.03 changelog:
//   • CACHE bumped to v5.03.
//   • Per-figure accessory availability list. Tap "⚙ Limit list" in the
//     accessory picker to choose which accessories are even offered for
//     that figure (e.g. Battle Armor He-Man → just Sword, Battle Axe,
//     mini comic). Stored under motu-acc-avail (per-figure-id list).
//     Empty/unset = full ACCESSORIES catalog as before. Custom-added
//     accessories on a copy still show even if not in the limited list.
//
// v5.02 changelog:
//   • CACHE bumped to v5.02. v5.01 was amended in place (same CACHE
//     constant) so existing SW didn't re-activate, leaving stale assets
//     cached. Bumping forces a clean install.
//
// v5.01 changelog:
//   • CACHE bumped to v5.01.
//   • Empty Collection state: clearer prompt with CTAs to Lines / All
//     when user lands on Collection tab with nothing tracked yet.
//   • Lines screen now has list/grid view toggle (separate setting from
//     the figures-list view; key: motu-lines-view).
//   • Filter chip flicker fixed: chip taps now patch only the sheet body
//     in place via patchFilter() instead of a full app re-render.
//   • Splash screen markup commented out (per user request).
//   • Bars auto-reappear after 3.5s of scroll idle so you never get
//     stranded without nav after stopping to read.
//
// v5.00 changelog:
//   • CACHE bumped to v5.00.
//   • Bars reappear when scrolled to the bottom of the figures list (was
//     left in whatever state on entry — sometimes hidden, blocking nav).
//   • Pull-to-refresh now opt-in (default OFF). Threshold raised 80→120px.
//     Toggle in Menu → Sync section. Some touchscreens were sensitive
//     enough to fire PTR during normal upward scrolling.
//   • Removed the inline "Add Figure" button on the Kids Core line —
//     adding figures is now via the standalone kids-core-editor.html.
//     Existing entries can still be edited via the per-figure Edit flow.
//   • PWA app-icon shortcuts: long-press the installed icon for quick
//     actions (Share Want List, Stats, Sync, Settings). Requires the
//     updated manifest.json — see /mnt/user-data/outputs/manifest.json.
//
// v4.99 changelog:
//   • CACHE bumped to v4.99.
//   • Settings export/import: theme, sort, view mode, line order, hidden
//     items, recent changes, default photo, onboarding flag, celebrated
//     flags. NOT collection data or photos. Format detection on import
//     auto-routes the JSON to the right handler.
//
// v4.98 changelog:
//   • CACHE bumped to v4.98.
//   • AF411 button: removed source==='af411' gate (many figures are
//     AF411-sourced but just missing that field in figures.json).
//     Tiered fallback: deep link if id matches AF411's <slug>-<NNNNN>
//     pattern; else group's index page; else all-figures index.
//
// v4.97 changelog:
//   • CACHE bumped to v4.97.
//   • AF411 group slugs fixed against real URLs from the all-figures
//     index: 'origins|Exclusives' was 'exclusives' (now 'origins-
//     exclusives'); 'origins|Vehicles & Playsets' was 'vehicles-playsets'
//     (now 'origins-beasts-vehicles-and-playsets'); 'origins|WWE' was
//     'wwe' (now 'masters-of-the-wwe-universe-action-figures'); added
//     entries for Stranger Things, Thundercats, and Transformers crossovers.
//   • AF411 fallback no longer points at the broken WP search endpoint;
//     opens the all-action-figures index instead so Ctrl+F finds the
//     figure even when its source field is missing.
//
// v4.96 changelog:
//   • CACHE bumped to v4.96.
//   • AF411 URL fix: Origins Deluxe slug was 'deluxe', actual path is
//     'origins-deluxe'. Affected all Origins Deluxe figures (Beast Man
//     Deluxe, etc.).
//   • AF411 search fallback now strips "(Deluxe)"/"(Variant)" parens
//     from the figure name and appends the line name so the search
//     query is tighter and less likely to land on a homepage.
//
// v4.95 changelog:
//   • CACHE bumped to v4.95.
//   • AF411 button now shows on detail screen for any non-Kids-Core,
//     non-custom figure (was gated on source==='af411'); falls back to
//     AF411 site search when no group slug. Same in context menu.
//   • Header flash on scroll: 200ms hysteresis lockout + threshold
//     bumped 4→8px so small overshoot/correction motions during fast
//     scrolling no longer flap the bars on/off.
//   • Multi-copy CSV import: rows after the first are now appended as
//     additional copies (was: silently skipped). Round-trip tested.
//   • Grid card stack offsets bumped 5→8px and 10→16px with depth
//     shadow so the back card reads as a separate object instead of
//     a thick border.
//
// v4.94 changelog:
//   • CACHE bumped to v4.94.
//   • Audit fixes: orderedPaid===0 now migrates correctly (was falsy);
//     search input right padding 36→44px (long queries no longer overlap
//     the X clear button); .acc-chip-x tap target expanded via
//     padding+negative margin (visually identical, ~28×28 hit area);
//     deleteKidsCoreAdminFig now also clears overrides + photos.
//   • Stacked grid card visual: layered box-shadows give a clear depth
//     cue (was missing entirely; list-view stack offsets bumped 3→5px
//     and 6→10px with subtle shadows so the slivers read as cards
//     rather than a thick border).
//
// v4.93 changelog:
//   • CACHE bumped to v4.93 — activate() wipes old entries.
//   • Fixes:
//     - "Lines" breadcrumb now correctly returns to the lines grid. Was
//       broken since v4.91: crumbToLines reset activeLine but not S.tab,
//       which goToLine had set to 'all'. So clicking "Lines" dumped users
//       into the flat catalog list instead of the lines grid (giving the
//       "disappears, not functional" symptom).
//     - Kids Core admin: Faction is now a dropdown using the canonical
//       FACTIONS list, not free text. Prevents typos that would split
//       the Faction filter into unmergeable buckets.
//
// v4.92 changelog:
//   • Stacked-thumbnail visual on list rows for figures with multiple
//     copies. Pure CSS via ::before/::after — no extra DOM, no extra
//     image fetches. ::before peeks at copies≥2; ::after revealed at
//     copies≥3. patchFigRow preserves the .has-stack/.has-stack-3plus
//     classes when re-applying status on quick-tap.
//
// v4.91 changelog:
//   • CACHE bumped to v4.91 — activate() wipes old entries. Required because
//     HTML adds .new-count-badge / .has-new CSS rules and crumb-link nav.
//   • Bug fixes:
//     - cycle-status dot from 'ordered' now jumps directly to 'owned' so the
//       ordered→owned migration of orderedFrom/orderedPaid actually fires
//       (previous cycle path went ordered→for-sale, never owned)
//     - accessory picker: tap to remove now refreshes the picker sheet
//       immediately (previously only the underlying detail was refreshed)
//     - location datalist now refreshes when locations change (so a value
//       typed in copy #1 appears as a suggestion in copy #2)
//     - breadcrumb "Lines" and the line-name crumb now use explicit nav
//       handlers instead of history.back(), and the line crumb is now
//       clickable even when no subline is active
//     - tab nav (Lines/Collection/All) no longer carries scroll position
//       from the previous tab onto the new tab
//   • Feature: NEW figure count badges on Lines and Sublines screens so
//     you can see at a glance which sections have figures added since the
//     last sync.
//
// v4.90 changelog:
//   • setStatus now auto-populates copies[0] for owned/for-sale, matching
//     the behavior of batchSetStatus and batchAddCopy. Previously the
//     detail-screen renderer was defensively creating copy #1 for display
//     only — operations that touched cp.copies[0] directly (accessory
//     picker, location input) would silently no-op on newly-owned figures
//     until the user had typed into Condition/Paid/Notes/Variant.
//   • No new CSS or UI — data-layer only. Cache bump is a soft
//     formality since there's no HTML API change, but keeps clients
//     on matching versions.
//
// v4.89 changelog:
//   • CACHE bumped to v4.89 — activate() wipes old entries. Required for
//     the responsive tablet/desktop layout: new CSS media queries at 768px,
//     1024px, and 1440px that widen the figure grid to 3/4/5 columns and
//     cap content width. Pure CSS change; no JS behavior changes.
//
// v4.88 changelog:
//   • CACHE bumped to v4.88 — activate() wipes old entries so users get a
//     clean slate. Required because HTML ships the inline copy-count pill
//     and its accompanying CSS.
//
// v4.87 changelog:
//   • CACHE bumped to v4.87 — activate() wipes the old v4.74 bucket so users
//     stuck on the previous SW get a clean slate. This also forces re-fetch
//     of motu-vault.html, which is required since the HTML ships the new
//     accessories/location UI and bug fixes (ordered→owned migration on
//     the quick-tap dot, duplicate pinning in the list).
//   • No behavior changes to the fetch/install/activate logic itself.
//
// v4.70 changelog:
//   • Cache name bumped — activate() wipes old v4.69 entries so users stuck
//     on the broken build get a clean slate.
//   • Install uses fetch({cache:'reload'}) so the shell isn't seeded from
//     the browser's HTTP cache.
//   • figures.json is now cached under its pathname (query stripped) so the
//     offline fallback actually matches and the cache stops growing one
//     entry per `?t=<timestamp>` fetch.
//   • Stale-while-revalidate HTML path now clones the response TWICE up
//     front. Previously the code called `clone.clone()` after
//     `cache.put(clone)` had already consumed the body — which threw
//     "Response body is already used" and silently killed the
//     UPDATE_AVAILABLE postMessage. Fixing it is what lets deployed
//     updates actually propagate to users.

const CACHE = 'motu-vault-v7.25';
// v6.84: figure images + sounds live in their OWN cache, deliberately NOT
// version-stamped. Previously they shared the versioned shell CACHE, so the
// activate-handler cleanup (which deletes every cache != CACHE) wiped every
// downloaded image on EVERY version bump — they then silently re-downloaded
// from GitHub one-by-one as figures were re-viewed. Images are immutable
// (content-addressed by slug on raw.githubusercontent.com), so they never
// need eviction on app updates. Keeping them here makes them survive bumps.
const IMG_CACHE = 'motu-vault-images';

// ─── Image freshness (v6.98) ──────────────────────────────────────────
// Images are cached cache-first in the unversioned IMG_CACHE so they survive
// app updates (above). But slugs are name-based, not content-hashed, so a
// CORRECTED re-upload (same slug, new bytes) would never reach a user who
// already cached the old image. Fix: time-bucketed revalidation. When a cached
// image is served, we kick off a BACKGROUND refresh if its entry is older than
// IMG_MAX_AGE. The cached image is always served instantly — revalidation never
// blocks the response and fails safe (a failed/again-stale refresh just keeps
// the existing entry). Image responses are opaque (the <img> request is
// no-cors), so we can't read their headers; instead we track each image's last
// fetch time in a tiny SW-owned IndexedDB store. We deliberately use a SEPARATE
// database from the window's idb-store ('motu-vault') so the two never collide
// on version upgrades.
const IMG_TS_DB = 'motu-vault-img';
const IMG_TS_STORE = 'ts';
const IMG_MAX_AGE = 7 * 24 * 60 * 60 * 1000;   // 7 days

let _imgTsDbPromise = null;
function _imgTsDb() {
  if (_imgTsDbPromise) return _imgTsDbPromise;
  _imgTsDbPromise = new Promise(resolve => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    let req;
    try { req = indexedDB.open(IMG_TS_DB, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IMG_TS_STORE)) db.createObjectStore(IMG_TS_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return _imgTsDbPromise;
}
// Resolves to the last-fetch timestamp (ms), 0 if untracked, or -1 if IndexedDB
// is unavailable (so the caller can skip revalidation rather than hammer it).
function _imgTsGet(url) {
  return _imgTsDb().then(db => {
    if (!db) return -1;
    return new Promise(res => {
      let tx; try { tx = db.transaction(IMG_TS_STORE, 'readonly'); } catch { res(0); return; }
      const r = tx.objectStore(IMG_TS_STORE).get(url);
      r.onsuccess = () => res(r.result || 0);
      r.onerror = () => res(0);
    });
  });
}
function _imgTsSet(url) {
  return _imgTsDb().then(db => {
    if (!db) return;
    try { db.transaction(IMG_TS_STORE, 'readwrite').objectStore(IMG_TS_STORE).put(Date.now(), url); } catch {}
  });
}
// Re-fetch with CORS so we can read the real status (the cached <img> request
// is no-cors/opaque, status hidden). raw.githubusercontent.com sends ACAO — the
// app fetches figures.json from it the same way — so this succeeds; if it ever
// didn't, the fetch rejects and we keep the existing cached image. Only a real
// 200 replaces the cache entry, so a transient 404/error can't clobber a good
// image. cache:'no-cache' forces a fresh conditional fetch past the HTTP cache.
function _revalidateImage(request) {
  return fetch(request.url, { mode: 'cors', cache: 'no-cache' }).then(res => {
    if (!res || res.status !== 200) return;
    return caches.open(IMG_CACHE).then(c => c.put(request, res)).then(() => _imgTsSet(request.url));
  }).catch(() => {});
}

const SHELL = [
  'motu-vault.html',
  'manifest.json',
  'masters_logo.png',
  'main-theme.mp3',
  'vault.css',
  'js/app.js',
  'js/state.js',
  'js/idb-store.js',
  'js/photos.js',
  'js/data.js',
  'js/render.js',
  'js/handlers.js',
  'js/ui-sheets.js',
  'js/eggs.js',
  'js/tutorial.js',
  'js/pricing.js',
  'js/stats.js',
  'js/share.js',
  'js/delegate.js',
  'js/delegate-handlers.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c =>
      // {cache:'reload'} bypasses the HTTP cache so we always seed the
      // shell from the network on a fresh install. cache.addAll() uses the
      // default fetch, which may pull a stale HTML copy if the server
      // sends a long Cache-Control.
      Promise.all(SHELL.map(url =>
        fetch(url, {cache: 'reload'})
          .then(res => res.ok ? c.put(url, res) : null)
          .catch(() => null)
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      // v6.84: keep BOTH the current shell cache and the unversioned image
      // cache. Only stale versioned shell caches are evicted now, so figure
      // images persist across app updates instead of being wiped each bump.
      Promise.all(keys.filter(k => k !== CACHE && k !== IMG_CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // v6.28: pricing backend (configurable per-user). Pass through untouched
  // — pricing.js has its own application-level cache with stale-while-
  // revalidate, force-refresh, and TTL eviction. A second SW cache layer
  // here would hide stale data and confuse the refresh button. Identified
  // by URL path so we don't need to know which host the user configured.
  if (/\/pricing\/[^/]+$/.test(url.pathname) || url.pathname.endsWith('/health')) {
    return;
  }

  // figures.json — network first, fall back to cache.
  // The app cache-busts this URL with ?t=<timestamp>. Matching the raw
  // request means every new fetch writes a new cache entry (slow bloat)
  // and `caches.match` never finds a previous entry when offline (broken
  // fallback). Normalize to the bare URL so there's one entry, and
  // `match` actually works when the network is down.
  if (url.pathname.endsWith('figures.json')) {
    const cacheKey = url.origin + url.pathname;
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(CACHE).then(c => c.put(cacheKey, clone));
          }
          return res;
        })
        .catch(() => caches.match(cacheKey))
    );
    return;
  }

  // Figure images & sounds — cache first, network fallback. Stored in the
  // unversioned IMG_CACHE so they survive app version bumps (v6.84). v6.98: a
  // cached image is served instantly, then revalidated in the background if its
  // entry is older than IMG_MAX_AGE (so corrected re-uploads eventually reach
  // everyone) — see the image-freshness helpers above.
  if (url.hostname === 'raw.githubusercontent.com' && (url.pathname.endsWith('.jpg') || url.pathname.endsWith('.png') || url.pathname.endsWith('.mp3'))) {
    e.respondWith(
      caches.match(e.request).then(cached => {
        if (cached) {
          // Serve the cache now; check freshness + refresh off the response path.
          e.waitUntil(_imgTsGet(e.request.url).then(ts => {
            if (ts >= 0 && Date.now() - ts > IMG_MAX_AGE) return _revalidateImage(e.request);
          }));
          return cached;
        }
        return fetch(e.request).then(res => {
          // v7.09: only cache successful responses. A 404/5xx (e.g. a
          // mis-pathed sound, or a transient network blip) was previously
          // cached and then served from cache indefinitely. Every other
          // handler in this file already gates its put on res.ok.
          if (res.ok) {
            const clone = res.clone();
            e.waitUntil(caches.open(IMG_CACHE).then(c => c.put(e.request, clone)).then(() => _imgTsSet(e.request.url)));
          }
          return res;
        });
      })
    );
    return;
  }

  // HTML & app shell — network-first with cache fallback
  // Always try the network so users get the current version immediately on
  // each load. The stale-while-revalidate strategy was causing update lag:
  // users saw the old cached HTML on first load after a deploy, requiring a
  // second reload to get the new version even when the new SW had activated.
  // Network-first means a brief extra round-trip on each navigation, but for
  // a PWA installed on-device this is negligible, and the cache still
  // provides full offline support when the network is unavailable.
  if (e.request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    e.respondWith(
      fetch(e.request, { cache: 'reload' }).then(res => {
        if (res.ok) {
          const cacheClone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, cacheClone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }

  // Everything else (JS modules, CSS, fonts, etc.) — network first.
  // v6.16: switched from cache-first to network-first so app code updates
  // reach users on the next page load without requiring a CACHE bump and
  // SW reinstall. Cache is still populated and used as the offline fallback.
  // Trade-off: one network round-trip per asset when online; for a small
  // app this is invisible, and it eliminates the "bump CACHE every patch"
  // tax that was making iteration painful.
  e.respondWith(
    fetch(e.request, { cache: 'reload' })
      .then(res => {
        if (res.ok && e.request.method === 'GET' && url.origin === location.origin) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
