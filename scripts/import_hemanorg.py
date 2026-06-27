#!/usr/bin/env python3
"""Import per-figure accessories from he-man.org → loadouts-suggested.json.

he-man.org (the Org) gives one clean page per figure with a consistent shape:

    Faction: Evil Warriors
    Beast Man was closely based on the original vintage figure ...
    He came with removable chest and arm armor, and a vintage style string whip.

We discover figure URLs from the WordPress sitemap, fetch each page, confirm
it's a figure page (it has a "Faction:" line — comics/articles don't), parse the
"came with / included" accessory sentence, normalise to the app's accessory
vocabulary, and match to figures.json by normalised name + line + year. The
result is written to loadouts-suggested.json for review in the figures editor.

This NEVER writes loadouts.json — the editor review promotes confirmed chips.
Matching is deliberately CONSERVATIVE: a suggestion is emitted only on an
unambiguous name+line+year match; anything ambiguous is skipped (and logged),
because a wrong match is worse than a miss. Everything is reviewed before commit.

Usage:
  python scripts/import_hemanorg.py                 # full run, writes suggestions
  python scripts/import_hemanorg.py --limit 50      # gentle batch (first N figure pages)
  python scripts/import_hemanorg.py --offset 50 --limit 50   # next batch
  python scripts/import_hemanorg.py --line origins  # only figures whose he-man.org line maps to 'origins'
  python scripts/import_hemanorg.py --dry-run -v    # parse + match, print, don't write
"""
import argparse
import json
import os
import re
import sys
import time
import html as _html
import urllib.request
import urllib.error
from pathlib import Path

SCRIPT_VERSION = "v1.0"

REPO_ROOT = Path(__file__).resolve().parent.parent
FIGURES_JSON = REPO_ROOT / "figures.json"
LOADOUTS_JSON = REPO_ROOT / "loadouts.json"
LOADOUTS_SUGGESTED_JSON = REPO_ROOT / "loadouts-suggested.json"

BASE = "https://www.he-man.org"
SITEMAP_CANDIDATES = ["/wp-sitemap.xml", "/sitemap.xml", "/sitemap_index.xml"]
UA = {"User-Agent": "MOTU-Vault-accessory-import/1.0 (+https://github.com/shkankin/motu-images)"}

# ── he-man.org section → app line id ──────────────────────────────────
# Keyed on substrings found in the figure-page URL (or title). Used to
# disambiguate the many same-named figures across lines. Unknown → no hint
# (matcher then needs a name+year hit that's unique catalog-wide).
LINE_FROM_URL = [
    ("motu-origins", "origins"),
    ("masterverse", "masterverse"),
    ("mondo", "mondo"),
    ("masters-of-the-universe-classics", "classics"),
    ("motu-classics", "classics"),
    ("200x", "200x"),
    ("new-adventures", "new-adventures"),
    ("super7", "super7"),
    ("chronicles", "chronicles"),
]
# Vintage figure pages are top-level slugs with a 1982–1988 year and no line
# prefix; they map to 'original'. Detected separately (by year) below.
VINTAGE_YEARS = set(range(1982, 1989))

# Line-name prefixes that appear at the FRONT of a he-man.org page title, e.g.
# "MOTU Origins Beast Man (2020)" → strip "MOTU Origins " to get "Beast Man".
TITLE_LINE_PREFIXES = [
    "MOTU Origins", "Masterverse", "Mondo", "MOTU Classics", "MOTU 200x", "200x",
    "New Adventures", "Super7", "MOTU Chronicles", "Vintage", "Mega Construx",
    "MOTU", "Masters of the Universe",
]

