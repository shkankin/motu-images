#!/usr/bin/env python3
"""
MOTU Vault — AF411 Catalog Sync
Scrapes actionfigure411.com checklist pages for all MOTU lines,
diffs against the existing figures.json, downloads new images,
and outputs an updated figures.json.

Usage:
  python sync_af411.py                    # dry run — shows what's new
  python sync_af411.py --commit           # updates figures.json + downloads images
  python sync_af411.py --audit            # compare only, detailed report

CHANGELOG
  v1.7 (2026-06-21) — security/reliability audit
    - Atomic JSON writes. figures.json and figures-pending.json are now
      written via a temp file + os.replace() (see atomic_write_text), so a
      crash or CI-runner eviction mid-write can no longer leave a truncated
      file for the workflow's commit step to push.
    - Startup banner prints SCRIPT_VERSION for visual confirmation in CI logs.
    - Companion workflow bumped to v1.8: the commit/push and Discord steps
      gained a success() guard, and workflow_dispatch string inputs are now
      passed through env vars instead of being interpolated into the shell
      (script-injection hardening).

  v1.6 (2026-06-14)
    - UPC capture. New --upc flag fetches each figure's AF411 detail page and
      extracts its UPC barcode (the checklist pages used for normal scraping
      don't carry UPCs — only the per-figure detail pages do). Incremental:
      figures that already have a upc are skipped, so the first --upc run
      backfills the catalog and later runs only fetch genuinely new figures.
      --upc-limit N caps detail-page fetches per run for a gentle first pass.
      upc flows into new figures.json/pending records and is refreshed onto
      pending entries; the app (v6.83+) searches figure.upc, so a scanned or
      typed barcode jumps straight to the figure.

  v1.4 (2026-04-27)
    - Review queue. New figures route to figures-pending.json instead of
      figures.json. Existing figures still get metadata updates applied
      directly (only brand-new entries need review).
    - figures-rejected.json: optional list of slugs the editor has rejected.
      Skipped on every subsequent sync so they don't keep re-queueing.
    - --no-pending flag bypasses the queue (legacy behavior).
    - Companion: figures-editor.html — standalone web editor that reads
      the pending queue, lets you fix line/group/faction/loadout/etc., and
      downloads merged figures.json + loadouts.json + figures-rejected.json
      on approval.

  v1.3 (2026-04-27)
    - Line-override protection. Each scraped entry now also writes a
      `sourceLine` field equal to whatever AF411 said the line was. The
      active `line` field is whatever the user/maintainer set it to.
      If `line != sourceLine` on an existing entry, the script treats it
      as a manual override and never touches the `line` field again.
    - This solves: AF411 mis-categorizes Kids Core figures under
      "chronicles". Manually re-tagging them `line: "kids-core"` in
      figures.json now sticks across syncs.
    - Audit mode now reports every `line != sourceLine` entry — your
      master list of "what AF411 has wrong."
    - New chronicles entries are flagged in the audit report as
      potentially-Kids-Core, since AF411 buries them there with no
      structural marker.
    - One-time backfill: existing Kids Core figures need
      `sourceLine: "chronicles"` added so the protection kicks in. See
      MIGRATION section below.

  v1.2 (2026-04-27)
    - Kids Core line added to LINES (commented out — uncomment when AF411
      publishes the checklist page).
    - Group normalization: scraped group strings are passed through
      KIDS_CORE_GROUP_MAP before write, so AF411's labeling (likely
      "Kids Core Action Figures" etc.) maps to the canonical group names
      the app expects ("Action Figures", "Vehicles & Playsets", "Movie (2026)").
    - kids-core.json file is no longer maintained — Kids Core figures live
      in figures.json like every other line. App was updated in v6.16 to
      stop fetching the separate file.

  v1.5 (2026-05-01)
    - sourceGroup field. Parallel to sourceLine — tracks what AF411 says the
      group/subline is. If `group != sourceGroup` on an existing entry, the
      script treats it as a manual override and never overwrites `group` again.
      Fixes: a figure manually moved from "Chronicles" to "Exclusives" staying
      put across syncs even if AF411 still lists it under the old group.
    - Audit mode now reports group overrides alongside line overrides.
    - One-time backfill: existing figures with manual group corrections need
      `sourceGroup` added (same jq pattern as the sourceLine migration).


  For every Kids Core figure currently in figures.json that was originally
  scraped from AF411's chronicles page and hand-corrected to line:'kids-core',
  add `"sourceLine": "chronicles"` to the entry. After that, the script
  detects the line!=sourceLine mismatch and protects the entry forever.

  Quick way to find them all (jq):
    jq '[.[] | select(.line=="kids-core" and (has("sourceLine")|not))
        | .id]' figures.json

  Then bulk-add the field — example with jq:
    jq '(.[] | select(.line=="kids-core" and (has("sourceLine")|not)))
        |= . + {"sourceLine":"chronicles"}' figures.json > tmp.json \
        && mv tmp.json figures.json
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.request
import urllib.error
from html.parser import HTMLParser
from pathlib import Path

# ─── Configuration ────────────────────────────────────────────────

# AUDIT FIX v1.7: bumped for visual confirmation in CI logs (printed in the
# startup banner below) and to ship atomic JSON writes — see atomic_write_text.
SCRIPT_VERSION = "v1.8"

BASE = "https://www.actionfigure411.com"
MOTU = "/masters-of-the-universe"


def atomic_write_text(path, text):
    """AUDIT FIX v1.7: write to a sibling temp file, fsync, then os.replace().

    The previous Path.write_text() was non-atomic: a process kill (or CI
    runner eviction) mid-write could leave a truncated figures.json on disk,
    which the workflow's commit step would then push. os.replace() is atomic
    on POSIX, so readers/committers only ever see the complete old file or the
    complete new file — never a partial one.
    """
    path = Path(path)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, path)

# Each line: (line_id for our app, AF411 checklist URL slug, AF411 series path segment)
LINES = [
    ("origins",         "origins-checklist.php",                    "origins"),
    ("masterverse",     "masterverse-checklist.php",                "masterverse"),
    ("chronicles",      "chronicles-checklist.php",                 "mattel-chronicles"),
    ("classics",        "mattel-classics-checklist.php",            "mattel-classics"),
    ("200x",            "mattel-200x-checklist.php",                "mattel-200x"),
    ("original",        "original-checklist.php",                   "original"),
    ("new-adventures",  "new-adventures-he-man-checklist.php",      "new-adventures-he-man"),
    ("mondo",           "mondo-checklist.php",                      "mondo"),
    ("super7",          "super7-checklist.php",                     "super7"),
    ("eternia-minis",   "eternia-minis-checklist.php",              "eternia-minis"),
    # v1.2: Kids Core. AF411 has not published a checklist page for this
    # line yet (line is too new). Uncomment when the page exists. The most
    # likely URL pattern based on AF411's other lines:
    # ("kids-core",       "kids-core-checklist.php",                  "kids-core"),
    # If AF411 uses a different slug, only this entry needs to change.
]

# v1.2: Kids Core group normalization.
# AF411 labels its bold-header groups verbosely (e.g. "Kids Core Action Figures").
# The MOTU Vault app's SUBLINES config recognizes shorter canonical names.
# This map normalizes the scraped group string before writing to figures.json,
# so each Kids Core figure lands in the right subline in the app.
#
# The app's recognized Kids Core groups (from state.js SUBLINES['kids-core']):
#   - "Action Figures"
#   - "Vehicles & Playsets"  (also accepts "Vehicles and Playsets")
#   - "Movie (2026)"         (also accepts "Movie")
#
# Any group string not matched here passes through unchanged.
KIDS_CORE_GROUP_MAP = {
    # Action figures — strip the "Kids Core" prefix
    "Kids Core Action Figures": "Action Figures",
    "Kids Core Figures": "Action Figures",
    "Action Figures": "Action Figures",
    # Vehicles & playsets — normalize all phrasings
    "Kids Core Vehicles & Playsets": "Vehicles & Playsets",
    "Kids Core Vehicles and Playsets": "Vehicles & Playsets",
    "Vehicles and Playsets": "Vehicles & Playsets",
    "Vehicles & Playsets": "Vehicles & Playsets",
    "Vehicles": "Vehicles & Playsets",
    "Playsets": "Vehicles & Playsets",
    # Movie line (the 2026 film tie-in figures)
    "Kids Core Movie": "Movie (2026)",
    "Kids Core Movie (2026)": "Movie (2026)",
    "Movie": "Movie (2026)",
    "Movie (2026)": "Movie (2026)",
    "2026 Movie": "Movie (2026)",
}

# v1.3: Chronicles group normalization.
# AF411 checklist bold headers (after stripping " Checklist" suffix):
#   "Movie Action Figures"  → "Movie"
#   "Core Action Figures"   → "Core (Non-Movie)"
#   "Action Figures"        → "Core (Non-Movie)"  (fallback)
# The canonical group names come from state.js SUBLINES['chronicles'].
CHRONICLES_GROUP_MAP = {
    "movie action figures": "Movie",
    "movie figures":        "Movie",
    "movie":                "Movie",
    "core action figures":  "Core (Non-Movie)",
    "core figures":         "Core (Non-Movie)",
    "action figures":       "Core (Non-Movie)",
}

def normalize_group(line_id, raw_group):
    """v1.2: Map AF411-scraped group strings to canonical app group names.
    v1.3: Chronicles group normalization added."""
    if not raw_group:
        return raw_group
    if line_id == "kids-core":
        return KIDS_CORE_GROUP_MAP.get(raw_group.strip(), raw_group.strip())
    if line_id == "chronicles":
        return CHRONICLES_GROUP_MAP.get(raw_group.strip().lower(), "Core (Non-Movie)")
    return raw_group

# Faction keywords to auto-classify (best-effort from name/group)
FACTION_KEYWORDS = {
    "Evil Horde":       ["hordak", "grizzlor", "leech", "mantenna", "modulok",
                         "multi-bot", "dragstor", "hurricane", "horde", "imp",
                         "catra", "entrapta", "scorpia", "shadow weaver"],
    "Snake Men":        ["king hiss", "king hsss", "kobra khan", "tung lashor",
                         "rattlor", "squeeze", "sssqueeze", "snake", "serpentine"],
    "Great Rebellion":  ["she-ra", "bow", "glimmer", "frosta", "perfuma",
                         "mermista", "castaspella", "flutterina", "angella",
                         "netossa", "spinnerella", "sweet bee", "peekablue",
                         "adora", "princess of power", "rebellion", "etheria"],
    "Evil Warriors":    ["skeletor", "beast man", "evil-lyn", "trap jaw",
                         "tri-klops", "mer-man", "faker", "clawful", "whiplash",
                         "jitsu", "webstor", "kobra", "ninjor", "scare glow",
                         "stinkor", "spikor", "two bad", "blast-attak",
                         "blade", "saurod"],
    "Heroic Warriors":  ["he-man", "man-at-arms", "teela", "orko", "ram man",
                         "stratos", "buzz-off", "man-e-faces", "mekaneck",
                         "fisto", "roboto", "sy-klone", "snout spout",
                         "rio blast", "extendar", "gwildor", "sorceress",
                         "zodac", "moss man", "clamp champ"],
}

REPO_ROOT = Path(__file__).resolve().parent.parent  # assumes scripts/ is one level down
FIGURES_JSON = REPO_ROOT / "figures.json"
PENDING_JSON = REPO_ROOT / "figures-pending.json"   # v1.4: review queue for new figures
REJECTED_JSON = REPO_ROOT / "figures-rejected.json" # v1.4: slugs the editor said no to
LOADOUTS_JSON = REPO_ROOT / "loadouts.json"          # v1.8: per-figure accessory loadouts (read-only here, for incremental skip)
LOADOUTS_SUGGESTED_JSON = REPO_ROOT / "loadouts-suggested.json"  # v1.8: heuristic accessory suggestions for editor review
IMAGES_DIR = REPO_ROOT / "images"  # v1.3: images moved to images/ subdirectory

# v1.1: fields that the scraper KNOWS about. Anything else on an existing entry
# (overrides, app-specific flags, manual annotations) is preserved verbatim
# during merge. Keep this list narrow to be data-loss-safe.
SCRAPER_FIELDS = {"name", "line", "group", "wave", "year", "retail", "slug"}

# v1.5: Manual field patches applied unconditionally after every sync.
# Mirrors the PATCHED dict in the CI verify step (sync-af411.yml) so the
# post-sync assertion always passes. Add entries here whenever a figure
# needs a permanent group correction that AF411 hasn't fixed upstream.
# Schema: { fig_id: { field: value } }
MANUAL_PATCHES = {
    "2026-movie-4-pack-13440":                           {"group": "Exclusives"},
    "beast-man-deluxe-13523":                            {"group": "Deluxe"},
    "fright-fighter-2026-movie-13439":                   {"group": "Vehicles & Playsets"},
    "he-man-nick-galitzine-13442":                       {"group": "Action Figures"},
    "he-man-and-sky-sled-2026-movie-13444":              {"group": "Vehicles & Playsets"},
    "spikor-2026-movie-13443":                           {"group": "Action Figures"},
    "trap-jaw-2026-movie-deluxe-13438":                  {"group": "Deluxe"},
    "beast-man-1987-movie-8420":                         {"group": "Movie"},
    # king-grayskull-13486 and ram-man-*-13441 only assert source in CI, no group patch needed
}

# ─── HTML Parser for Checklist Pages ──────────────────────────────

class ChecklistParser(HTMLParser):
    """
    Parses an AF411 checklist page.
    Each figure row has a link like:
      /masters-of-the-universe/origins/origins-action-figures/he-man-2393.php
    And table cells: Name, Wave, Year, Retail
    The current group/subline is in a bold header row above each table.
    """

    def __init__(self):
        super().__init__()
        self.figures = []
        self.current_group = ""
        self._in_link = False
        self._in_bold = False
        self._in_td = False
        self._bold_text = ""
        self._current_fig = None
        self._row_cells = []
        self._cell_text = ""
        self._link_href = ""
        self._link_text = ""
        self._in_row = False
        self._in_header_row = False

    def handle_starttag(self, tag, attrs):
        attrs_d = dict(attrs)
        if tag == "tr":
            self._in_row = True
            self._row_cells = []
            self._current_fig = None
            self._in_header_row = False
        elif tag == "td":
            self._in_td = True
            self._cell_text = ""
        elif tag == "a" and self._in_td:
            href = attrs_d.get("href", "")
            if "/masters-of-the-universe/" in href and href.endswith(".php"):
                self._in_link = True
                self._link_href = href
                self._link_text = ""
        elif tag in ("b", "strong"):
            self._in_bold = True
            self._bold_text = ""

    def handle_data(self, data):
        if self._in_link:
            self._link_text += data
        if self._in_bold:
            self._bold_text += data
        if self._in_td:
            self._cell_text += data

    def handle_endtag(self, tag):
        if tag == "a" and self._in_link:
            self._in_link = False
        if tag in ("b", "strong") and self._in_bold:
            self._in_bold = False
            text = self._bold_text.strip()
            # v1.3: Strip trailing "Checklist" suffix — AF411 uses headers like
            # "Movie Action Figures Checklist" which the old filter excluded entirely.
            import re as _re
            text = _re.sub(r'\s*Checklist\s*$', '', text, flags=_re.I).strip()
            # Group headers are bold text inside table header-style rows
            # They look like "Movie Action Figures" or "Origins Action Figures" etc.
            if text and len(text) > 1:
                self._in_header_row = True
                self.current_group = text
        if tag == "td":
            self._in_td = False
            self._row_cells.append(self._cell_text.strip())
        if tag == "tr" and self._in_row:
            self._in_row = False
            if not self._in_header_row and self._link_href:
                self._extract_figure()

    def _extract_figure(self):
        """Build a figure dict from the collected row data."""
        # Extract AF411 ID and slug from URL
        # e.g. /masters-of-the-universe/origins/origins-action-figures/he-man-2393.php
        match = re.search(r'/([a-z0-9-]+)-(\d+)\.php$', self._link_href)
        if not match:
            return

        name_slug = match.group(1)
        af411_id = int(match.group(2))
        slug = f"{name_slug}-{af411_id}"
        name = self._link_text.strip()

        # Parse row cells: typically [checkbox, Name, Wave, Year, Retail]
        # but the structure varies — find wave/year/retail by pattern
        wave = ""
        year = None
        retail = None

        for cell in self._row_cells:
            cell = cell.strip()
            if not cell or cell == name:
                continue
            # Year: 4-digit number
            if re.match(r'^(19|20)\d{2}$', cell):
                year = int(cell)
            # Retail: starts with $ or is a decimal number
            elif cell.startswith('$'):
                try:
                    retail = float(cell.replace('$', '').replace(',', ''))
                except ValueError:
                    pass
            # Wave: small number or text like "1", "2", "SDCC"
            elif re.match(r'^\d{1,2}[a-z]?$', cell, re.I) and not year:
                wave = cell

        self.figures.append({
            "af411_id": af411_id,
            "slug": slug,
            "name": name,
            "group": self.current_group,
            "wave": wave,
            "year": year,
            "retail": retail,
            "af411_url": self._link_href,
        })

        # Reset for next row
        self._link_href = ""
        self._link_text = ""


def fetch_page(url, retries=3, delay=2):
    """Fetch a URL with retries and polite delay."""
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={
                "User-Agent": "MOTUVault-Sync/1.0 (catalog update bot)",
                "Accept": "text/html",
            })
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read().decode("utf-8", errors="replace")
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError) as e:
            print(f"  ⚠ Attempt {attempt+1} failed for {url}: {e}")
            if attempt < retries - 1:
                time.sleep(delay * (attempt + 1))
    return None


def scrape_line(line_id, checklist_slug, series_path):
    """Scrape all figures for one line from its AF411 checklist page."""
    url = f"{BASE}{MOTU}/{checklist_slug}"
    print(f"  Fetching {line_id}: {url}")

    html = fetch_page(url)
    if not html:
        print(f"  ✗ Could not fetch {line_id}")
        return []

    parser = ChecklistParser()
    parser.feed(html)

    # Attach line_id to each figure, normalize group strings
    for fig in parser.figures:
        fig["line"] = line_id
        fig["id"] = fig["slug"]  # Use slug as the app ID
        # v1.2: normalize group names per-line (Kids Core needs this)
        fig["group"] = normalize_group(line_id, fig.get("group", ""))

    print(f"  ✓ Found {len(parser.figures)} figures in {line_id}")
    return parser.figures


def guess_faction(name, group):
    """Best-effort faction classification from name and group."""
    combined = f"{name} {group}".lower()
    for faction, keywords in FACTION_KEYWORDS.items():
        for kw in keywords:
            if kw in combined:
                return faction
    return "Other"


def download_image(slug, af411_url):
    """
    Download the figure image from AF411.
    Image URL pattern: /masters-of-the-universe/images/{slug}.jpg
    """
    # Build image URL from the figure's page URL path
    img_url = f"{BASE}{MOTU}/images/{slug}.jpg"
    dest = IMAGES_DIR / f"{slug}.jpg"

    IMAGES_DIR.mkdir(exist_ok=True)  # v1.3: create images/ if it doesn't exist yet

    if dest.exists():
        return True  # Already have it

    try:
        req = urllib.request.Request(img_url, headers={
            "User-Agent": "MOTUVault-Sync/1.0",
            "Referer": f"{BASE}{af411_url}",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = resp.read()
            if len(data) < 1000:  # Probably a 404 placeholder
                print(f"    ⚠ Image too small for {slug}, likely missing")
                return False
            dest.write_bytes(data)
            return True
    except Exception as e:
        print(f"    ⚠ Image download failed for {slug}: {e}")
        return False


# ─── v1.6: UPC enrichment ─────────────────────────────────────────
# The checklist pages the scraper normally reads do NOT carry UPCs — those
# live on each figure's individual detail page, in a line that reads like:
#   <strong>UPC</strong>: 065616000011 <strong>Series:</strong> Original ...
# So UPC capture costs one extra request PER FIGURE. To keep that cost sane,
# enrichment is opt-in (--upc) and incremental: we only fetch the detail page
# for figures that don't already have a upc, so the first run backfills and
# later runs touch only genuinely new figures.
#
# v1.6.1: the detail-page HTML wraps the label in tags (<b>/<strong>) and uses
# &nbsp; entities, so a naive "UPC...digits" regex on raw HTML never matched
# (captured 0/50 on the first live run). We now strip tags + decode entities
# into plain text first, THEN match — the same clean-text form the format was
# verified against. The "12–14 digit number near a UPC label" pattern is the
# primary; a bare 12-digit fallback is intentionally NOT used (too many false
# positives from ASINs/DPCIs/prices).
import html as _html_mod

_TAG_RE = re.compile(r'<[^>]+>')
_UPC_LABEL_RE = re.compile(r'UPC\b[^0-9]{0,12}(\d{8,14})', re.I)

def _page_to_text(raw):
    """Strip HTML tags + decode entities + collapse whitespace → plain text."""
    txt = _TAG_RE.sub(' ', raw)
    txt = _html_mod.unescape(txt)
    txt = re.sub(r'\s+', ' ', txt)
    return txt

def extract_upc(raw_html):
    """Pull a UPC out of a detail page's raw HTML. Returns the digit string or
    None. Exposed separately from fetch so it's unit-testable without network."""
    if not raw_html:
        return None
    text = _page_to_text(raw_html)
    m = _UPC_LABEL_RE.search(text)
    return m.group(1) if m else None

