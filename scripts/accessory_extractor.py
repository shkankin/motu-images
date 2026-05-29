#!/usr/bin/env python3
"""
MOTU Vault — Accessory Extractor
────────────────────────────────────────────────────────────────────
Reads an AF411 figure-detail description (free prose) and returns a
suggested loadout: a list of accessory names drawn from the app's
canonical vocabulary (state.js ACCESSORIES) plus the custom accessories
already present in loadouts.json.

Design goals
  • Correctness over recall for AUTO-suggestions. A wrong chip the user
    has to un-tick is more annoying than a missing chip they tick once.
    So we only emit terms we can map confidently, and surface the rest
    as `unmatched` for human review in figures-editor.html.
  • Span-consumption matching. "Power Sword, Sword and harness" must yield
    ['Power Sword', 'Sword', 'Harness'] — i.e. a longer alias (Power Sword)
    consumes its own characters so the inner 'Sword' isn't double-counted,
    while a SEPARATE later 'Sword' still matches. Greedy longest-first over
    spans gives exactly this.
  • Vocabulary-locked output. Every emitted name exists in
    canonical ∪ custom, so the editor recognizes it and the app's
    getLoadout()/completeness logic works unchanged.

Public API
  extract_accessories(description, vocab=None) -> ExtractResult
    .accessories : list[str]   canonical/custom names, first-seen order
    .confidence  : 'high'|'medium'|'low'
    .unmatched   : list[str]   phrases that looked accessory-ish but
                               didn't map — shown to the human reviewer
"""

from __future__ import annotations
import re
from dataclasses import dataclass, field

# ── Canonical vocabulary (MUST mirror state.js ACCESSORIES) ──────────
CANONICAL = [
    'Sword', 'Power Sword', 'Half Sword', 'Shield', 'Axe', 'Mace', 'Club',
    'Hammer', 'Staff', 'Spear', 'Trident', 'Bow', 'Crossbow', 'Gun/Blaster',
    'Chain', 'Chain & Lock', 'Whip', 'Nunchucks', 'Hook',
    'Cape', 'Harness', 'Armor', 'Helmet', 'Mask', 'Belt',
    'Backpack', 'Comic', 'Minicomic', 'Mini-figure',
    'Stand', 'Info Card', 'Accessory Card', 'Instructions', 'Other',
]

# Paper goods that don't block "complete" (mirror OPTIONAL_ACCESSORIES).
PAPER_GOODS = {'Comic', 'Minicomic', 'Info Card', 'Accessory Card', 'Instructions'}

# ── Alias map: phrase (lowercase) -> canonical/custom name ───────────
# Order is irrelevant here (matching sorts by length); just be exhaustive.
# Multi-word and more-specific phrases naturally win via longest-span-first.
ALIASES: dict[str, str] = {
    # swords
    'power sword': 'Power Sword',
    'sword of power': 'Sword of Power',     # custom — exact verbatim only
    'half power sword': 'Half Sword',
    'half sword': 'Half Sword',
    'half-sword': 'Half Sword',
    'laser sword': 'Laser Sword',           # custom
    'sword': 'Sword',
    # axes (generic "battle axe" -> canonical Axe; specific customs verbatim)
    'tech axe': 'Tech Axe',                 # custom
    'battle axe': 'Axe',
    'battle-axe': 'Axe',
    'battleaxe': 'Axe',
    'axe': 'Axe',
    # shields
    'four-pronged battle shield': 'Four-pronged Battle Shield',  # custom
    'bat shield': 'Bat Shield',             # custom
    'shield': 'Shield',
    # blunt / staff
    'thunder ball mace': 'Thunder Ball Mace',  # custom
    'mace': 'Mace',
    'club': 'Club',
    'hammer': 'Hammer',
    'havoc staff': 'Havoc Staff',           # custom
    'staff': 'Staff',
    'wand': 'Wand',                         # custom
    # polearms / projectiles
    'spear': 'Spear',
    'trident': 'Trident',
    'crossbow': 'Crossbow',
    'bow': 'Bow',
    'laser blaster': 'Gun/Blaster',
    'blaster': 'Gun/Blaster',
    'blaster pistol': 'Gun/Blaster',
    'pistol': 'Gun/Blaster',
    'gun': 'Gun/Blaster',
    'rifle': 'Rifle',                       # custom
    'laser': 'Laser',                       # custom (bare 'laser' only; longer win first)
    # flexible / misc weapons
    'spiked ball & chain': 'Spiked Ball & Chain',  # custom
    'spiked ball and chain': 'Spiked Ball & Chain',
    'chain & lock': 'Chain & Lock',
    'chain and lock': 'Chain & Lock',
    'chain': 'Chain',
    'whip': 'Whip',
    'nunchucks': 'Nunchucks',
    'nunchuck': 'Nunchucks',
    'nunchaku': 'Nunchucks',
    'hook': 'Hook',
    'claw': 'Claw',                         # custom
    'power pincer': 'Power Pincer',         # custom
    'grabber': 'Grabber',                   # custom
    'launching fists': 'Launching Fists',   # custom
    'buzz saw blades': 'Buzz Saw Blades',   # custom
    # wearables / armor
    'arm armor': 'Arm Armor',               # custom (win before 'armor')
    'leg armor': 'Leg Armor',               # custom
    'battle armor': 'Armor',
    'removable armor': 'Armor',
    'armor': 'Armor',
    'armour': 'Armor',
    'harness': 'Harness',
    'helmet': 'Helmet',
    'mask': 'Mask',
    'belt': 'Belt',
    'cape': 'Cape',
    'cloak': 'Cape',
    'hood': 'Hood',                         # custom
    'hat': 'Hat',                           # custom
    'vest': 'Vest',                         # custom
    'collar': 'Collar',                     # custom
    'crown': 'Crown',                       # custom
    'backpack': 'Backpack',
    'back pack': 'Backpack',
    'blasterpak': 'Blasterpak',             # custom
    # creature / companion / keys
    'pet snake': 'Pet Snake',               # custom
    'mouser': 'Mouser',                     # custom
    'cosmic key': 'Cosmic Key',             # custom
    'wings': 'Wings',                       # custom
    'wing': 'Wings',
    # paper goods
    'mini-comic': 'Minicomic',
    'mini comic': 'Minicomic',
    'minicomic': 'Minicomic',
    'comic book': 'Comic',
    'comic': 'Comic',
    'mini-figure': 'Mini-figure',
    'mini figure': 'Mini-figure',
    'minifigure': 'Mini-figure',
    'information card': 'Info Card',
    'info card': 'Info Card',
    'character card': 'Info Card',
    'accessory card': 'Accessory Card',
    'instruction sheet': 'Instructions',
    'instructions': 'Instructions',
    'certificate of authenticity': 'Certificate of Authenticity',  # custom
    'certificate': 'Certificate of Authenticity',
    # display
    'display stand': 'Stand',
    'display base': 'Stand',
    'figure stand': 'Stand',
    'stand': 'Stand',
}