# ═══ Accessory normalisation (shared vocab with the app + figures editor) ═══
_ACC_CANON = [
    'Power Sword', 'Half Sword', 'Sword of Power', 'Two Swords', 'Laser Sword', 'Sword',
    'Havoc Staff', 'Snake Staff', 'Staff', 'Shield', 'Bat Shield', 'Four-pronged Battle Shield',
    'Battle Axe', 'Tech Axe', 'Axe', 'Mace', 'Thunder Ball Mace', 'Club', 'Hammer', 'Spear',
    'Trident', 'Bow', 'Crossbow', 'Gun/Blaster', 'Rifle', 'Laser', 'Chain & Lock', 'Chain',
    'Spiked Ball & Chain', 'Whip', 'Nunchucks', 'Hook', 'Cape', 'Harness', 'Baldric', 'Arm Armor',
    'Leg Armor', 'Armor', 'Helmet', 'Mask', 'Belt', 'Backpack', 'Blasterpak', 'Vest', 'Hood',
    'Hat', 'Crown', 'Collar', 'Claw', 'Power Pincer', 'Grabber', 'Wings', 'Wand', 'Mouser',
    'Pet Snake', 'Cosmic Key', 'Launching Fists', '8 Missiles', 'Buzz Saw Blades',
    'Magic Trick Discs', 'Certificate of Authenticity', 'Minicomic', 'Comic',
    'Mini-figure', 'Stand', 'Info Card', 'Accessory Card', 'Instructions',
]
_ACC_LC = {c.lower(): c for c in _ACC_CANON}
_ACC_MULTI = sorted([c for c in _ACC_CANON if ' ' in c], key=lambda c: -len(c))
_ACC_ALIAS = {
    'mini comic': 'Minicomic', 'mini-comic': 'Minicomic', 'mini comic book': 'Minicomic',
    'comic book': 'Comic', 'chest armor': 'Armor', 'shoulder armor': 'Armor', 'skirt armor': 'Armor',
    'chest armour': 'Armor', 'arm armour': 'Arm Armor', 'leg armour': 'Leg Armor',
    'removable armor': 'Armor', 'removable armour': 'Armor', 'jetpack': 'Backpack',
    'string whip': 'Whip', 'power sword half': 'Half Sword',
}
_ACC_POSS = re.compile(r"^\w+['\u2019]s\s+", re.I)
_ACC_SETOF = re.compile(r'^(?:an?\s+)?(?:extra|second|additional|new|another)?\s*set of\s+', re.I)
_ACC_QTY = re.compile(r'^\d+\s+')
_ACC_LEAD = re.compile(r'^(?:a|an|the|his|her|its|their|two|second|extra|new|deluxe|signature|'
                       r'removable|included|alternate|metallic|soft|hard|key|vintage|style|'
                       r'grey|gray|gold|golden|silver|red|blue|green|black|white|yellow|'
                       r'colored|coloured|design|mustard|brand|brand-new|same|matching|'
                       r'large|small|original|standard|reissued?|classic)\s+', re.I)
_ACC_STOP = re.compile(r'\b(?:in|with|for|that|which|along|tells|story|inspired|designed|'
                       r'features?|allowing|enhancing|together|reminiscent|evoking|befitting)\b', re.I)
_ACC_REJECT = ('action feature', 'points of', 'articulation', 'variety', 'version',
               'figure', 'character', 'mechanism', 'feature')
# distributed noun: "chest and arm armor" → "chest armor, arm armor"
_ACC_DISTRIB = re.compile(r'(\w+)\s+and\s+(\w+)\s+(armor|armour|wings|hands|guns?|rifles?)\b', re.I)


def _acc_clean(raw):
    s = re.sub(r'\s+', ' ', raw.strip().strip('.,;:').strip())
    m = _ACC_STOP.search(s)
    if m and m.start() > 0:
        s = s[:m.start()].strip()
    s = _ACC_POSS.sub('', s)
    s = _ACC_SETOF.sub('', s)
    s = _ACC_QTY.sub('', s)
    prev = None
    while prev != s:
        prev = s
        s = _ACC_LEAD.sub('', s)
    s = re.sub(r'\s+accessor(?:y|ies)$', '', s, flags=re.I).strip().strip('.,;:').strip()
    if not s or len(s.split()) > 5:
        return None
    low = s.lower()
    if any(b in low for b in _ACC_REJECT):
        return None
    if low in _ACC_ALIAS:
        return _ACC_ALIAS[low]
    if low in _ACC_LC:
        return _ACC_LC[low]
    if low.endswith('es') and low[:-2] in _ACC_LC:
        return _ACC_LC[low[:-2]]
    if low.endswith('s') and low[:-1] in _ACC_LC:
        return _ACC_LC[low[:-1]]
    for c in _ACC_MULTI:
        if low.endswith(' ' + c.lower()):
            return c
    return ' '.join(w if w.isupper() else w.capitalize() for w in s.split())