def fetch_upc(af411_url, debug=False):
    """Fetch a figure's detail page and extract its UPC (8–14 digits).
    Returns the UPC string, or None if the page can't be read or has none.
    When debug=True and no UPC is found, prints a snippet around the first
    'UPC' occurrence so a format change is easy to diagnose from CI logs."""
    url = af411_url if af411_url.startswith("http") else f"{BASE}{af411_url}"
    raw = fetch_page(url)
    if not raw:
        return None
    upc = extract_upc(raw)
    if upc is None and debug:
        text = _page_to_text(raw)
        i = text.lower().find('upc')
        if i >= 0:
            print(f"      [debug] context: …{text[max(0,i-20):i+40]}…")
        else:
            print(f"      [debug] no 'UPC' substring on page ({len(text)} chars of text)")
    return upc


def enrich_upcs(figs, existing_by_id, delay, limit=None):
    """Populate `upc` on the given scraped figures. Skips any figure that
    already has a upc (on the scraped record or its existing figures.json
    counterpart). Polite delay between detail-page fetches. `limit` caps how
    many detail pages we'll fetch in one run (None = no cap)."""
    need = []
    for f in figs:
        if f.get("upc"):
            continue
        prior = existing_by_id.get(f["id"])
        if prior and prior.get("upc"):
            f["upc"] = prior["upc"]   # carry forward, no fetch needed
            continue
        if f.get("af411_url"):
            need.append(f)
    if limit is not None:
        need = need[:limit]
    if not need:
        print("  ✓ UPC: nothing to fetch (all figures already have one)")
        return 0
    print(f"  🏷  UPC: fetching {len(need)} detail page(s)…")
    got = 0
    misses = 0
    for i, f in enumerate(need):
        # Print page-context for the first few misses only, so a format change
        # is visible in CI logs without flooding them.
        upc = fetch_upc(f["af411_url"], debug=(misses < 5))
        if upc:
            f["upc"] = upc
            got += 1
            print(f"    + {f['id']}: {upc}")
        else:
            print(f"    – {f['id']}: no UPC found")
            misses += 1
        if i < len(need) - 1:
            time.sleep(delay)
    print(f"  ✓ UPC: captured {got}/{len(need)}")
    return got


