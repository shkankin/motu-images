#!/usr/bin/env python3
"""
MOTU Vault — FigureRealm Catalog Sync
Scrapes figurerealm.com checklist pages for MOTU-universe series that
are NOT on AF411, diffs against figures.json, downloads thumbnails, and
outputs updated figures.json / figures-pending.json.

The output schema is identical to sync_af411.py so both scrapers feed
the same pending queue and editor workflow unchanged.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  CACHE-FIRST: GitHub Actions IPs are blocked by FigureRealm (403).
  The script reads from pre-saved HTML files instead of live fetches.

  One-time setup (do from a desktop browser):
    1. Open each URL below and File → Save Page As → "Webpage, HTML Only"
    2. Name the files exactly as shown and commit to scripts/fr_cache/

    URL                                                    → filename
    ─────────────────────────────────────────────────────────────────
    …seriesitemlist&id=3342&ssid=-1  (Loyal Subjects)  → fr_3342.html
    …seriesitemlist&id=3343&ssid=-1  (Hot Wheels etc.) → fr_3343.html
    …seriesitemlist&id=3344&ssid=-1  (Mega Construx)   → fr_3344.html
    …seriesitemlist&id=1333&ssid=-1  (DC vs MOTU)      → fr_1333.html

  Base URL for all:
    https://www.figurerealm.com/actionfigure?action=seriesitemlist

  Refreshing the cache: re-save the page from a browser and re-commit.
  The scraper prints a warning if a cache file is missing and skips
  that series rather than failing the whole workflow.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Usage:
  python sync_figurerealm.py                    # dry run — shows what's new
  python sync_figurerealm.py --commit           # updates figures.json + downloads images
  python sync_figurerealm.py --audit            # compare only, detailed report
  python sync_figurerealm.py --line loyal-subjects   # one series only

SERIES CONFIG
  Each entry maps a FigureRealm series id to an app line id and a
  display label used in the group field.  The FR series id is the
  numeric `id=` param in the checklist URL.

  FR id   → app line         group prefix
  ──────────────────────────────────────────────────────────────────
  3342    → cross-brand      Loyal Subjects
  3343    → cross-brand      (sub-group from page: Hot Wheels, etc.)
  3344    → cross-brand      Mega Construx
  1333    → cross-brand      DC Universe vs MOTU

  Adding more series later: append a tuple to FR_SERIES below, save
  the HTML to scripts/fr_cache/fr_{id}.html, and re-run.

ID SCHEME
  FigureRealm figure IDs are numeric.  To avoid any collision with
  AF411 IDs, all FR-sourced figures get the prefix "fr-":
    fr-{fr_id}-{name_slug}
  e.g.  fr-52342-beastmanred
  This is stable: FR IDs never change once assigned.

CHANGELOG
  v1.2 (2026-06-24) — fix thumb URL extraction from browser-saved HTML
    - Browser "Save Page As" rewrites img src to local paths. The parser
      now reads the `front` attribute instead, which always contains the
      original relative path (galleries/{series}/thumb_{name}.jpg).
      Reconstructs the full URL by prepending the FR base. Falls back to
      src for live fetches where the full URL is still intact.
      Result: 100% thumb capture rate on all four series.
  v1.1 (2026-06-23) — cache-first
    - Reads from scripts/fr_cache/fr_{id}.html instead of live fetches
      (GitHub Actions IPs blocked by FigureRealm).
    - Falls back to live fetch if cache file missing and --allow-fetch
      flag is set (for local runs where your IP isn't blocked).
    - Cache file age displayed in output so you know when to refresh.
  v1.0 (2026-06-23) — initial release
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
import html as _html_mod
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────

SCRIPT_VERSION = "v1.2"

BASE = "https://www.figurerealm.com"

# Cache directory — pre-saved HTML files live here.
# Path: scripts/fr_cache/fr_{series_id}.html
CACHE_DIR = Path(__file__).resolve().parent / "fr_cache"

# (fr_series_id, app_line_id, series_label, group_mode)
# group_mode:
#   'prefix'  → use series_label as the group (e.g. "Loyal Subjects")
#   'page'    → use the group header scraped from the page as-is
#               (good for id=3343 which has Hot Wheels, Hot Wheels - Real Riders, etc.)
FR_SERIES = [
    ("3342", "cross-brand", "Loyal Subjects",       "prefix"),
    ("3343", "cross-brand", "Hot Wheels",            "page"),   # page has sub-groups
    ("3344", "cross-brand", "Mega Construx",         "prefix"),
    ("1333", "cross-brand", "DC Universe vs MOTU",   "prefix"),
]

# Convenience lookup by series id for --line flag matching
FR_SERIES_BY_ID   = {s[0]: s for s in FR_SERIES}
FR_SERIES_BY_LABEL = {s[2].lower().replace(" ", "-"): s for s in FR_SERIES}
# Also allow matching by app label shorthand
_LABEL_ALIASES = {
    "loyal-subjects": "3342",
    "hot-wheels":     "3343",
    "mega-construx":  "3344",
    "dc-vs-motu":     "1333",
}

REPO_ROOT    = Path(__file__).resolve().parent.parent
FIGURES_JSON = REPO_ROOT / "figures.json"
PENDING_JSON = REPO_ROOT / "figures-pending.json"
REJECTED_JSON= REPO_ROOT / "figures-rejected.json"
IMAGES_DIR   = REPO_ROOT

# Fields the scraper owns.  Everything else on an existing entry is preserved.
SCRAPER_FIELDS = {"name", "line", "group", "year", "slug", "source"}

# ─── Faction guessing (identical to sync_af411.py) ────────────────

FACTION_KEYWORDS = {
    "Evil Horde":      ["hordak", "grizzlor", "leech", "mantenna", "modulok",
                        "multi-bot", "dragstor", "hurricane", "horde", "imp",
                        "catra", "entrapta", "scorpia", "shadow weaver"],
    "Snake Men":       ["king hiss", "king hsss", "kobra khan", "tung lashor",
                        "rattlor", "squeeze", "sssqueeze", "snake", "serpentine"],
    "Great Rebellion": ["she-ra", "bow", "glimmer", "frosta", "perfuma",
                        "mermista", "castaspella", "flutterina", "angella",
                        "netossa", "spinnerella", "sweet bee", "peekablue",
                        "adora", "princess of power", "rebellion", "etheria"],
    "Evil Warriors":   ["skeletor", "beast man", "evil-lyn", "trap jaw",
                        "tri-klops", "mer-man", "faker", "clawful", "whiplash",
                        "jitsu", "webstor", "kobra", "ninjor", "scare glow",
                        "stinkor", "spikor", "two bad", "blast-attak",
                        "blade", "saurod", "lex luthor", "bizarro",
                        "joker", "sinestro"],
    "Heroic Warriors": ["he-man", "man-at-arms", "teela", "orko", "ram man",
                        "stratos", "buzz-off", "man-e-faces", "mekaneck",
                        "fisto", "roboto", "sy-klone", "snout spout",
                        "rio blast", "extendar", "gwildor", "sorceress",
                        "zodac", "moss man", "clamp champ", "superman",
                        "aquaman", "green lantern", "hawkman", "supergirl"],
}

def guess_faction(name, group=""):
    combined = f"{name} {group}".lower()
    for faction, keywords in FACTION_KEYWORDS.items():
        for kw in keywords:
            if kw in combined:
                return faction
    return "Other"

# ─── Atomic write (identical to sync_af411.py) ────────────────────

def atomic_write_text(path, text):
    """Write via temp file + os.replace() so a crash never leaves a partial file."""
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)

# ─── HTTP fetch ───────────────────────────────────────────────────

_HEADERS = {
    # FigureRealm returns 403 on plain Python User-Agent strings.
    # A realistic browser UA gets through fine.
    "User-Agent": (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

def fetch_page(url, retries=3, delay=2):
    """Fetch a URL with retries. Returns HTML string or None on failure."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=_HEADERS)
            with urllib.request.urlopen(req, timeout=30) as resp:
                raw = resp.read()
                # FR serves UTF-8; fall back to latin-1 for stray bytes
                try:
                    return raw.decode("utf-8")
                except UnicodeDecodeError:
                    return raw.decode("latin-1", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"  ⚠ Attempt {attempt + 1} failed for {url}: {e}")
            if attempt < retries - 1:
                time.sleep(delay * (attempt + 1))
    return None