def accessories_from_clause(clause):
    """Split a 'came with X, Y, and Z' clause into normalised accessory names."""
    clause = _ACC_DISTRIB.sub(r'\1 \3, \2 \3', clause)         # chest and arm armor → chest armor, arm armor
    clause = re.sub(r'\b(?:together with|along with|as well as|in addition to|plus)\b', ', ', clause, flags=re.I)
    clause = re.sub(r'\s+&\s+', ', ', clause)
    clause = re.sub(r'\s+and\s+', ', ', clause, flags=re.I).replace('/', ', ')
    out, seen = [], set()
    for part in clause.split(','):
        part = part.strip()
        if not part:
            continue
        c = _acc_clean(part)
        if c and c.lower() not in seen:
            seen.add(c.lower())
            out.append(c)
    return out


# ═══ he-man.org fetch + parse ═══
def fetch(url, timeout=25):
    try:
        req = urllib.request.Request(url, headers=UA)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")
    except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
        return None


def discover_figure_urls():
    """Collect candidate page URLs from the WordPress sitemap (index → subs)."""
    for cand in SITEMAP_CANDIDATES:
        xml = fetch(BASE + cand)
        if not xml:
            continue
        locs = re.findall(r'<loc>\s*([^<]+?)\s*</loc>', xml)
        if not locs:
            continue
        subs = [u for u in locs if u.lower().endswith('.xml')]
        urls = []
        if subs:
            for s in subs:
                sx = fetch(s)
                if sx:
                    urls += re.findall(r'<loc>\s*([^<]+?)\s*</loc>', sx)
                time.sleep(0.3)
        else:
            urls = locs
        seen, out = set(), []
        for u in urls:
            u = u.strip()
            if u.startswith(BASE) and not u.lower().endswith('.xml') and u not in seen:
                seen.add(u)
                out.append(u)
        if out:
            print(f"  sitemap {cand}: {len(out)} page URLs")
            return out
    print("  ⚠ no sitemap found — provide URLs another way")
    return []


_TAG = re.compile(r'<[^>]+>')
_CAME = re.compile(r'\b(?:came|comes?)\s+(?:with|packaged with|equipped with|bundled with)\s+(.+?)(?:\.|;|$)', re.I)
_INCL = re.compile(r'\b(?:[Hh]e|[Ss]he|[Ii]t|[Tt]he figure|figure)\s+(?:also\s+)?included\s+(.+?)(?:\.|;|$)', re.I)
_TITLE = re.compile(r'<title>\s*(.+?)\s*</title>', re.I | re.S)
_YEAR_SLUG = re.compile(r'-(\d{4})/?$')


def _page_text(raw):
    t = _TAG.sub(' ', raw)
    t = _html.unescape(t)
    return re.sub(r'\s+', ' ', t).strip()


def _norm_name(name):
    """Normalise a figure name for matching: drop trailing (year), strip a
    leading line-label, lowercase, keep alphanumerics only."""
    name = re.sub(r'\s*\(\s*\d{4}\s*\)\s*$', '', name).strip()          # drop "(2020)"
    for pre in TITLE_LINE_PREFIXES:
        if name.lower().startswith(pre.lower() + ' '):
            name = name[len(pre):].strip()
            break
    return re.sub(r'[^a-z0-9]+', '', name.lower())


def _line_hint(url):
    low = url.lower()
    for frag, lid in LINE_FROM_URL:
        if frag in low:
            return lid
    return None