# ─── v1.8: accessory extraction ───────────────────────────────────
# AF411 figure pages list accessories inside the description prose, not a
# structured field — e.g. "Accessories include 2 axes, a shield, a flail…",
# "comes with… and an extra set of hands", "X is included". We already fetch
# the detail page for --upc, so accessory capture rides the same request.
# This is HEURISTIC: it emits loadouts-suggested.json for review in the
# figures editor — it does NOT touch loadouts.json directly. Validated to
# ~95% recall on a sample of real AF411 descriptions; the editor review pass
# fixes the rest (verbose names, the occasional miss).

# Canonical accessory vocabulary (state.js ACCESSORIES + the custom names
# already in loadouts.json). Extracted items normalize to these so the
# suggestions reuse existing names instead of spawning near-duplicates.
_ACC_CANON = [
    'Power Sword','Half Sword','Sword of Power','Two Swords','Laser Sword','Sword',
    'Havoc Staff','Staff','Shield','Bat Shield','Four-pronged Battle Shield',
    'Battle Axe','Tech Axe','Axe','Mace','Thunder Ball Mace','Club','Hammer','Spear',
    'Trident','Bow','Crossbow','Gun/Blaster','Rifle','Laser','Chain & Lock','Chain',
    'Spiked Ball & Chain','Whip','Nunchucks','Hook','Cape','Harness','Arm Armor',
    'Leg Armor','Armor','Helmet','Mask','Belt','Backpack','Blasterpak','Vest','Hood',
    'Hat','Crown','Collar','Claw','Power Pincer','Grabber','Wings','Wand','Mouser',
    'Pet Snake','Cosmic Key','Launching Fists','8 Missiles','Buzz Saw Blades',
    'Magic Trick Discs','Certificate of Authenticity','Minicomic','Comic',
    'Mini-figure','Stand','Info Card','Accessory Card','Instructions',
]
_ACC_LC = {c.lower(): c for c in _ACC_CANON}
_ACC_MULTI = sorted([c for c in _ACC_CANON if ' ' in c], key=lambda c: -len(c))
_ACC_ALIAS = {
    'mini comic book':'Minicomic','mini-comic':'Minicomic','mini comic':'Minicomic',
    'minicomic book':'Minicomic','comic book':'Comic','collector card':'Info Card',
    "collector's card":'Info Card','collectors card':'Info Card','collector cards':'Info Card',
    'chest armor':'Armor','shoulder armor':'Armor','skirt armor':'Armor','removable armor':'Armor',
    'jetpack':'Backpack','hands':'Hands','halter':'Halter','flail':'Flail',
}
_ACC_HI = [
    re.compile(r'accessories\s+include[s]?\s*:?\s+(.+?)(?:\.|;|$)', re.I),
    re.compile(r'as well as\s+(.+?)\s+accessor(?:y|ies)\b', re.I),
    re.compile(r'\bhas\s+(.+?)\s+accessor(?:y|ies)\b', re.I),
    re.compile(r'(.+?)\s+(?:are|is)\s+included\s+as\s+accessor(?:y|ies)(?:,?\s+along with\s+(.+?))?(?:\.|;|$)', re.I),
    re.compile(r'(.+?)\s+accessor(?:y|ies)\s+(?:are|is)\s+included', re.I),
]
_ACC_LO = [re.compile(r'\b(?:comes?|come)\s+(?:with|equipped with|packaged with)\s+(.+?)(?:\.|;|$)', re.I)]
_ACC_SING = [re.compile(r'\b([A-Z][\w\s/\'-]{2,26}?)\s+is\s+included\b')]
_ACC_POSS  = re.compile(r"^\w+['\u2019]s\s+", re.I)
_ACC_SETOF = re.compile(r'^(?:an?\s+)?(?:extra|second|additional|new|another)?\s*set of\s+', re.I)
_ACC_QTY   = re.compile(r'^\d+\s+')
_ACC_LEAD  = re.compile(r'^(?:a|an|the|his|her|its|their|two|second|extra|new|deluxe|signature|'
                        r'removable|included|alternate|metallic|soft|hard|key|movie-related|'
                        r'content-accurate|ram-headed|convenient|special|exclusive)\s+', re.I)
