# ORV Reader

A spoiler-safe reader for your own copy of *Omniscient Reader's Viewpoint*. The book is not included: you supply
the epub, and everything built from it stays on your machine.

## Set it up

    mkdir src-epub && unzip your-copy.epub -d src-epub
    python3 -I build/parse_epub.py src-epub/OEBPS build/chapters.json
    python3 -I build/split_and_find.py build/chapters.json data
    python3 -I build/extract_entities.py

## Run it

    ./start.sh              # this Mac only, then open http://127.0.0.1:8787/
    ./start.sh --lan        # also prints a phone link (same Wi-Fi), token-protected

Your place and progress live in `state/state.json`, so the Mac and phone share one position.
Recaps and lookups are cached in `state/cache.json`.

## How the spoiler gate works

The server holds your place (`readTo`). Search, lookups and recaps are built on the server from
chapters up to that place only, and Claude is run headless with no tools and an empty working folder,
so it cannot read the rest of the book. Opening a later chapter yourself is allowed; it does not
widen the gate until you press "Move my place here" or reach it with Next.

## Highlighted names

`data/entities.json` lists the constellations, nebulae, items and places that get colored. It is built from the
book's own System messages (`constellation 'X'`, `nebula 'X'`, `item 'X'`) plus a place-name pattern and a few
hand-added names. To add or drop names, edit `SEEDS` / `EXCLUDE` in `build/extract_entities.py`, then run:

    python3 -I build/extract_entities.py

## Files

- `server.py` server and Claude calls
- `app/` the reader (index.html, style.css, app.js)
- `data/` one JSON file per chapter plus index.json
- `state/` your position, cache, phone token