# ─── HTML → text conversion ───────────────────────────────────────

_TAG_RE  = re.compile(r"<[^>]+>")

def _slugify(name):
    """Convert figure name to a URL-safe slug for the app ID."""
    s = name.lower()
    s = re.sub(r"[^a-z0-9]+", "", s)   # keep only alphanumeric
    return s[:40]                        # cap length

def parse_checklist_html(html, fr_series_id, app_line_id, series_label, group_mode):
    """
    Parse a FigureRealm checklist page.

    Strategy: operate on raw HTML — URLs live in tag attributes which
    html_to_text() strips out.  Three independent passes:

      1. IMG pass  — <a href="…id=N…"><img src="…thumb_…"> → thumb URL keyed by FR id
      2. TEXT pass — <a href="…id=N…">Name</a>             → figure name keyed by FR id
      3. GROUP pass — <h2>/<h3> tags                        → section headers in order

    Then a sequential walk through TEXT matches to assign group + year.
    """

    # ── Pass 1: thumbnail URLs ─────────────────────────────────────
    # Browser "Save Page As" rewrites img src to local paths like
    # "fr_1333_files/thumb_X_S0rS.jpg". The original URL is preserved
    # in the `front` attribute: front="galleries/{series}/thumb_X.jpg"
    # We reconstruct the full URL by prepending the FR base.
    IMG_A_RE = re.compile(
        r'<a\s[^>]*href="[^"]*actionfigure\?action=actionfigure&(?:amp;)?id=(\d+)&(?:amp;)?figure=[^"]*"[^>]*>'
        r'\s*<img\s[^>]*(?:'
        # Option A: front attribute with relative path (browser-saved HTML)
        r'front="(galleries/[^"]+\.(?:jpg|png))"'
        r'|'
        # Option B: src still has the full figurerealm.com URL (live fetch)
        r'src="(https://www\.figurerealm\.com/galleries/[^"]+/thumb_[^"]+\.(?:jpg|png))"'
        r')',
        re.I | re.S
    )
    thumbs = {}  # fr_id → thumb_url
    for m in IMG_A_RE.finditer(html):
        fr_id     = m.group(1)
        rel_path  = m.group(2)   # from front= attribute (browser-saved)
        full_url  = m.group(3)   # from src= attribute (live fetch)
        if rel_path:
            thumbs[fr_id] = f"https://www.figurerealm.com/{rel_path}"
        elif full_url:
            thumbs[fr_id] = full_url

    # ── Pass 2: text links (name + id + position in HTML) ──────────
    TEXT_A_RE = re.compile(
        r'<a\s[^>]*href="[^"]*actionfigure\?action=actionfigure&(?:amp;)?id=(\d+)&(?:amp;)?figure=[^"]*"[^>]*>'
        r'([^<]{2,80})</a>',
        re.I
    )
    # Collect all text-link matches with their position; dedup keeping first
    # occurrence per id (image links have empty/short inner text and are
    # filtered by the {2,80} quantifier above, so first match = text link)
    text_links = []   # list of (fr_id, name, match_start)
    seen = set()
    for m in TEXT_A_RE.finditer(html):
        fr_id = m.group(1)
        name  = _html_mod.unescape(m.group(2)).strip()
        if fr_id not in seen and name:
            seen.add(fr_id)
            text_links.append((fr_id, name, m.start()))

    # ── Pass 3: group headers with positions ───────────────────────
    GROUP_H_RE = re.compile(r'<h[23][^>]*>([^<]+)</h[23]>', re.I)
    # Also catch bold standalone lines used as group headers on some series
    # Pattern: <td …><b>Group Name</b></td> or <p><b>Group Name</b></p>
    BOLD_GROUP_RE = re.compile(r'<(?:td|p)[^>]*>\s*<b>([^<]{3,60})</b>\s*</(?:td|p)>', re.I)
    groups = []  # list of (name, position)
    for m in GROUP_H_RE.finditer(html):
        groups.append((m.group(1).strip(), m.start()))
    for m in BOLD_GROUP_RE.finditer(html):
        txt = m.group(1).strip()
        # Exclude breadcrumb-style text containing URLs or "Checklist"
        if "Checklist" not in txt and "figurerealm" not in txt.lower():
            groups.append((txt, m.start()))
    groups.sort(key=lambda x: x[1])  # sort by position in document

    def group_at(pos):
        """Return the most recent group header before document position pos."""
        current = series_label  # default
        for gname, gpos in groups:
            if gpos <= pos:
                current = gname
            else:
                break
        return current

    # ── Pass 4: Released-in year lookup ───────────────────────────
    RELEASED_RE = re.compile(r'Released in (\d{4})?\s*by\s+[^<\n]+', re.I)

    def year_after(pos):
        """Find the first 'Released in YYYY' within 600 chars after pos."""
        snippet = html[pos:pos + 600]
        m = RELEASED_RE.search(snippet)
        if m and m.group(1):
            return int(m.group(1))
        return None

    # ── Assemble figures ───────────────────────────────────────────
    figures = []
    for fr_id, name, pos in text_links:
        raw_group = group_at(pos)
        group = series_label if group_mode == "prefix" else raw_group
        year  = year_after(pos)
        app_id = f"fr-{fr_id}-{_slugify(name)}"

        figures.append({
            "fr_id":       fr_id,
            "fr_slug":     _slugify(name),
            "id":          app_id,
            "slug":        app_id,
            "name":        name,
            "line":        app_line_id,
            "sourceLine":  app_line_id,
            "group":       group,
            "sourceGroup": group,
            "year":        year,
            "wave":        "",
            "retail":      0,
            "faction":     guess_faction(name, group),
            "source":      "figurerealm",
            "fr_series":   fr_series_id,
            "thumb_url":   thumbs.get(fr_id),
        })

    return figures