_ACC_STOP  = re.compile(r'\b(?:in|with|for|that|which|along|tells|story|inspired|designed|'
                        r'features?|allowing|enhancing|updated|honoring|complete|suitable)\b', re.I)
_ACC_REJECT = ('movie-related','content-accurate','story','figure','points','articulation',
               'packaging','window box','staff-holder','play','battle scene','detail')
_ACC_DESC_END = re.compile(r'\[High:|Scroll right for more|average Buy It Now|average selling price|'
                           r'was added on|Do you have additional|Point your camera|'
                           r'It can be found online|Tip:', re.I)


def _acc_clean(raw):
    s = re.sub(r'\s+', ' ', raw.strip().strip('.,;:').strip())
    m = _ACC_STOP.search(s)
    if m and m.start() > 0:
        s = s[:m.start()].strip()
    s = _ACC_POSS.sub('', s); s = _ACC_SETOF.sub('', s); s = _ACC_QTY.sub('', s)
    prev = None
    while prev != s:
        prev = s; s = _ACC_LEAD.sub('', s)
    s = re.sub(r'\s+accessor(?:y|ies)$', '', s, flags=re.I).strip().strip('.,;:').strip()
    if not s or len(s.split()) > 5:
        return None
    low = s.lower()
    if any(b in low for b in _ACC_REJECT):
        return None
    if low in _ACC_ALIAS:  return _ACC_ALIAS[low]
    if low in _ACC_LC:     return _ACC_LC[low]
    if low.endswith('es') and low[:-2] in _ACC_LC: return _ACC_LC[low[:-2]]
    if low.endswith('s')  and low[:-1] in _ACC_LC: return _ACC_LC[low[:-1]]
    for c in _ACC_MULTI:
        if low.endswith(' ' + c.lower()):
            return c
    return ' '.join(w if w.isupper() else w.capitalize() for w in s.split())