# ── Noise: phrases that look accessory-ish but are NOT loadout pieces ─
# These are dropped from the `unmatched` reviewer list so it stays signal.
NOISE = {
    'head', 'heads', 'alternate head', 'extra head', 'swappable head',
    'second head', 'vintage-style head', 'vintage style head',
    'hand', 'hands', 'alternate hand', 'alternate hands', 'extra hands',
    'gripping hands', 'open hands', 'fist', 'fists',
    'articulation', 'points of articulation', 'joints', 'joint',
    'figure', 'action figure', 'sticker', 'stickers', 'sheet of stickers',
    'face', 'faces', 'expression', 'expressions', 'portrait',
    'base', 'play mat', 'mat', 'box', 'card', 'cardback', 'packaging',
}

# Sentence cue words — sentences containing these are the ones that
# actually enumerate what's in the package. We weight them heavily.
CUE = re.compile(
    r'\b(include[sd]?|comes? with|come with|packaged with|ships? with|'
    r'accessor(?:y|ies)|featuring|armed with|wields?|equipped with)\b',
    re.I,
)

# Negations — if a cue sentence is negated, skip it.
NEG = re.compile(r'\b(no|without|does not include|doesn\'t include|not included)\b', re.I)

# Where the AF411 marketing description ends and price/stat boilerplate
# begins. We never scan past the first of these.
TAIL_MARKERS = [
    '[high:', 'the average buy it now', 'scroll right for more price',
    'this action figure is part of the', 'this toy was added',
    'it can be found online', 'with an average selling price',
    'retail:', 'upc:', 'asin:', 'tip:', 'point your camera',
    'do you have additional info',
]


@dataclass
class ExtractResult:
    accessories: list[str] = field(default_factory=list)
    confidence: str = 'low'
    unmatched: list[str] = field(default_factory=list)

    def __bool__(self):
        return bool(self.accessories)


def _build_vocab(extra_custom: list[str] | None):
    """Return (alias_map, valid_names). extra_custom names are added as
    exact-phrase aliases so loadouts.json customs are always matchable."""
    alias = dict(ALIASES)
    valid = set(CANONICAL) | set(alias.values())
    for name in (extra_custom or []):
        valid.add(name)
        key = name.lower().strip()
        # Only add an auto-alias if it's a clean phrase (no leading count,
        # no "Effect - " style label) to avoid baking counts into matches.
        if key and key not in alias and not re.match(r'^\d', key) and ' - ' not in key:
            alias[key] = name
    return alias, valid


