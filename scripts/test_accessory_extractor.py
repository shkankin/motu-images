#!/usr/bin/env python3
"""Tests for accessory_extractor. Fixtures are REAL AF411 description
prose (pulled from live pages) plus adversarial edge cases."""

from accessory_extractor import extract_accessories

CUSTOM = [  # the customAccessories already in loadouts.json
    '8 Missiles', 'Arm Armor', 'Bat Shield', 'Bat Wing Propeller', 'Battle Axe',
    'Blasterpak', 'Buzz Saw Blades', 'Certificate of Authenticity', 'Claw',
    'Collar', 'Cosmic Key', 'Crown', 'Effect - Muzzle Blast',
    'Four-pronged Battle Shield', 'Grabber', 'Hat', 'Havoc Staff', 'Hood',
    'Laser', 'Laser Sword', 'Launching Fists', 'Leg Armor', 'Magic Trick Discs',
    'Mouser', 'Pet Snake', 'Power Pincer', 'Red Clip', 'Rifle', 'Ripcord',
    'Spiked Ball & Chain', 'Sword of Power', 'Tech Axe', 'Thunder Ball Mace',
    'Trigger Cord', 'Two Swords', 'Vest', 'Wand', 'Wings',
]

CASES = [
    # (label, description, must_contain, must_NOT_contain, expected_confidence)
    (
        'He-Man reissue (real AF411)',
        "His signature Power Sword is included, as well as a removable harness "
        "and shield and axe accessories. The power swords are updated from the "
        "original Wave 1 release. [High: $24.99/Low: $24.99]. The average Buy It "
        "Now price is $31.44 based upon 3 filtered active auctions.",
        {'Power Sword', 'Harness', 'Shield', 'Axe'},
        {'Sword'},          # 'Power Sword' must not ALSO emit bare Sword for same span
        'high',
    ),
    (
        'Cartoon Collection He-Man (real AF411) — Power Sword AND a separate Sword',
        "Includes mini-comic, Power Sword, Sword and harness with sword sheath.",
        {'Minicomic', 'Power Sword', 'Sword', 'Harness'},
        set(),
        'high',
    ),
    (
        'He-Skeletor (real AF411)',
        "He-Skeletor comes with 16 points of articulation and includes the iconic "
        "power sword, battle axe, and shield accessories. He-Skeletor includes "
        "sword, shield and mini-comic for meaningful storytelling. Retail: $17.99",
        {'Power Sword', 'Axe', 'Shield', 'Minicomic'},
        {'Stand'},          # 'articulation' / 'points' must not map to anything
        'high',
    ),
    (
        '200x Cartoon He-Man (real AF411)',
        "A Power Sword accessory is included with the figure, inspired by the "
        "episode. The sword can be sheathed on the back of his harness.",
        {'Power Sword'},
        set(),
        'high',
    ),
    (
        'Battlefield Warriors 2-pack (real AF411) — heads/hands are NOT accessories',
        "The Most Powerful Man in the Universe comes with alternate hand, shield "
        "and vintage-style head! Battle Cat has 12 moveable joints. Includes two "
        "Castle Grayskull gargoyles.",
        {'Shield'},
        {'Stand'},          # 'hand', 'head' must be filtered as noise
        'high',
    ),
    (
        'Castle Grayskull playset (real AF411) — structured Includes list',
        "Includes 1 hinged playset, 1 Space Suit figure, 1 play mat, 1 ladder "
        "accessory, 2 soft goods banner accessories, 1 flag accessory on stand, "
        "2 weapons rack accessories, 1 combat practice stand accessory, 4 weapon "
        "accessories and 6 decorative stickers.",
        set(),              # playset bespoke parts — fine to capture few/none
        {'Comic'},          # no comic here
        None,               # don't assert confidence (playsets are messy)
    ),
    (
        'Sky Sled (real AF411) — projectiles not in vocab, should not hallucinate',
        "Sky Sled vehicle boasts a button-activated blaster in front, with 3 "
        "projectile missiles included. Includes 1 Sky Sled Vehicle, 1 He-Man "
        "action figure and 3 projectiles.",
        {'Gun/Blaster'},
        {'Sword'},
        None,
    ),
    (
        'Negation guard',
        "This figure comes with no accessories and ships on a basic cardback.",
        set(),
        {'Shield', 'Sword', 'Cape'},
        'low',
    ),
    (
        'Custom accessory match — Havoc Staff + Cosmic Key',
        "Skeletor includes his Havoc Staff and the Cosmic Key, plus a half power "
        "sword and a cape.",
        {'Havoc Staff', 'Cosmic Key', 'Half Sword', 'Cape'},
        {'Staff', 'Power Sword'},   # longer customs/phrases must win the span
        'high',
    ),
    (
        'Crossbow must not also fire bare Bow',
        "Comes with a crossbow and a removable cape.",
        {'Crossbow', 'Cape'},
        {'Bow'},
        'high',
    ),
    (
        'Arm Armor beats Armor',
        "Includes arm armor, leg armor, a helmet and a mace.",
        {'Arm Armor', 'Leg Armor', 'Helmet', 'Mace'},
        {'Armor'},
        'high',
    ),
    (
        'Empty / junk input',
        "",
        set(),
        set(),
        'low',
    ),
]


def run():
    passed = failed = 0
    for label, desc, must, mustnot, conf in CASES:
        r = extract_accessories(desc, CUSTOM)
        got = set(r.accessories)
        problems = []
        missing = must - got
        leaked = got & mustnot
        if missing:
            problems.append(f'MISSING {sorted(missing)}')
        if leaked:
            problems.append(f'LEAKED {sorted(leaked)}')
        if conf is not None and r.confidence != conf:
            problems.append(f'CONF expected {conf} got {r.confidence}')
        if problems:
            failed += 1
            print(f'✗ {label}')
            print(f'    accessories: {r.accessories}')
            print(f'    confidence : {r.confidence}  unmatched: {r.unmatched}')
            for p in problems:
                print(f'    → {p}')
        else:
            passed += 1
            print(f'✓ {label}  →  {r.accessories}  [{r.confidence}]')
    print(f'\n{passed} passed, {failed} failed')
    return failed == 0


if __name__ == '__main__':
    import sys
    sys.exit(0 if run() else 1)
