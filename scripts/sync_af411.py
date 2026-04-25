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

BASE = "https://www.actionfigure411.com"
MOTU = "/masters-of-the-universe"

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
]

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
IMAGES_DIR = REPO_ROOT  # images sit at repo root as {slug}.jpg

# v1.1: fields that the scraper KNOWS about. Anything else on an existing entry
# (overrides, app-specific flags, manual annotations) is preserved verbatim
# during merge. Keep this list narrow to be data-loss-safe.
SCRAPER_FIELDS = {"name", "line", "group", "wave", "year", "retail", "slug"}

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
            # Group headers are bold text inside table header-style rows
            # They look like "Origins Action Figures" or "Deluxe" etc.
            if text and "Checklist" not in text and len(text) > 1:
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

    # Attach line_id to each figure
    for fig in parser.figures:
        fig["line"] = line_id
        fig["id"] = fig["slug"]  # Use slug as the app ID

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
    args = parser.parse_args()

    print("═" * 60)
    print("  MOTU Vault — AF411 Catalog Sync")
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

    scraped_by_id = {f["id"]: f for f in all_scraped}
    scraped_ids = set(scraped_by_id.keys())

    # ── Diff ──────────────────────────────────────────────────────
    new_ids = scraped_ids - existing_ids
    removed_ids = existing_ids - scraped_ids if not args.line else set()  # Only flag removals on full sync
    updated = []

    # Check for data changes in existing figures
    for fid in scraped_ids & existing_ids:
        s = scraped_by_id[fid]
        e = existing_by_id[fid]
        changes = []
        if s["name"] != e.get("name"):
            changes.append(f"name: '{e.get('name')}' → '{s['name']}'")
        if s["wave"] and s["wave"] != e.get("wave", ""):
            changes.append(f"wave: '{e.get('wave','')}' → '{s['wave']}'")
        if s["year"] and s["year"] != e.get("year"):
            changes.append(f"year: {e.get('year')} → {s['year']}")
        if s["retail"] and s["retail"] != e.get("retail"):
            changes.append(f"retail: {e.get('retail')} → {s['retail']}")
        # v1.1: detect when scraped group differs from existing — used to be
        # silently overwritten.
        if s["group"] and s["group"] != e.get("group", ""):
            changes.append(f"group: '{e.get('group','')}' → '{s['group']}'")
        # v1.1: flag entries missing source (we'll fix on commit)
        if not e.get("source"):
            changes.append("source: missing → 'af411'")
        if changes:
            updated.append((fid, changes))

    # ── Report ────────────────────────────────────────────────────
    print(f"\n{'═' * 60}")
    print(f"  SYNC REPORT")
    print(f"{'═' * 60}")
    print(f"  AF411 total:   {len(all_scraped)}")
    print(f"  Existing:      {len(existing)}")
    print(f"  New figures:   {len(new_ids)}")
    print(f"  Updated:       {len(updated)}")
    if not args.line:
        print(f"  Removed:       {len(removed_ids)}")
    print()

    if new_ids:
        print("  ── NEW FIGURES ──")
        for fid in sorted(new_ids):
            f = scraped_by_id[fid]
            print(f"    + [{f['line']}] {f['name']} (W{f['wave']}, {f['year']}) — {fid}")
        print()

    if updated and args.audit:
        print("  ── UPDATED FIELDS ──")
        for fid, changes in updated:
            print(f"    ~ {fid}: {', '.join(changes)}")
        print()

    if removed_ids and args.audit:
        print("  ── IN figures.json BUT NOT ON AF411 ──")
        print("  (These may be custom/manual additions — NOT auto-removed)")
        for fid in sorted(removed_ids):
            f = existing_by_id[fid]
            print(f"    ? [{f.get('line','')}] {f.get('name',fid)}")
        print()

    if not new_ids and not updated:
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

    # Update existing figures with new data.
    # v1.1: source='af411' is now ALWAYS set on AF411-sourced entries — this
    # backfills the ~10 figures that were imported before source-tagging existed.
    for fid, _ in updated:
        s = scraped_by_id[fid]
        e = merged_by_id[fid]
        if s["name"]:
            e["name"] = s["name"]
        if s["wave"]:
            e["wave"] = s["wave"]
        if s["year"]:
            e["year"] = s["year"]
        if s["retail"]:
            e["retail"] = s["retail"]
        if s["group"]:
            e["group"] = s["group"]
        # Always tag source — these entries DEFINITELY came from AF411 since
        # we matched them by ID. Backfills missing source on legacy entries.
        e["source"] = "af411"

    # Add new figures
    img_downloaded = 0
    img_failed = 0
    for fid in sorted(new_ids):
        s = scraped_by_id[fid]
        new_fig = {
            "id": s["id"],
            "name": s["name"],
            "line": s["line"],
            "group": s["group"] or "",          # v1.1: ensure string, never None
            "wave": s["wave"] or "",
            "year": s["year"],                  # may be None if not parsed
            "retail": s["retail"] or 0,         # v1.1: default to 0 instead of None
            "slug": s["slug"],
            "faction": guess_faction(s["name"], s["group"]),
            "source": "af411",                  # v1.1: tag every new fig as AF411-sourced
        }
        merged.append(new_fig)

        # Download image
        print(f"  📷 Downloading image: {s['slug']}")
        if download_image(s["slug"], s.get("af411_url", "")):
            img_downloaded += 1
        else:
            img_failed += 1
        time.sleep(0.5)  # Be polite

    # Sort by line then name for clean diffs
    line_order = {l[0]: i for i, l in enumerate(LINES)}
    merged.sort(key=lambda f: (line_order.get(f.get("line", ""), 99), f.get("name", "")))

    # Write figures.json
    FIGURES_JSON.write_text(json.dumps(merged, indent=2, ensure_ascii=False))
    print(f"\n  ✓ Wrote {len(merged)} figures to figures.json")
    print(f"  ✓ Downloaded {img_downloaded} images ({img_failed} failed)")
    print(f"{'═' * 60}\n")


if __name__ == "__main__":
    main()