def _acc_split(clause):
    clause = re.sub(r'\s+&\s+', ', ', clause)
    clause = re.sub(r'\s+and\s+', ', ', clause, flags=re.I).replace('/', ', ')
    return [p for p in (x.strip() for x in clause.split(',')) if p]


def extract_accessories(text):
    """Heuristically pull accessory names from a figure's description prose.
    Returns a de-duped, normalized list. Unit-testable (no network)."""
    if not text:
        return []
    found, seen = [], set()
    def add(n):
        if n and n.lower() not in seen:
            seen.add(n.lower()); found.append(n)
    hit = False
    for pat in _ACC_HI:
        for m in pat.finditer(text):
            for g in m.groups():
                if g:
                    hit = True
                    for it in _acc_split(g): add(_acc_clean(it))
    if not hit:
        for pat in _ACC_LO:
            for m in pat.finditer(text):
                for it in _acc_split(m.group(1)): add(_acc_clean(it))
    for pat in _ACC_SING:
        for m in pat.finditer(text): add(_acc_clean(m.group(1)))
    return found


def extract_accessories_from_html(raw):
    """Detail-page HTML -> (accessories, source snippet). Isolates the
    description region (before the price/stats boilerplate) so nav and price
    text don't leak into the parse."""
    txt = _page_to_text(raw)
    m = _ACC_DESC_END.search(txt)
    desc = (txt[:m.start()] if m else txt[:1800]).strip()
    return extract_accessories(desc), desc[:240]


