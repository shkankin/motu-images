# MOTU Vault — AF411 Catalog Sync

Automated pipeline to keep your `figures.json` and figure images in sync with [ActionFigure411.com](https://www.actionfigure411.com/masters-of-the-universe/).

## How It Works

```
AF411 Checklist Pages  →  Python Scraper  →  Diff vs figures.json  →  Auto-commit to main
                                           →  Download new images
```

The scraper parses AF411's checklist pages (one per line: Origins, Masterverse, etc.), extracts every figure's name, wave, year, retail price, group/subline, and image. It then compares against your existing `figures.json`, reports what's new or changed, and (when `--commit` is passed) updates the JSON and downloads missing images.

## Usage

### From GitHub (recommended)

1. Go to the **Actions** tab in your repo
2. Select **"Sync AF411 Catalog"** from the sidebar
3. Click **"Run workflow"**
4. Optionally pick a specific line or check "audit only"
5. It runs, commits any changes directly to `main`

### Locally

```bash
# Dry run — see what's new without changing anything
python scripts/sync_af411.py

# Audit — detailed report including field-level changes
python scripts/sync_af411.py --audit

# Commit — update figures.json + download new images
python scripts/sync_af411.py --commit

# Sync just one line
python scripts/sync_af411.py --commit --line origins

# Slower fetch (default 1.5s between pages)
python scripts/sync_af411.py --commit --delay 3
```

## Setup

### 1. Add the files to your `motu-images` repo

```
your-repo/
├── .github/
│   └── workflows/
│       └── sync-af411.yml      ← GitHub Action
├── scripts/
│   └── sync_af411.py           ← scraper
├── figures.json                ← your existing catalog
├── he-man-2393.jpg             ← figure images
├── skeletor-2397.jpg
└── ...
```

### 2. Enable Actions

In your repo settings → Actions → General, make sure "Allow all actions" is enabled and the workflow has **Read and write permissions** under "Workflow permissions".

### 3. Run it

Go to Actions → "Sync AF411 Catalog" → "Run workflow". That's it.

## What Gets Synced

| Field    | Source                                    |
|----------|-------------------------------------------|
| `id`     | AF411 slug (e.g. `he-man-2393`)           |
| `name`   | Figure name from checklist                |
| `line`   | Mapped from AF411 series                  |
| `group`  | Subline header from checklist page        |
| `wave`   | Wave column                               |
| `year`   | Year column                               |
| `retail` | Retail price column                       |
| `slug`   | URL slug (used for image filenames)       |
| `faction`| Auto-guessed from name/group keywords     |
| Image    | Downloaded from AF411's image CDN         |

## Notes

- **Polite scraping**: 1.5s delay between page fetches by default. AF411 is a community resource — don't hammer it.
- **Factions are best-effort**: The auto-classifier covers the major characters but may label obscure figures as "Other". You can manually fix these in `figures.json`.
- **Custom/manual figures are preserved**: Figures in your `figures.json` that don't exist on AF411 (e.g. `line: "custom"`) are never removed.
- **Images**: Downloaded as JPGs to the repo root, matching the `{slug}.jpg` naming convention.
- **No dependencies**: Pure Python 3, stdlib only. No pip install needed.