def load_series_html(fr_series_id, allow_fetch=False):
    """
    Return HTML for a FigureRealm series checklist.

    Priority:
      1. scripts/fr_cache/fr_{id}.html  — always tried first
      2. Live fetch                      — only if --allow-fetch flag is set

    Prints the cache file age so you know when to refresh.
    Returns (html_string, source_label) or (None, None) on failure.
    """
    cache_file = CACHE_DIR / f"fr_{fr_series_id}.html"

    if cache_file.exists():
        try:
            html = cache_file.read_text(encoding="utf-8", errors="replace")
            # Show file age
            age_s = int(time.time() - cache_file.stat().st_mtime)
            if age_s < 3600:
                age_str = f"{age_s // 60}m ago"
            elif age_s < 86400:
                age_str = f"{age_s // 3600}h ago"
            else:
                age_str = f"{age_s // 86400}d ago"
            return html, f"cache ({age_str})"
        except Exception as e:
            print(f"  ⚠ Cache read failed for {cache_file.name}: {e}")

    if allow_fetch:
        url = f"{BASE}/actionfigure?action=seriesitemlist&id={fr_series_id}&ssid=-1"
        print(f"  ↳ Cache miss — fetching live: {url}")
        html = fetch_page(url)
        if html:
            return html, "live fetch"
        return None, None

    print(f"  ✗ Cache file not found: {cache_file}")
    print(f"    → Save the page from a browser and commit it to scripts/fr_cache/")
    print(f"    → URL: {BASE}/actionfigure?action=seriesitemlist&id={fr_series_id}&ssid=-1")
    return None, None