def parse_figure(raw, url):
    """Return a dict if `raw` is a he-man.org figure page with accessories, else None."""
    txt = _page_text(raw)
    if 'Faction' not in txt:                  # figure pages carry a Faction line
        return None
    mt = _TITLE.search(raw)
    title = _html.unescape(mt.group(1)).strip() if mt else ''
    title = re.sub(r'\s*[–-]\s*HE-?MAN\.ORG\s*$', '', title, flags=re.I).strip()
    if not title:
        return None
    # year: from "(YYYY)" in title, else trailing -YYYY in slug
    my = re.search(r'\((\d{4})\)', title) or _YEAR_SLUG.search(url)
    year = int(my.group(1)) if my else None
    # accessories
    m = _CAME.search(txt) or _INCL.search(txt)
    accs = accessories_from_clause(m.group(1)) if m else []
    line_hint = _line_hint(url)
    if line_hint is None and year in VINTAGE_YEARS:
        line_hint = 'original'
    return {
        "url": url, "title": title, "name_key": _norm_name(title),
        "year": year, "line_hint": line_hint, "accessories": accs,
    }


# ═══ matching ═══
def build_index(figs):
    """Index user figures for matching: (name_key, line, year) and (name_key)."""
    by_full = {}        # (name_key, line, year) -> [ids]
    by_nameline = {}    # (name_key, line) -> [ids]
    by_name = {}        # name_key -> [ids]
    for f in figs:
        nk = re.sub(r'[^a-z0-9]+', '', f.get('name', '').lower())
        ln = f.get('line')
        yr = f.get('year')
        by_full.setdefault((nk, ln, yr), []).append(f['id'])
        by_nameline.setdefault((nk, ln), []).append(f['id'])
        by_name.setdefault(nk, []).append(f['id'])
    return by_full, by_nameline, by_name


def match_id(fig, idx):
    """Conservatively map a he-man.org figure to a single figures.json id, or None."""
    by_full, by_nameline, by_name = idx
    nk, ln, yr = fig["name_key"], fig["line_hint"], fig["year"]
    if not nk:
        return None
    # 1. exact name + line + year
    if ln and yr and len(by_full.get((nk, ln, yr), [])) == 1:
        return by_full[(nk, ln, yr)][0]
    # 2. name + line, unique (year may differ slightly between sources)
    if ln and len(by_nameline.get((nk, ln), [])) == 1:
        return by_nameline[(nk, ln)][0]
    # 3. name + line + year±1
    if ln and yr:
        near = []
        for y in (yr - 1, yr + 1):
            near += by_full.get((nk, ln, y), [])
        if len(near) == 1:
            return near[0]
    # 4. no line hint but the name is unique catalog-wide
    if not ln and len(by_name.get(nk, [])) == 1:
        return by_name[nk][0]
    return None