def enrich_detail_pages(figs, existing_by_id, existing_loadout_ids, delay,
                        want_upc=False, want_acc=False, acc_suggestions=None, limit=None):
    """Fetch each figure's AF411 detail page ONCE and extract the requested
    fields. Incremental: a figure is fetched only if it still needs something —
    no upc (--upc) or no loadout yet (--accessories). `acc_suggestions` is
    populated in place. Returns the count of UPCs captured."""
    if acc_suggestions is None:
        acc_suggestions = {}
    need = []
    for f in figs:
        if not f.get("af411_url"):
            continue
        needs_upc = False
        if want_upc and not f.get("upc"):
            prior = existing_by_id.get(f["id"])
            if prior and prior.get("upc"):
                f["upc"] = prior["upc"]            # carry forward, no fetch
            else:
                needs_upc = True
        needs_acc = (want_acc and f["id"] not in existing_loadout_ids
                     and f["id"] not in acc_suggestions)
        if needs_upc or needs_acc:
            need.append((f, needs_upc, needs_acc))
    if limit is not None:
        need = need[:limit]
    if not need:
        print("  ✓ detail pages: nothing to fetch")
        return 0
    print(f"  🔎 fetching {len(need)} detail page(s)…")
    upc_got = acc_got = misses = 0
    for i, (f, needs_upc, needs_acc) in enumerate(need):
        url = f["af411_url"]
        raw = fetch_page(url if url.startswith("http") else f"{BASE}{url}")
        if raw:
            if needs_upc:
                upc = extract_upc(raw)
                if upc:
                    f["upc"] = upc; upc_got += 1
                elif misses < 5:
                    misses += 1
                    print(f"    – {f['id']}: no UPC found")
            if needs_acc:
                accs, source = extract_accessories_from_html(raw)
                if accs:
                    acc_suggestions[f["id"]] = {
                        "name": f.get("name", ""), "accessories": accs, "source": source}
                    acc_got += 1
                    print(f"    + {f['id']}: {', '.join(accs)}")
        if i < len(need) - 1:
            time.sleep(delay)
    if want_upc:
        print(f"  ✓ UPC: captured {upc_got}")
    if want_acc:
        print(f"  ✓ accessories: suggested for {acc_got} figure(s) → loadouts-suggested.json")
    return upc_got