def scrape_series(fr_series_id, app_line_id, series_label, group_mode, allow_fetch=False, delay=1.5):
    """Load and parse one FigureRealm series checklist."""
    html, source = load_series_html(fr_series_id, allow_fetch=allow_fetch)
    if not html:
        return []
    print(f"  Parsing [{series_label}] from {source}")
    figs = parse_checklist_html(html, fr_series_id, app_line_id, series_label, group_mode)
    print(f"  ✓ Found {len(figs)} figures in [{series_label}]")
    return figs


# ─── Image download ───────────────────────────────────────────────

def download_image(fig, delay=0):
    """
    Download the figure's thumbnail from FigureRealm.
    Saves as {app_id}.jpg in IMAGES_DIR (same location as AF411 images).
    Uses the thumb_url captured during parse; falls back to a constructed URL.
    """
    dest = IMAGES_DIR / f"{fig['id']}.jpg"
    if dest.exists():
        return True

    thumb_url = fig.get("thumb_url")
    if not thumb_url:
        print(f"    ⚠ No thumb URL for {fig['id']}, skipping image")
        return False

    try:
        req = urllib.request.Request(thumb_url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
        if len(data) < 500:
            print(f"    ⚠ Image suspiciously small for {fig['id']} ({len(data)} bytes)")
            return False
        dest.write_bytes(data)
        if delay:
            time.sleep(delay)
        return True
    except Exception as e:
        print(f"    ⚠ Image download failed for {fig['id']}: {e}")
        return False


# ─── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MOTU Vault FigureRealm Sync")
    parser.add_argument("--commit", action="store_true",
                        help="Actually update figures.json and download images")
    parser.add_argument("--audit", action="store_true",
                        help="Detailed comparison report only")
    parser.add_argument("--line", type=str, default=None,
                        help="Sync only one series — use the label alias "
                             "(loyal-subjects, hot-wheels, mega-construx, dc-vs-motu) "
                             "or the numeric FR series id")
    parser.add_argument("--delay", type=float, default=1.5,
                        help="Seconds between page fetches (default: 1.5)")
    parser.add_argument("--allow-fetch", action="store_true",
                        help="Fall back to live HTTP fetch if cache file is missing "
                             "(only works if your IP isn't blocked by FigureRealm — "
                             "GitHub Actions IPs will get 403)")
    parser.add_argument("--no-pending", action="store_true",
                        help="Write new figures directly to figures.json "
                             "instead of routing them to the review queue")
    args = parser.parse_args()

    print("═" * 60)
    print(f"  MOTU Vault — FigureRealm Sync  {SCRIPT_VERSION}")
    print(f"  Cache dir: {CACHE_DIR}")
    cache_files = list(CACHE_DIR.glob("fr_*.html")) if CACHE_DIR.exists() else []
    if cache_files:
        print(f"  Cached series: {', '.join(f.stem for f in sorted(cache_files))}")
    else:
        print(f"  ⚠ No cache files found in {CACHE_DIR}")
        print(f"    Run workflow after committing fr_XXXX.html files to scripts/fr_cache/")
    print("═" * 60)

    # ── Load existing data ─────────────────────────────────────────
    existing = []
    if FIGURES_JSON.exists():
        try:
            existing = json.loads(FIGURES_JSON.read_text())
            print(f"\n📂 Loaded {len(existing)} existing figures from figures.json")
        except json.JSONDecodeError:
            print("⚠ Could not parse figures.json — starting fresh")
    existing_by_id = {f["id"]: f for f in existing}

    pending = []
    if PENDING_JSON.exists():
        try:
            pending = json.loads(PENDING_JSON.read_text())
            print(f"📋 Loaded {len(pending)} figures in pending queue")
        except json.JSONDecodeError:
            print("⚠ Could not parse figures-pending.json — starting fresh")
    pending_by_id = {f["id"]: f for f in pending}

    rejected_ids = set()
    if REJECTED_JSON.exists():
        try:
            rj = json.loads(REJECTED_JSON.read_text())
            rejected_ids = set(rj if isinstance(rj, list) else rj.get("rejected", []))
            print(f"🚫 {len(rejected_ids)} figures permanently rejected")
        except json.JSONDecodeError:
            print("⚠ Could not parse figures-rejected.json")

    # ── Resolve --line filter ──────────────────────────────────────
    series_to_scrape = list(FR_SERIES)
    if args.line:
        key = args.line.lower()
        # Try alias first, then direct numeric id
        numeric_id = _LABEL_ALIASES.get(key, key if key.isdigit() else None)
        if numeric_id and numeric_id in FR_SERIES_BY_ID:
            series_to_scrape = [FR_SERIES_BY_ID[numeric_id]]
        else:
            valid = ", ".join(_LABEL_ALIASES.keys())
            print(f"✗ Unknown series '{args.line}'. Valid aliases: {valid}")
            sys.exit(1)

    # ── Scrape ────────────────────────────────────────────────────
    print(f"\n🔍 Scraping FigureRealm…\n")
    all_scraped = []
    for i, (fr_id, line_id, label, mode) in enumerate(series_to_scrape):
        figs = scrape_series(fr_id, line_id, label, mode,
                             allow_fetch=args.allow_fetch, delay=args.delay)
        all_scraped.extend(figs)
        if i < len(series_to_scrape) - 1:
            time.sleep(0.2)  # brief pause between cache reads (no rate limit needed)

    scraped_by_id  = {f["id"]: f for f in all_scraped}
    scraped_ids    = set(scraped_by_id)
    existing_ids   = set(existing_by_id)
    pending_ids    = set(pending_by_id)

    # ── Diff ──────────────────────────────────────────────────────
    skipped_rejected = scraped_ids & rejected_ids
    new_candidates   = scraped_ids - existing_ids - pending_ids - rejected_ids
    new_for_pending  = set() if args.no_pending else new_candidates
    new_for_existing = new_candidates if args.no_pending else set()
    pending_refresh  = scraped_ids & pending_ids

    # ── Report ────────────────────────────────────────────────────
    print(f"\n{'═' * 60}")
    print(f"  SYNC REPORT — FigureRealm")
    print(f"{'═' * 60}")
    print(f"  FR total scraped:      {len(all_scraped)}")
    print(f"  Already in figures.json: {len(scraped_ids & existing_ids)}")
    print(f"  Already in pending:      {len(scraped_ids & pending_ids)}")
    print(f"  Permanently rejected:    {len(skipped_rejected)}")
    print(f"  ─" * 30)
    if args.no_pending:
        print(f"  New → figures.json:      {len(new_for_existing)}")
    else:
        print(f"  New → pending queue:     {len(new_for_pending)}")
    print(f"  Pending refreshed:       {len(pending_refresh)}")
    print()

    if new_candidates:
        bucket = "figures.json (no-pending)" if args.no_pending else "PENDING QUEUE"
        print(f"  ── NEW FIGURES → {bucket} ──")
        for fid in sorted(new_candidates):
            f = scraped_by_id[fid]
            print(f"    + [{f['group']}] {f['name']} ({f['year'] or '?'}) — {fid}")
        print()

    if args.audit:
        # Show what's already matched
        matched = scraped_ids & existing_ids
        if matched:
            print(f"  ── ALREADY IN figures.json ({len(matched)}) ──")
            for fid in sorted(matched):
                f = scraped_by_id[fid]
                print(f"    ✓ {f['name']} — {fid}")
            print()

    if not new_for_pending and not new_for_existing and not pending_refresh:
        print("  ✓ Everything is in sync!\n")
        return

    if not args.commit:
        print("  ℹ Dry run — use --commit to apply changes\n")
        return

    # ── Apply changes ──────────────────────────────────────────────
    print("  📝 Applying changes…\n")

    def build_fig(s, for_pending):
        out = {
            "id":          s["id"],
            "name":        s["name"],
            "sourceName":  s["name"],
            "line":        s["line"],
            "sourceLine":  s["line"],
            "group":       s["group"],
            "sourceGroup": s["group"],
            "wave":        "",
            "year":        s["year"],
            "retail":      0,
            "slug":        s["slug"],
            "faction":     s["faction"],
            "source":      "figurerealm",
            "fr_id":       s["fr_id"],
            "fr_series":   s["fr_series"],
        }
        if for_pending:
            out["_addedToPending"] = int(time.time())
        return out

    img_ok = img_fail = 0

    # Refresh pending entries (name/year only — don't overwrite user edits)
    new_pending     = list(pending)
    new_pending_by_id = {f["id"]: f for f in new_pending}
    for fid in pending_refresh:
        s = scraped_by_id[fid]
        p = new_pending_by_id[fid]
        if s["name"]:  p["name"] = s["name"]
        if s["year"]:  p["year"] = s["year"]

    # Route new figures
    merged = list(existing)
    targets = sorted(new_for_pending or new_for_existing)
    for fid in targets:
        s = scraped_by_id[fid]
        fig = build_fig(s, for_pending=bool(new_for_pending))
        if new_for_pending:
            new_pending.append(fig)
        else:
            merged.append(fig)

        print(f"  📷 Downloading image: {s['id']}")
        if download_image(s, delay=0.4):
            img_ok += 1
        else:
            img_fail += 1
        time.sleep(0.3)

    # ── Sort and write ────────────────────────────────────────────
    def sort_key(f):
        line_order = ["origins", "masterverse", "kids-core", "chronicles",
                      "cross-brand", "classics", "200x", "original",
                      "new-adventures", "mondo", "super7", "eternia-minis",
                      "mighty-masters", "motu-giants"]
        return (line_order.index(f.get("line", "")) if f.get("line") in line_order else 99,
                f.get("group", ""),
                f.get("name", ""))

    merged.sort(key=sort_key)
    atomic_write_text(FIGURES_JSON, json.dumps(merged, indent=2, ensure_ascii=False))
    print(f"\n  ✓ Wrote {len(merged)} figures to figures.json")

    if new_for_pending or pending_refresh:
        new_pending.sort(key=sort_key)
        atomic_write_text(PENDING_JSON, json.dumps(new_pending, indent=2, ensure_ascii=False))
        print(f"  ✓ Wrote {len(new_pending)} figures to figures-pending.json")

    print(f"  ✓ Images: {img_ok} downloaded, {img_fail} failed")
    if new_for_pending:
        print(f"\n  ▸ Open figures-editor.html to review {len(new_for_pending)} new figure(s)")

    # ── Sync summary for CI ───────────────────────────────────────
    try:
        summary = {
            "new_pending_count": len(new_for_pending),
            "new_pending": [
                {"id": fid, "name": scraped_by_id[fid]["name"],
                 "line": scraped_by_id[fid]["line"]}
                for fid in sorted(new_for_pending)
            ],
            "pending_total":     len(new_pending),
            "figures_total":     len(merged),
            "images_downloaded": img_ok,
            "images_failed":     img_fail,
            "line_filter":       args.line or "",
        }
        Path("/tmp/motu-fr-sync-summary.json").write_text(
            json.dumps(summary, indent=2, ensure_ascii=False)
        )
    except Exception as e:
        print(f"  ⚠ Could not write sync summary: {e}")

    print(f"\n{'═' * 60}\n")


if __name__ == "__main__":
    main()
