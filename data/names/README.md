<!-- Portions adapted from Octet Draw (https://github.com/SamChemMan/Octet-Draw), Copyright 2026 Sam Ellis, licensed under the Apache License, Version 2.0 (http://www.apache.org/licenses/LICENSE-2.0). Modified for ChemDraft: documented offline OPSIN-first lookup and shared asset bundling. -->

# Offline chemical name dictionary

The committed dictionary (`dictionary.tsv.gz`) is the Wikidata snapshot from the 9 November 2026 response
cache: 28,933 compounds, 108,023 column-2 names, 23,217 column-5 names,
and 27,073 CAS registry numbers. Its gzip size is 1,881,198 bytes and its SHA-256 is
`1afd4b4cf7b828a3e4cf9669e5328838d9d840f6392fb1681761b018c1ae1c11`.
Wikidata data is CC0 1.0; its upstream `NOTICE.txt` is copied verbatim beside the data.

The source selected compounds with SMILES and an article in one of ten Wikipedias.
It includes English/German labels and aliases, single-active-ingredient brand names,
and CAS numbers checked by check digit. Greek letters and umlauts have spelled-out
aliases where supplied by the source. Ambiguous names and collisions were curated
upstream; ChemDraft makes no online requests to resolve names.

Format: UTF-8 gzip, one compound per line, tab-separated columns:
SMILES; names separated by `|`; CAS numbers separated by `|`; InChIKey;
exact names formerly used only for suggestions, separated by `|`. A leading `!` marks a name that upstream
preferred before OPSIN. ChemDraft strips that marker and always tries OPSIN first,
as required by its resolution policy. Both name columns now support exact fallback
lookup: column 5 holds actual Wikidata names that upstream's OPSIN already understood,
not misspellings or fuzzy candidates. Its use for suggestions was an optimization of
the upstream runtime, not a different claim about those names. Names shared across
different InChIKeys are refused by the reader, including collisions between columns
2 and 5; repeated spellings of one identity are allowed. InChIKeys identify collisions
but are not themselves searchable. No fuzzy search, condensed-formula parser or
network lookup is added to the application.

Exact-name normalization has one shared definition in
`packages/document-workflow-core/src/nameDictionaryKey.mjs`, imported by both builder
and reader. It lowercases and deletes whitespace and hyphens/dashes (U+002D,
U+2010–U+2015, U+2212, U+FE63, U+FF0D), so `beta-carotene`, `betacarotene` and
`beta–carotene` match. Apostrophe/prime variants U+0027, U+2019, U+02BC, U+2032,
U+2018 and U+0060 become a retained `′` (U+2032); each pair becomes `″` (U+2033),
also matching an existing double prime. Thus `N'-Methylnicotinamide` and
`N’-Methylnicotinamide` match, while `N-methylnicotinamide` stays distinct;
`1'-` and `1-` also stay distinct. Dot variants `.`, `•`, `∙` and `⋅` fold to `·`.
Other characters remain unchanged, including Greek letters. Compared with the
original normalizer that deleted apostrophes, this candidate changes keys for 2,231
distinct source spellings (2,411 column occurrences, covering 2,098 resulting keys).
Twenty spellings gain a previously ambiguous lookup; no unique assignment changes
when comparing the two normalizers on this candidate. The reader refuses any key
shared by different full InChIKeys.

ChemDraft keeps existing built-in template resolution, then asks OPSIN, then consults
the dictionary only for a parse miss. Engine failures do not trigger fallback.
Dictionary SMILES enter the same depiction/validation path as OPSIN SMILES.
The table can represent a parent rather than a marketed salt, or a different tautomer;
the returned source and exact matched name/CAS identify the dictionary's claim.

## Diagnosis and corrected build rule

The Octet Draw reference's `scripts/build-dictionary.ts:230–239` excludes names in
its `COMMON` and `DRUGS` tables; `src/common.ts:12` includes `aspirin`, so that word
never reaches any snapshot column. Separately, `scripts/build-dictionary.ts:241–250`
moves OPSIN-readable names to column 5 or drops them, which explains names such as
`ibuprofen` appearing only there; this is not a brand, language, or case-folding filter.

Column 5 is documented at `scripts/build-dictionary.ts:305–307`. Octet Draw's reader
adds it to its suggestion index (`src/dictionary.ts:38–48`) but its exact dictionary
lookup uses `byName` from column 2 (`src/dictionary.ts:99–106`). The public reference
is [Octet Draw](https://github.com/SamChemMan/Octet-Draw).

ChemDraft's builder considers all usable English/German labels and aliases, including
brands with exactly one active ingredient. It never subtracts another runtime's built-in
names. Identifier/formula/length/protocol filters still apply. Every name **new for its
full InChIKey**, across both exact-name columns, must pass the accuracy gate:

1. The item's own English or German label, with explicit label provenance; or
2. OPSIN parses the name and RDKit computes the **same full InChIKey**; or
3. A PubChem response for that name has the same connectivity **and second block**
   (stereo/isotopes), never just the first block or a largest-fragment match.

An available contradictory OPSIN or PubChem reading vetoes a new name, even a label.
Names carrying D-/L-, alpha/beta, R/S, Greek alpha/beta or sugar/epimer stems
(`gluco`, `galacto`, `manno`, `allo`, `altro`, `gulo`, `ido`, `talo`, including German
spellings) require rule 2 or 3. Unverifiable names are dropped. This rejects the
glucosamine/mannosamine/allo/talo aliases incorrectly attached to
`OVRNDRQMDRJTHS-CBQIKETKSA-N`; stereo assertions are never relaxed.

The provided cached German query combines labels and aliases under kind `g` and cannot
prove which is the own label. Those names conservatively require rule 2 or 3; the
builder does not promote a German alias to label. Likewise, a connectivity-only source
selection cannot establish an own-label exception when the item's full key disagrees.
English OPSIN-readable names remain in column 2; German ones use column 5. The stronger
gate replaces the old German short-word/English-word and salt-skeleton heuristics.
The explicit word-list input and its printed checksum remain for rebuild provenance.

Baseline names keep their existing treatment for the **same full compound identity**,
using the application's exact-name normalization, including names formerly in column 5.
A name present for one stereoisomer is still new for every other stereoisomer.
Previously searchable column-2 ownership wins over column-5 and new collisions.
Otherwise unique baseline name/CAS ownership wins over new collisions; other collisions require
matching full stereo (names) or full InChIKey (CAS), or are removed. Both name columns
participate. Names appearing on one compound still need the gate.

Selection remains SMILES plus an article in one of ten Wikipedias; isomeric-before-
canonical SMILES, full-key preference before connectivity; valid CAS checksums;
Greek/umlaut spellings; and merging equal full InChIKeys. The committed RDKit engine
derives new structure keys without a new dependency. Baseline SMILES and keys are
preserved together, without canonicalizing or rewriting legacy chemistry.

### Coverage regression audit

The 2026-11-09 cache shows why the port's first rebuild lost 182 legacy identities:

| Cause | Legacy identities | Examples / effect |
| --- | ---: | --- |
| RDKit parsing/sanitization rejects the legacy SMILES | 66 | Bridged boranes/carboranes, unusual valences and organometallics; diborane |
| RDKit parses, but InChI/InChIKey generation fails | 8 | Coordination species including nickel phthalocyanine, platinum ammines and iridocene; distinct from a parse failure |
| RDKit computes a different key for the same legacy SMILES | 83 | Many oxyhalogen ions/salts, inorganic representations and some stereo; ammonium chlorate |
| Sorted candidate/key preference selects another available representation | 20 | Ionic versus bonded n-butyllithium and mercury fulminate, multiple keys, or more specified stereo |
| No matching row in the cached selection | 5 | abciximab, interferon alfa-2b, aflibercept, pardoprunox hydrochloride, gadofosveset trisodium |

The selection query itself did not narrow. Absence from its cached response does not
prove an item was deleted or distinguish a missing SMILES from a missing qualifying
Wikipedia article. In particular, do not claim Wikidata deleted the five absent items.

The builder now uses the committed gzip as a baseline (`--baseline` can pin an older
one). It preserves original rows when engines disagree or sources disappear, and
prefers the exact baseline SMILES/key pair when it still occurs in source candidates.
This restores all 182 compounds and the 145 CAS numbers missing from the first rebuild.
No legacy compound or CAS is intentionally dropped. Preservation is **not** a claim that
RDKit can depict every legacy structure, or that legacy aliases have been revalidated.
The build fails if any baseline compound or CAS assignment disappears. For names,
the gate first indexes **only baseline column 2 with the old application's exact
normalization**, identifying its 66,343 previously unambiguous searchable keys.
Every original spelling belonging to those keys must resolve through the candidate's
two-column reader normalization to the **same full InChIKey**. Disappearances and
remaps both fail unless listed in the script's `LEGACY_NAME_CHANGES`, with an explicit
reason and exact old/new identities. An old column-5 collision cannot hide a loss.

There are two reviewed exceptions. The first is `!ethylformate` (the `!` is a source marker):
`XBDQKXXYIPTUBI-UHFFFAOYSA-M` → `WBJINCZRORDGAQ-UHFFFAOYSA-N`. The legacy
SMILES `CCC(=O)[O-]` is propionate, a net −1 species, whereas ethyl formate is
neutral `CCOC=O`. The baseline already assigned `ethyl formate` to that neutral
identity. Only the erroneous alias is removed; the charged compound remains.

The second is `Β-Pinen`: `GRWFGVWFFZKLTI-RKDXNWHRSA-N` →
`WTARULDDTDQWMU-UHFFFAOYSA-N`. Greek uppercase `Β` and lowercase `β` both specify
beta-pinene. The legacy `CC1=CC[C@@H]2C[C@H]1C2(C)C` is (+)-alpha-pinene, with
an endocyclic double bond. Beta-pinene instead has an exocyclic double bond; its
baseline SMILES is `CC1(C2CCC(=C)C1C2)C`, already named `β-Pinen` in column 5.
The corrected lookup returns this beta-pinene identity without specifying stereo.
The alpha-pinene compound remains, with its other legacy names intact.

The other three reviewed names retain their legacy assignments:

| Name | Preserved full InChIKey |
| --- | --- |
| `tropanol` | `CYHOMWAPJJPNMW-JIGDXULJSA-N` |
| `N'-Methylnicotinamide` | `LDHMAVIPBRSVRG-UHFFFAOYSA-O` |
| `Phenyl-Propanol` | `VAJVDSVGBWFCLW-UHFFFAOYSA-N` |

These preserve historical behavior, not a new chemical validation claim.
`N-methylnicotinamide` remains a separate name for its separate identity, because
the prime is retained. Hyphen deletion makes `phenylpropanol` share the legacy
`Phenyl-Propanol` key again. The builder's existing column-2 ownership rule retains
`VAJVDSVGBWFCLW-UHFFFAOYSA-N` for that key and removes the conflicting column-5
alias from `DYUQAZSOFZSPHD-UHFFFAOYSA-N`; both compound rows remain.

The candidate's `.report.json` records every restored identity with original SMILES,
names, CAS, matching QIDs, source candidates/computed keys, engine diagnostic and
reason. It also records every gate decision and its available structure evidence.

### Why glucose is absent

This is a selection-stage absence, not a name collision: the complete cached selection
has neither `glucose` nor `D-glucose` as a label/alias and no row with either
`WQZGKKKJIJFFOK-GASJEMHNSA-N` (D-glucopyranose without anomeric stereo) or
`GZCGUPFRVQAUEE-SLPGGIOYSA-N` (open-chain D-glucose). The related selected items are
Q424248 (`pyranose`) and Q23905960 (`glucopyranose`), both
`WQZGKKKJIJFFOK-UHFFFAOYSA-N`, with **all** stereocentres unspecified. They cannot
represent D-glucose. Neither glucose spelling has a PubChem response in this cache.
OPSIN parses both as the open-chain D form, not the requested pyranose representative.

Consequently this snapshot deliberately has no glucose dictionary fallback. Normal
OPSIN-first resolution still handles the names. A future ring representative needs
new source evidence establishing the D ring stereo without assigning an alpha/beta
anomer. The common-name regression explicitly checks this absence; all other identity
assertions remain full InChIKey comparisons.

### Candidate build audit

Rebuilt offline on macOS from the supplied 2026-11-09 response cache, using baseline
commit `44791b5e`, OPSIN 2.9.0 and repository RDKit. The build gained 53 compounds and
restored 182 legacy rows. No baseline compounds or CAS assignments were lost. All
66,343 previously unambiguous column-2 name keys remain searchable, with the two
allowlisted identity corrections above and no unreviewed remaps or disappearances.
It contains 102,950 searchable name keys. Under the corrected normalization, 36,615
are absent from baseline column 2: 18,893 were present only in column 5 and 17,722
were absent from the entire old file. This compares file coverage under the corrected
normalization, separately from the old-application regression guarantee above.
The accuracy gate approved 884 name/identity pairs by label, 17,200 by OPSIN and 461
by PubChem; it excluded 1,739 as unverifiable and 5,009 as contradicted. PubChem evidence
was uncached for 61 names; no requests were made for them. These gate
counts are not an accuracy percentage or an external validation benchmark.

Applying the new normalization to the previous whitespace-only candidate creates
nine cross-identity collision keys. The rebuilt candidate refuses one entirely
(`5-MeO-PiPT` / `5-MeO-pip-T`); eight retain only the owner established by the
existing legacy/evidence rules. No cross-identity collision remains in the output.
None of these nine collisions is new relative to the original apostrophe-deleting
normalizer. The comparison, full identities and spellings are recorded in
`tmp/name-normalization-audit.json`, generated by `tmp/audit-name-normalization.mjs`.

English word-list SHA-256 (macOS `/usr/share/dict/words`):
`be41ad97963bf8dabedd5871d5d691596175269d540956b0f9965a885c2bbab9`.

Additional build changes are explicit: protocol tabs/newlines are rejected before
whitespace normalization; collisions cover column 5 as well as column 2; failed
Wikipedia queries fail the build instead of silently omitting a language; all selection
ties and output lists are sorted. The upstream `--check` random PubChem benchmark is
not ported, and its historical accuracy claims do not apply to regenerated data.

## Rebuild

From the repository root, stage a candidate from an existing response cache:

```sh
node scripts/build-name-dictionary.mjs --offline --cache ./tmp/name-dictionary-cache --words ./tmp/english-words.txt --out ./tmp/dictionary.tsv.gz
```

Supply a UTF-8 English word-list, one word per line, at `./tmp/english-words.txt`.
Use the same list across macOS and Windows and record the SHA-256 printed by the
builder. The reference uses its host's `/usr/share/dict/words`; this port requires an
explicit input instead of assuming a platform-specific path. Existing Java is used
to verify English and German candidate names: the builder uses the
bundled runtime when available, otherwise `java` from PATH; `--java <executable>`
overrides it. It reads the existing OPSIN jar without changing or building the runtime.

Print the SPARQL queries without network access, Java, or engine loading:

```sh
node scripts/build-name-dictionary.mjs --dry-run
```

The details query shown uses an example QID; a real build repeats it in batches of
1,000 selected QIDs. Requests use the public Wikidata SPARQL endpoint and a descriptive
ChemDraft User-Agent with no email address. PubChem PUG REST is used only by the build
referee, at less than five requests/second. Successful responses (including PubChem
404 misses) are cached by query hash; use a fresh cache for a fresh snapshot. Transient
failures retry and then fail the build rather than silently becoming missing names.
Omit `--offline` only when collecting new network responses.

In offline mode every attempted request without its cache file throws an explicit
`Offline cache miss` error. The gate inventories available PubChem evidence first:
uncached candidate names are listed and counted in the audit, with no request made.
They can pass only by an eligible own label or OPSIN; all other such names are
explicitly rejected as unverifiable. An absent cache file is never treated as a cached
PubChem 404. No network calls are made during an offline rebuild.

`--out <path>` is required and cannot target the baseline or committed dictionary.
Only the integrating conductor replaces that file after review. `--report <path>`
overrides the default `<out>.report.json`. Given
the same cached responses, word-list, repository engine bytes and Java/OPSIN version,
QIDs, structures and names are ordered deterministically; gzip uses level 9, zero
timestamp, no filename and a fixed OS header byte. Live Wikidata/PubChem can change,
so a fresh network collection is not expected to reproduce an older snapshot.

Verify the builder and reader, then the committed common-name coverage:

```sh
node --test scripts/build-name-dictionary.test.mjs
pnpm vitest run --configLoader runner packages/document-workflow-core/src/nameDictionary.test.ts packages/chemdraft-cli/src/commands/name.test.ts
CHEMDRAFT_NAME_DICTIONARY_CANDIDATE=./tmp/dictionary.tsv.gz pnpm vitest run --configLoader runner packages/chemdraft-cli/src/commands/commonNameDictionary.test.ts
```

The environment variable selects only a test input; production lookup has no such
override. On PowerShell set `$env:CHEMDRAFT_NAME_DICTIONARY_CANDIDATE` before invoking
the same pnpm command. Without it, the suite tests the committed asset. The last suite mocks OPSIN to miss and checks full InChIKeys using RDKit, with the
explicit glucose absence above. It also checks that OPSIN-first names rejected by the
gate are absent from the dictionary.

The shared pure lookup and resolution policy live in `document-workflow-core`, with
injected text loading. Desktop/web fetch the bundled local asset and decompress with
`DecompressionStream`; CLI/MCP read the same file with `node:zlib`. Loading and parsing
are cached on first fallback, with parsing yielded in slices. No new dependency is used.

## Distribution size

The **rebuilt candidate** compressed file is **1,881,198 bytes** (1.88 MB / 1.79 MiB). The dictionary is referenced by a
literal `new URL` from the shared package so Vite emits one hashed
`apps/desktop/dist/assets/dictionary-<hash>.tsv.gz` asset. Tauri embeds it with the
frontend assets in the desktop application on both platforms; no extra native resource
copy is needed. Headless tools use the workspace's `data/names/dictionary.tsv.gz`.

Estimated added desktop application payload and web build size: **about 1.88 MB each**,
plus a few KB of lookup/loader code. Installer compression may change the final size.
These are estimates; production builds are verified by the integrating conductor.
