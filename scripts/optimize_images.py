#!/usr/bin/env python3
"""optimize_images.py — cap catalog image dimensions and recompress in place.

WHY (audit PERF-04). images/ is 200 MB across 1433 files, but the MEDIAN file
is 215px wide and 30 KB — those came from AF411's own thumbnails and are fine.
The weight is concentrated: 214 files over 200 KB hold ~153 MB of the total,
topping out at nordor-12964.jpg (2928x2448, 6.5 MB) for something the app
renders as a list thumbnail. Now that image caching actually works again
(v7.86), that weight lands on every device.

WHAT THIS DOES NOT DO, deliberately:
  * No WebP/AVIF conversion. Measured on a 25-file sample of the oversized
    set: resize+JPEG q82 is 70% smaller, WebP q80 is 80%. The extra 34% off an
    already-small number would cost an extension migration across data.js
    (three `${IMG}/${slug}.jpg` sites), sync_af411.py's download_image and the
    editor's upload naming, plus a period where both extensions coexist. Not
    worth it. Filenames are untouched, so nothing in the app changes.
  * No separate thumbnail tier. The audit suggested ~400px thumbnails, but the
    median image is ALREADY 215px wide — a 400px "thumbnail" would be larger
    than most originals, and it would double the file count for a net loss on
    ~1200 of 1433 files.

Idempotent: a file already within MAX_EDGE that would not shrink by at least
MIN_GAIN is left byte-identical, so re-running is a no-op and the commit is
empty. Safe to schedule.

Usage:
  python scripts/optimize_images.py --dry-run     # report only, writes nothing
  python scripts/optimize_images.py --commit      # rewrite in place
  python scripts/optimize_images.py --commit --max-edge 1400 --quality 85
"""
import argparse
import io
import os
import sys
from pathlib import Path

try:
    from PIL import Image, ImageFile
except ImportError:
    print("✗ Pillow is required:  pip install pillow")
    sys.exit(1)

ImageFile.LOAD_TRUNCATED_IMAGES = True

REPO_ROOT = Path(__file__).resolve().parent.parent
IMAGES_DIR = REPO_ROOT / "images"

MAX_EDGE = 1200      # longest edge; the detail view never shows more than this
QUALITY = 82         # measured sweet spot on this catalog
MIN_BYTES = 150 * 1024   # leave anything already small alone entirely
MIN_GAIN = 0.10          # only rewrite if we save at least 10%


def optimize_bytes(raw, max_edge, quality):
    """Return recompressed bytes, or None if the image can't be handled."""
    try:
        im = Image.open(io.BytesIO(raw))
        im.load()
    except Exception:
        return None
    # EXIF orientation: apply it before resizing, or portrait shots rotate.
    try:
        from PIL import ImageOps
        im = ImageOps.exif_transpose(im)
    except Exception:
        pass
    if im.mode not in ("RGB", "L"):
        im = im.convert("RGB")
    if max(im.size) > max_edge:
        im.thumbnail((max_edge, max_edge), Image.LANCZOS)
    buf = io.BytesIO()
    # progressive: better perceived load over a weak connection, which is the
    # exact scenario that started this.
    im.save(buf, "JPEG", quality=quality, optimize=True, progressive=True)
    return buf.getvalue()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--commit", action="store_true", help="write changes")
    ap.add_argument("--dry-run", action="store_true", help="report only (default)")
    ap.add_argument("--max-edge", type=int, default=MAX_EDGE)
    ap.add_argument("--quality", type=int, default=QUALITY)
    ap.add_argument("--min-bytes", type=int, default=MIN_BYTES)
    args = ap.parse_args()
    write = args.commit and not args.dry_run

    files = sorted(
        p for p in IMAGES_DIR.iterdir()
        if p.suffix.lower() in (".jpg", ".jpeg") and p.is_file()
    )
    print(f"  Scanning {len(files)} jpg files in images/")
    print(f"  max edge {args.max_edge}px · quality {args.quality} · "
          f"skip under {args.min_bytes // 1024} KB · {'WRITING' if write else 'DRY RUN'}\n")

    before = after = 0
    changed = skipped = failed = 0
    worst = []

    for p in files:
        orig = p.stat().st_size
        before += orig
        if orig < args.min_bytes:
            after += orig
            skipped += 1
            continue
        raw = p.read_bytes()
        new = optimize_bytes(raw, args.max_edge, args.quality)
        if new is None:
            print(f"    ⚠ could not decode {p.name}")
            after += orig
            failed += 1
            continue
        if len(new) >= orig * (1 - MIN_GAIN):
            # Not enough gain — leave it BYTE-IDENTICAL so reruns are no-ops.
            after += orig
            skipped += 1
            continue
        if write:
            p.write_bytes(new)
        after += len(new)
        changed += 1
        worst.append((orig - len(new), p.name, orig, len(new)))

    mb = lambda n: n / 1024 / 1024
    worst.sort(reverse=True)
    if worst:
        print("  Largest savings:")
        for saved, name, o, n in worst[:10]:
            print(f"    {mb(o):6.2f} MB → {mb(n):5.2f} MB   {name}")
        print()
    print(f"  {'═' * 54}")
    print(f"  files rewritten:  {changed}")
    print(f"  left untouched:   {skipped}")
    if failed:
        print(f"  failed to decode: {failed}")
    print(f"  images/ total:    {mb(before):.1f} MB → {mb(after):.1f} MB"
          f"   ({mb(before - after):.1f} MB saved,"
          f" {100 - int(after * 100 / before) if before else 0}%)")
    if not write:
        print("\n  DRY RUN — nothing written. Re-run with --commit to apply.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