def main():
    ap = argparse.ArgumentParser(description="Import accessories from he-man.org")
    ap.add_argument("--limit", type=int, default=None, help="Cap figure pages fetched this run")
    ap.add_argument("--offset", type=int, default=0, help="Skip the first N candidate URLs (batching)")
    ap.add_argument("--line", type=str, default=None, help="Only emit for this app line id (e.g. origins)")
    ap.add_argument("--delay", type=float, default=1.0, help="Seconds between page fetches (be polite)")
    ap.add_argument("--dry-run", action="store_true", help="Parse + match, print, do not write")
    ap.add_argument("-v", "--verbose", action="store_true", help="Log matches, skips, and misses")
    args = ap.parse_args()

    print("=" * 60)
    print(f"  MOTU Vault — he-man.org accessory import  {SCRIPT_VERSION}")
    print("=" * 60)

    figs = json.loads(FIGURES_JSON.read_text())
    print(f"\n📂 {len(figs)} figures in figures.json")
    idx = build_index(figs)
    id_to_line = {f["id"]: f.get("line") for f in figs}

    existing_loadouts = set()
    if LOADOUTS_JSON.exists():
        try:
            ld = json.loads(LOADOUTS_JSON.read_text())
            if isinstance(ld, dict) and isinstance(ld.get("loadouts"), dict):
                existing_loadouts = set(ld["loadouts"].keys())
        except json.JSONDecodeError:
            pass

    print("\n🔍 Discovering figure URLs from he-man.org sitemap…")
    urls = discover_figure_urls()
    if not urls:
        sys.exit(1)
    urls = urls[args.offset:]
    if args.limit is not None:
        urls = urls[:args.limit]
    print(f"  processing {len(urls)} candidate page(s)…\n")

    suggestions = {}
    stats = {"figure_pages": 0, "with_acc": 0, "matched": 0, "skipped_ambig": 0,
             "already": 0, "no_acc": 0, "not_figure": 0}
    for i, url in enumerate(urls):
        raw = fetch(url)
        if raw is None:
            continue
        fig = parse_figure(raw, url)
        if fig is None:
            stats["not_figure"] += 1
        else:
            stats["figure_pages"] += 1
            if not fig["accessories"]:
                stats["no_acc"] += 1
                if args.verbose:
                    print(f"  · {fig['title']}: figure page, no accessory sentence")
            else:
                stats["with_acc"] += 1
                fid = match_id(fig, idx)
                if fid is None:
                    stats["skipped_ambig"] += 1
                    if args.verbose:
                        print(f"  ? {fig['title']} [{fig['line_hint']}/{fig['year']}]: "
                              f"no confident match — {fig['accessories']}")
                elif args.line and id_to_line.get(fid) != args.line:
                    pass  # filtered out by --line (not counted)
                elif fid in existing_loadouts:
                    stats["already"] += 1
                    if args.verbose:
                        print(f"  = {fid}: already has a confirmed loadout — skipping")
                else:
                    stats["matched"] += 1
                    suggestions[fid] = {
                        "name": fig["title"], "accessories": fig["accessories"],
                        "source": f"{fig['url']} — \"{fig['title']}\"",
                    }
                    if args.verbose:
                        print(f"  + {fid} ← {fig['title']}: {', '.join(fig['accessories'])}")
        if i < len(urls) - 1:
            time.sleep(args.delay)

    print("\n" + "─" * 60)
    print(f"  candidate pages:     {len(urls)}")
    print(f"  figure pages:        {stats['figure_pages']}  (non-figure: {stats['not_figure']})")
    print(f"  with accessories:    {stats['with_acc']}  (figure page but no list: {stats['no_acc']})")
    print(f"  ✓ matched + new:     {stats['matched']}")
    print(f"  = already had loadout: {stats['already']}")
    print(f"  ? skipped (ambiguous): {stats['skipped_ambig']}")
    print("─" * 60)

    if not suggestions:
        print("\nNo new suggestions to write.")
        return
    if args.dry_run:
        print(f"\n[dry-run] would write {len(suggestions)} suggestion(s) — not writing.")
        return

    # Shape matches what the figures editor's ingestLoadouts() consumes: a
    # `_meta` block (flags the file as suggestions) + top-level figId: [accs].
    payload = {"_meta": {
        "version": 1,
        "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source": f"he-man.org (import_hemanorg.py {SCRIPT_VERSION})",
        "note": "Accessory suggestions parsed from he-man.org. Review in the figures "
                "editor before committing; names may be verbose and matching is heuristic.",
        "perFigure": {fid: {"name": s["name"], "source": s["source"]}
                      for fid, s in suggestions.items()},
    }}
    for fid, s in suggestions.items():
        payload[fid] = s["accessories"]

    tmp = LOADOUTS_SUGGESTED_JSON.with_name(LOADOUTS_SUGGESTED_JSON.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, ensure_ascii=False)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, LOADOUTS_SUGGESTED_JSON)
    print(f"\n📝 Wrote {len(suggestions)} suggestion(s) → {LOADOUTS_SUGGESTED_JSON.name}")


if __name__ == "__main__":
    main()
