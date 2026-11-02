<!-- Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: documented offline OPSIN-first lookup and shared asset bundling. -->

# Offline chemical name dictionary

`dictionary.tsv.gz` is the unchanged Wikidata snapshot collected on 27 October 2026:
28,880 compounds, 67,602 names and 27,031 CAS registry numbers. Wikidata data is
CC0 1.0; its upstream `NOTICE.txt` is copied verbatim beside the data.

The source selected compounds with SMILES and an article in one of ten Wikipedias.
It includes English/German labels and aliases, single-active-ingredient brand names,
and CAS numbers checked by check digit. Greek letters and umlauts have spelled-out
aliases where supplied by the source. Ambiguous names and collisions were curated
upstream; ChemDraft makes no online requests to resolve names.

Format: UTF-8 gzip, one compound per line, tab-separated columns:
SMILES; names separated by `|`; CAS numbers separated by `|`; InChIKey;
suggestion-only names separated by `|`. A leading `!` marks a name that upstream
preferred before OPSIN. ChemDraft strips that marker and always tries OPSIN first,
as required by its resolution policy. It uses only the first three columns:
no InChIKey lookup, suggestions, condensed-formula parser or network lookup is ported.

ChemDraft keeps existing built-in template resolution, then asks OPSIN, then consults
the dictionary only for a parse miss. Engine failures do not trigger fallback.
Dictionary SMILES enter the same depiction/validation path as OPSIN SMILES.
The table can represent a parent rather than a marketed salt, or a different tautomer;
the returned source and exact matched name/CAS identify the dictionary's claim.

The shared pure lookup and resolution policy live in `document-workflow-core`, with
injected text loading. Desktop/web fetch the bundled local asset and decompress with
`DecompressionStream`; CLI/MCP read the same file with `node:zlib`. Loading and parsing
are cached on first fallback, with parsing yielded in slices. No new dependency is used.

## Distribution size

The compressed file is **1,627,077 bytes** (1.63 MB / 1.55 MiB). It is referenced by a
literal `new URL` from the shared package so Vite emits one hashed
`apps/desktop/dist/assets/dictionary-<hash>.tsv.gz` asset. Tauri embeds it with the
frontend assets in the desktop application on both platforms; no extra native resource
copy is needed. Headless tools use the workspace's `data/names/dictionary.tsv.gz`.

Estimated added desktop application payload and web build size: **about 1.63 MB each**,
plus a few KB of lookup/loader code. Installer compression may change the final size.
These are estimates; production builds are verified by the integrating conductor.