# ─── Main ─────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MOTU Vault AF411 Sync")
    parser.add_argument("--commit", action="store_true",
                        help="Actually update figures.json and download images")
    parser.add_argument("--audit", action="store_true",
                        help="Detailed comparison report only")
    parser.add_argument("--line", type=str, default=None,
                        help="Sync only this line (e.g. 'origins')")
    parser.add_argument("--delay", type=float, default=1.5,
                        help="Seconds between page fetches (be polite)")
    parser.add_argument("--no-pending", action="store_true",
                        help="v1.4: write new figures directly to figures.json "
                             "instead of routing them to the review queue.")
    parser.add_argument("--upc", action="store_true",
                        help="v1.6: also fetch each figure's detail page to capture "
                             "its UPC barcode. Incremental — skips figures that "
                             "already have a upc. Costs one request per new figure.")
    parser.add_argument("--upc-limit", type=int, default=None,
                        help="v1.6: cap how many UPC detail-pages to fetch this run "
                             "(useful for a gentle first backfill, e.g. --upc-limit 50).")
    parser.add_argument("--accessories", action="store_true",
                        help="v1.8: also parse each figure's detail-page description for "
                             "accessories and write loadouts-suggested.json for review in "
                             "the figures editor. Incremental — skips figures that already "
                             "have a loadout. Shares the detail-page fetch with --upc.")
    parser.add_argument("--acc-limit", type=int, default=None,
                        help="v1.8: cap how many detail-pages to fetch for accessory "
                             "extraction this run (gentle first backfill, e.g. --acc-limit 50).")
    args = parser.parse_args()

    print("═" * 60)
    print(f"  MOTU Vault — AF411 Catalog Sync  {SCRIPT_VERSION}")
    print("═" * 60)

    # Load existing figures.json
    existing = []
    if FIGURES_JSON.exists():
        try:
            existing = json.loads(FIGURES_JSON.read_text())
            print(f"\n📂 Loaded {len(existing)} existing figures from figures.json")
        except json.JSONDecodeError:
            print("⚠ Could not parse existing figures.json, starting fresh")

    existing_by_id = {f["id"]: f for f in existing}
    existing_ids = set(existing_by_id.keys())

    # v1.8: load existing loadouts so accessory extraction is incremental —
    # we only fetch detail pages for figures that don't already have a loadout.
    existing_loadout_ids = set()
    if LOADOUTS_JSON.exists():
        try:
            _ld = json.loads(LOADOUTS_JSON.read_text())
            if isinstance(_ld, dict) and isinstance(_ld.get("loadouts"), dict):
                existing_loadout_ids = set(_ld["loadouts"].keys())
        except json.JSONDecodeError:
            print("⚠ Could not parse loadouts.json — accessory skip-list empty")

    # v1.4: Load review queue (figures awaiting editor approval)
    pending = []
    if PENDING_JSON.exists():
        try:
            pending = json.loads(PENDING_JSON.read_text())
            print(f"📋 Loaded {len(pending)} figures already in pending queue")
        except json.JSONDecodeError:
            print("⚠ Could not parse figures-pending.json — starting fresh queue")
    pending_by_id = {f["id"]: f for f in pending}
    pending_ids = set(pending_by_id.keys())

    # v1.4: Load rejection list (slugs the editor has explicitly said no to).
    # Without this, every nightly run would re-queue rejected figures forever.
    rejected_ids = set()
    if REJECTED_JSON.exists():
        try:
            rj = json.loads(REJECTED_JSON.read_text())
            # Accept either ["slug",...] or {"rejected":["slug",...]}
            rejected_ids = set(rj if isinstance(rj, list) else rj.get("rejected", []))
            print(f"🚫 {len(rejected_ids)} figures permanently rejected (will be skipped)")
        except json.JSONDecodeError:
            print("⚠ Could not parse figures-rejected.json")

    # Scrape AF411
    print(f"\n🔍 Scraping AF411...\n")
    all_scraped = []
    lines_to_scrape = LINES
    if args.line:
        lines_to_scrape = [(lid, cs, sp) for lid, cs, sp in LINES if lid == args.line]
        if not lines_to_scrape:
            print(f"✗ Unknown line '{args.line}'. Valid: {', '.join(l[0] for l in LINES)}")
            sys.exit(1)

    for i, (line_id, checklist_slug, series_path) in enumerate(lines_to_scrape):
        figs = scrape_line(line_id, checklist_slug, series_path)
        all_scraped.extend(figs)
        if i < len(lines_to_scrape) - 1:
            time.sleep(args.delay)

    # v1.6: optional UPC enrichment. Runs against everything just scraped,
    # but only fetches detail pages for figures that still lack a upc (new
    # ones, plus a one-time backfill of existing figures missing it).
    # v1.6/v1.8: optional detail-page enrichment. A single fetch per figure
    # captures UPC (--upc) and/or accessories (--accessories); both incremental.
    acc_suggestions = {}
    if args.upc or args.accessories:
        print(f"\n🔎 Detail-page enrichment…\n")
        enrich_detail_pages(
            all_scraped, existing_by_id, existing_loadout_ids, args.delay,
            want_upc=args.upc, want_acc=args.accessories,
            acc_suggestions=acc_suggestions,
            limit=args.acc_limit if (args.accessories and not args.upc) else args.upc_limit,
        )
        if args.accessories and acc_suggestions:
            # Shape matches what the figures editor's ingestLoadouts() already
            # consumes for a suggestion bundle: a `_meta` block (which flags the
            # whole file as suggestions rather than authoritative loadouts) plus
            # top-level <figId>: [accessory, ...] arrays. The editor seeds these
            # as pre-checked "✨ suggested — confirm" chips and does NOT promote
            # them into loadouts.json until the reviewer saves.
            payload = {"_meta": {
                "version": 1,
                "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "source": f"AF411 description prose (heuristic, sync_af411.py {SCRIPT_VERSION} --accessories)",
                "note": "Review in the figures editor before committing — the parse is heuristic.",
                "perFigure": {fid: {"name": s["name"], "source": s["source"]}
                              for fid, s in acc_suggestions.items()},
            }}
            for fid, s in acc_suggestions.items():
                payload[fid] = s["accessories"]
            atomic_write_text(LOADOUTS_SUGGESTED_JSON,
                              json.dumps(payload, indent=2, ensure_ascii=False))
            print(f"\n📝 Wrote {len(acc_suggestions)} accessory suggestion(s) "
                  f"→ {LOADOUTS_SUGGESTED_JSON.name}")

    scraped_by_id = {f["id"]: f for f in all_scraped}
    scraped_ids = set(scraped_by_id.keys())

    # ── Diff ──────────────────────────────────────────────────────
    # v1.4: bucket scraped figures into 4 categories:
    #   - skipped_rejected: editor said no, ignore forever
    #   - pending_refresh: already in queue, refresh metadata
    #   - new_for_pending: brand new, route to review queue
    #   - new_for_existing: with --no-pending, new figures bypass the queue
    # Existing-figure metadata diffs (figures.json) handled separately below.
    skipped_rejected = scraped_ids & rejected_ids
    pending_refresh = scraped_ids & pending_ids
    new_candidates = scraped_ids - existing_ids - pending_ids - rejected_ids
    new_for_pending = set() if args.no_pending else new_candidates
    new_for_existing = new_candidates if args.no_pending else set()

    new_ids = new_for_existing  # legacy alias used in commit block below
    removed_ids = existing_ids - scraped_ids if not args.line else set()  # Only flag removals on full sync
    # v1.9: existing figures are NEVER modified. Once a figure is in
    # figures.json it belongs to the user. AF411 data for new figures only.
    # v1.6 exception: existing figures missing a `upc` that we just captured.
    # UPC is objective data with no override concept, so it's safe to backfill
    # (only when --upc is set, only onto records that lack one). Computed here
    # so the "Everything is in sync!" early-return below doesn't skip the write
    # when the ONLY change this run is a batch of UPCs.
    upc_pending = set()
    if args.upc:
        upc_pending = {
            fid for fid in (scraped_ids & existing_ids)
            if scraped_by_id[fid].get("upc")
            and not existing_by_id[fid].get("upc")
        }
    updated = []
    line_overrides = []
    group_overrides = []

    # ── Report ────────────────────────────────────────────────────
    print(f"\n{'═' * 60}")
    print(f"  SYNC REPORT")
    print(f"{'═' * 60}")
    print(f"  AF411 total:        {len(all_scraped)}")
    print(f"  In figures.json:    {len(existing)}")
    print(f"  In pending queue:   {len(pending)}")
    print(f"  Permanently rejected: {len(rejected_ids)}")
    print(f"  ─" * 30)
    print(f"  New → pending queue: {len(new_for_pending)}")
    if args.no_pending:
        print(f"  New → figures.json:  {len(new_for_existing)}")
    print(f"  Existing updated:    {len(updated)}")
    if args.upc:
        print(f"  UPC backfill (existing): {len(upc_pending)}")
    print(f"  Pending refreshed:   {len(pending_refresh)}")
    print(f"  Skipped (rejected):  {len(skipped_rejected)}")
    if not args.line:
        print(f"  Removed:             {len(removed_ids)}")
    print()

    new_to_show = new_for_pending or new_for_existing
    if new_to_show:
        bucket = "PENDING QUEUE" if new_for_pending else "figures.json (no-pending)"
        print(f"  ── NEW FIGURES → {bucket} ──")
        for fid in sorted(new_to_show):
            f = scraped_by_id[fid]
            print(f"    + [{f['line']}] {f['name']} (W{f['wave']}, {f['year']}) — {fid}")
        print()

    if updated and args.audit:
        print("  ── UPDATED FIELDS ──")
        for fid, changes in updated:
            print(f"    ~ {fid}: {', '.join(changes)}")
        print()

    if args.audit and group_overrides:
        print("  ── GROUP OVERRIDES (manual group != AF411 group) ──")
        for fid, local_g, af411_g in group_overrides:
            print(f"    ⊙ {fid}: group='{local_g}' (AF411 says '{af411_g}')")
        print()

    name_overrides = [
        (fid, e.get("name"), scraped_by_id[fid]["name"])
        for fid in scraped_ids & existing_ids
        for e in [existing_by_id[fid]]
        if "sourceName" in e and e.get("name") != e.get("sourceName")
    ]
    if args.audit and name_overrides:
        print("  ── NAME OVERRIDES (manual name != AF411 name) ──")
        for fid, local_n, af411_n in name_overrides:
            print(f"    ✏ {fid}: name='{local_n}' (AF411 says '{af411_n}')")
        print()

    if removed_ids and args.audit:
        print("  ── IN figures.json BUT NOT ON AF411 ──")
        print("  (These may be custom/manual additions — NOT auto-removed)")
        for fid in sorted(removed_ids):
            f = existing_by_id[fid]
            print(f"    ? [{f.get('line','')}] {f.get('name',fid)}")
        print()

    if not new_for_pending and not new_for_existing and not updated and not pending_refresh and not upc_pending:
        print("  ✓ Everything is in sync!\n")
        return

    if not args.commit:
        print("  ℹ Dry run — use --commit to apply changes\n")
        return

    # ── Apply Changes ─────────────────────────────────────────────
    print("  📝 Applying changes...\n")

    # Build new figures list: start with existing, merge updates, add new
    merged = list(existing)
    merged_by_id = {f["id"]: f for f in merged}

    def build_new_fig(s, for_pending):
        out = {
            "id": s["id"],
            "name": s["name"],
            "sourceName": s["name"],             # v1.6: track AF411's name
            "line": s["line"],
            "sourceLine": s["line"],   # v1.3: track AF411's classification
            "group": s["group"] or "",           # v1.1: ensure string, never None
            "sourceGroup": s["group"] or "",     # v1.5: track AF411's group
            "wave": s["wave"] or "",
            "year": s["year"],                   # may be None if not parsed
            "retail": s["retail"] or 0,          # v1.1: default to 0 instead of None
            "slug": s["slug"],
            "faction": guess_faction(s["name"], s["group"]),
            "source": "af411",                   # v1.1: tag every new fig as AF411-sourced
        }
        if s.get("upc"):
            out["upc"] = s["upc"]                 # v1.6: barcode for app search
        if for_pending:
            out["_addedToPending"] = int(time.time())  # editor can sort by date
        return out

    img_downloaded = 0
    img_failed = 0

    # v1.4: refresh metadata of pending entries (in case AF411 corrected
    # something). DON'T touch line/group/faction on pending entries — the
    # user may have already started editing them. Only refresh objective
    # AF411 facts: name/wave/year/retail.
    new_pending = list(pending)
    new_pending_by_id = {f["id"]: f for f in new_pending}
    for fid in pending_refresh:
        s = scraped_by_id[fid]
        p = new_pending_by_id[fid]
        if s["name"]: p["name"] = s["name"]
        if s["wave"]: p["wave"] = s["wave"]
        if s["year"]: p["year"] = s["year"]
        if s.get("upc") and not p.get("upc"): p["upc"] = s["upc"]  # v1.6: backfill barcode
        if s["retail"] is not None: p["retail"] = s["retail"]

    # v1.4: brand-new figures route to pending queue (default) or directly
    # to figures.json (--no-pending flag).
    for fid in sorted(new_for_pending):
        s = scraped_by_id[fid]
        new_pending.append(build_new_fig(s, for_pending=True))
        print(f"  📷 Downloading image: {s['slug']}")
        if download_image(s["slug"], s.get("af411_url", "")):
            img_downloaded += 1
        else:
            img_failed += 1
        time.sleep(0.5)  # Be polite

    for fid in sorted(new_for_existing):
        s = scraped_by_id[fid]
        merged.append(build_new_fig(s, for_pending=False))
        print(f"  📷 Downloading image: {s['slug']}")
        if download_image(s["slug"], s.get("af411_url", "")):
            img_downloaded += 1
        else:
            img_failed += 1
        time.sleep(0.5)

    # v1.6: UPC backfill onto EXISTING figures. The sync's core rule is that
    # existing records are never modified (v1.9) — that protects manual
    # line/group/name overrides. UPC is different: it's objective AF411 data
    # with no user-override concept, and it's the whole point of an --upc run.
    # So we make a narrow exception: write ONLY the `upc` field, ONLY onto
    # existing figures that don't already have one. An existing upc is never
    # overwritten, so a hand-corrected barcode survives future syncs.
    upc_backfilled = 0
    if args.upc:
        for fid in scraped_ids & existing_ids:
            s = scraped_by_id[fid]
            new_upc = s.get("upc")
            if not new_upc:
                continue
            tgt = merged_by_id.get(fid)
            if tgt is not None and not tgt.get("upc"):
                tgt["upc"] = new_upc
                upc_backfilled += 1
        if upc_backfilled:
            print(f"  🏷  UPC: backfilled {upc_backfilled} existing figure(s)")
        else:
            print(f"  🏷  UPC: no existing figures needed a backfill")

    # Sort by line then name for clean diffs
    line_order = {l[0]: i for i, l in enumerate(LINES)}
    merged.sort(key=lambda f: (line_order.get(f.get("line", ""), 99), f.get("name", "")))

    # Write figures.json (AUDIT FIX v1.7: atomic — temp file + os.replace)
    atomic_write_text(FIGURES_JSON, json.dumps(merged, indent=2, ensure_ascii=False))
    print(f"\n  ✓ Wrote {len(merged)} figures to figures.json")

    # v1.4: write pending queue (only if it changed). When no new figures
    # were added and no pending entries were refreshed, skip the write to
    # avoid spurious git churn.
    if new_for_pending or pending_refresh:
        new_pending.sort(key=lambda f: (line_order.get(f.get("line", ""), 99), f.get("name", "")))
        atomic_write_text(PENDING_JSON, json.dumps(new_pending, indent=2, ensure_ascii=False))
        print(f"  ✓ Wrote {len(new_pending)} figures to figures-pending.json")

    print(f"  ✓ Downloaded {img_downloaded} images ({img_failed} failed)")
    if new_for_pending:
        print(f"\n  ▸ Open figures-editor.html to review {len(new_for_pending)} new figure(s)")
    print(f"{'═' * 60}\n")

    # v1.5: write a sync summary for the GitHub Actions workflow to read.
    # Used to post a Discord notification when new pending figures land.
    # Path is fixed and machine-readable; never committed (in .gitignore /
    # ignored by glob below). Only written on a real (--commit) run; audit
    # runs skip this entirely.
    if args.commit:
        try:
            summary_path = Path("/tmp/motu-sync-summary.json")
            new_pending_details = []
            for fid in sorted(new_for_pending):
                s = scraped_by_id[fid]
                new_pending_details.append({
                    "id": fid,
                    "name": s.get("name") or fid,
                    "line": s.get("line") or "",
                })
            summary_path.write_text(json.dumps({
                "new_pending_count": len(new_for_pending),
                "new_pending":       new_pending_details,
                "pending_total":     len(new_pending),
                "figures_total":     len(merged),
                "images_downloaded": img_downloaded,
                "images_failed":     img_failed,
                "line_filter":       args.line or "",
            }, indent=2, ensure_ascii=False))
        except Exception as e:
            # Never let summary-write failure break the sync — print and move on.
            print(f"  ⚠ Could not write sync summary: {e}")


if __name__ == "__main__":
    main()