def _trim_to_description(text: str) -> str:
    low = text.lower()
    cut = len(text)
    for m in TAIL_MARKERS:
        i = low.find(m)
        if i != -1:
            cut = min(cut, i)
    return text[:cut]


def _split_sentences(text: str) -> list[str]:
    # Keep it simple: split on sentence enders. AF411 prose is short.
    parts = re.split(r'(?<=[.!?])\s+|\n+', text)
    return [p.strip() for p in parts if p.strip()]


def _match_spans(segment: str, alias: dict[str, str]):
    """Greedy longest-span-first match over one text segment.
    Returns list[(start, name)] in document order, non-overlapping."""
    low = segment.lower()
    # Sort aliases longest-first so 'power sword' beats 'sword' at a shared start.
    candidates = []
    for phrase, name in alias.items():
        # \b works for word chars; for phrases with non-word edges (&, /)
        # fall back to a looser boundary.
        pat = r'(?<![a-z0-9])' + re.escape(phrase) + r'(?![a-z0-9])'
        for m in re.finditer(pat, low):
            candidates.append((m.start(), m.end(), len(phrase), name))
    # Greedy: earliest start, then longest, then accept if span free.
    candidates.sort(key=lambda c: (c[0], -c[2]))
    taken = []
    occupied = []  # list of (start,end)
    for start, end, _ln, name in candidates:
        if any(not (end <= s or start >= e) for s, e in occupied):
            continue
        occupied.append((start, end))
        taken.append((start, name))
    taken.sort(key=lambda t: t[0])
    return taken


def extract_accessories(description: str, custom_accessories: list[str] | None = None) -> ExtractResult:
    """Extract a suggested loadout from an AF411 description string."""
    if not description or not description.strip():
        return ExtractResult()

    alias, valid = _build_vocab(custom_accessories)
    body = _trim_to_description(description)
    sentences = _split_sentences(body)

    found: list[str] = []
    seen = set()
    cue_hit = False
    matched_any_hard = False

    # Pass 1: cue sentences (high-signal). Pass 2: lead sentences as fallback.
    cue_sentences = [s for s in sentences if CUE.search(s) and not NEG.search(s)]
    scan = cue_sentences if cue_sentences else sentences[:2]
    if cue_sentences:
        cue_hit = True

    for sent in scan:
        for _start, name in _match_spans(sent, alias):
            if name not in seen and name in valid:
                seen.add(name)
                found.append(name)
                if name not in PAPER_GOODS:
                    matched_any_hard = True

    # Collect accessory-ish phrases we did NOT map, for the reviewer.
    unmatched = _collect_unmatched(scan, found, alias)

    # Confidence
    if found and cue_hit and matched_any_hard:
        conf = 'high'
    elif found:
        conf = 'medium'
    else:
        conf = 'low'

    return ExtractResult(accessories=found, confidence=conf, unmatched=unmatched)


def _collect_unmatched(sentences, found, alias) -> list[str]:
    """Heuristic: inside cue sentences, list noun-ish fragments adjacent to
    'and/,' that we didn't match and aren't noise — these are candidates a
    human might want to add (or add to the custom list)."""
    out = []
    seen = set()
    verb_tail = {
        'comes', 'come', 'includes', 'include', 'included', 'has', 'have',
        'is', 'are', 'was', 'were', 'ships', 'ship', 'features', 'featuring',
        'wields', 'wield', 'wielding', 'equipped', 'packaged', 'and', 'the',
    }
    for sent in sentences:
        # crude fragmenting on connectors
        for frag in re.split(r',|;|\band\b|\bas well as\b|\bplus\b|\bwith\b', sent, flags=re.I):
            f = frag.strip(' .!?').lower()
            f = re.sub(r'^(a|an|the|its|his|her|their|removable|signature|iconic|new|extra|alternate|deluxe|classic|vintage|original)\s+', '', f)
            f = re.sub(r'\s+(accessor(?:y|ies)|included|is included|are included)$', '', f).strip()
            if not f or len(f) < 3 or len(f.split()) > 4:
                continue
            if f in NOISE or f in alias:
                continue
            # drop fragments that are just clause scaffolding (proper-noun + verb)
            toks = f.split()
            if toks and (toks[-1] in verb_tail or toks[0] in verb_tail):
                continue
            # skip if it actually contains a matched name (already captured)
            if any(name.lower() in f for name in found):
                continue
            # must look like a thing (no digits-only, no verbs we know)
            if re.match(r'^\d', f) or f in {'include', 'includes', 'comes', 'come'}:
                continue
            if f not in seen:
                seen.add(f)
                out.append(f)
    return out[:6]


if __name__ == '__main__':
    import sys
    txt = sys.stdin.read() if not sys.stdin.isatty() else ' '.join(sys.argv[1:])
    r = extract_accessories(txt)
    print('accessories:', r.accessories)
    print('confidence :', r.confidence)
    print('unmatched  :', r.unmatched)
