# CDX and CDXML compatibility harness

Run from this checkout with the already-linked dependencies:

```sh
pnpm -s cdx-compat run --list paths.txt --out results --concurrency 2 --batch-size 50
pnpm -s cdx-compat report --out results
pnpm -s cdx-compat rescore --out results
pnpm -s cdx-compat report --out results --baseline previous-results
pnpm -s cdx-compat ground-truth --out results --truth-dir reference-exports
pnpm -s cdx-compat export-set --list selected-ids.txt --out results --to results/private/exports
```

`paths.txt` contains one absolute input path per line. The optional `--group-map` is TSV:
absolute path, group, optionally a year or year band (for example `1990-1999`). A year band
in the group label is also recognised. Reports replace group labels with stable `group-<hash>`
keys; use the private index to identify them. This prevents private names or paths in labels
from leaking into a report. Run `--help` for all options.

## Privacy and safety

Only synthetic fixtures belong in tests. The tool does not discover files or search user folders.
Never commit private inputs, outputs, lists, or reference exports. Select an output directory
outside every input's directory. Containment uses real paths for every listed original's parent
and for outputs, including existing ancestor directories when output does not yet exist.
An original resolving inside output is refused. Symlinks anywhere in the output tree (including
`--out`, `private`, files and temporary directories) are refused before writing.
Existing output files with multiple hardlinks or the same device/inode as a listed original
are refused before writes or appends, including resume tail repair.
Containment checks assume no other process modifies the output or originals' directories during
a run. A concurrent local process swapping a directory for a symlink between check and write
is out of scope. Run with a fresh `--out` you own.
Originals are opened only by the copy operation and closed
before hashing or parsing. Each file gets a fresh temporary directory under `private` and a read-only copy;
the directory is removed on success, exception, crash, or timeout. Parent SIGTERM/SIGINT kills and
reaps running workers and after-batch children before removing their temporary directories and
exiting (143/130). Explicit parent exit also kills children and synchronously removes temporary
directories. SIGKILL, forced OS termination, or a machine failure cannot execute cleanup; remove
abandoned private temporary directories then.
Do not run two harness parents against the same output directory.

`private/index.tsv` alone retains original paths (ID, original path, original group).
`private/results.jsonl` includes private SMILES, formulae, warnings and drawing metadata.
Paths quoted in diagnostics are redacted. The original content's SHA-256 prefix (12 hex digits)
is its ID; identical content is processed once. `--resume` skips IDs already in results.
Unreadable inputs cannot receive a content ID; their error code is logged in private events,
their index and result ID is `unavailable`, and processing continues. Their `copy-error` result
counts in report error totals; they have no resume marker or ground-truth comparison.
The `--formats` option selects round-trip destinations; input type is always detected from
binary magic or XML parsing. Defaults: both formats, 60000 ms per import (`--import-timeout-ms`),
600000 ms for summary and round-trip work per file (`--timeout-ms`), 2048 MB V8 heap, concurrency 2,
batch size 50. WASM and buffers also use memory outside the V8 heap; this is not an OS RSS cap.

`--after-batch <executable>` runs directly without a shell, with exactly one argument: a temporary
file of that batch's original paths, including resumed files. It runs only after children finish
and copies are removed. Hook failure is logged and does not stop processing. The hook must read
the list before exiting. Its output is discarded. Executable shell scripts need their own shebang;
Windows executables must be directly launchable. The callback uses `--timeout-ms`.

Every input is parsed in a separate Node child with a deadline and a V8 heap limit. Abnormal exit,
signal, timeout and detected OOM are recorded and processing continues. Results append one file at
a time. Resume rebuilds a disk ID index in `private/done` from the result stream; baseline lookup
also uses a temporary disk index. Neither retains the corpus in memory.
Group tables cap at 1000 keys per dimension and place excess groups in `overflow`; examples cap at 10.

Every failed result has `error: { stage, code, category, message }`. `stage` names copy, detect,
import, summary, export-cdx, export-cdxml, reimport-cdx, reimport-cdxml, cross (comparison), or truth.
`code` preserves the exception name or errno; `category` comes from a fixed vocabulary rather than
file content. Messages retain private error detail with paths redacted. Private errors also retain
up to five stack frames with source locations relative to the package/repository. The first error
is at `error`; `errors` retains all failures, including independent conversion routes. Round-trip
`ERROR` entries carry their own error and retain any already-computed summary and differences.
Children send IPC progress at each stage boundary, retaining detected format, parse status,
and cumulative milliseconds per stage (`timings.stageMs`) even when killed. The original import
and each reimport have their own short deadline. A timeout in an importer is `import.hang`
(`timeoutKind: "import-hang"`), labelled **IMPORT HANG**, a product finding. Exceeding the larger
summary/round-trip budget is `harness.slow` (`timeoutKind: "harness-slow"`), a harness performance
finding, never an import-hang finding. Reports count these separately under `timeouts`.
The summary/round-trip budget starts after the original import; it includes subsequent reimports,
each of which also retains its own import deadline. Startup/copy/detection use the work deadline.
Hard child exits before any progress use stage `detect`, with a worker crash, legacy/unclassified timeout, OOM
or protocol category and available exit code/signal. The parent stderr prints one completion line
per processed file (also copy failures): ID, status and distinct stage/category pairs. It prints
neither messages nor paths nor chemistry.

## Conversion and verdicts

Binary CDX functions load dynamically when available. On a build without binary CDX support,
use `--formats cdxml`: the CDXML path is unchanged and CDX/cross routes are reported as
`SKIPPED` with reason `no CDX support in this build`, never PASS or FAIL. Explicitly requesting
CDX with `--formats cdx` (or `--formats cdx,cdxml`) exits 2 with a clear error. The default
formats still run CDXML and mark unavailable binary routes SKIPPED.

The import path reuses `importCdx`, `openChemDraftPayload` and
`withNativeDocumentLabelBondSides`, the functions used by the desktop's `openNativeDocument`.
CDX export reuses `exportDocumentToCdx(..., { embedNativePayload: false })`, used by the app's
interchange export; XML uses `export-engine`'s `exportDocumentToCdxml`, used by `exportPhase4Cdxml`.
The harness strips ChemDraft native objecttags from XML before reopening: native payload restoration
would hide visible interchange losses. No application source module is imported. RDKit is loaded
through `installNodeRdkitModuleLoader`, as in the headless CLI. Molecular summaries use the live
native graph, shared abbreviation expansion and shared molfile writer, never stale stored SMILES.
Each file owns a SHA-256 cache of molecular summary inputs: native atoms/bonds (including stereo
geometry and displays), superatoms and R-groups, with local IDs normalised. Repeated molecules and
unchanged round-trip graphs reuse plain-data summaries only when that hash matches. Stored structure
strings and object IDs never substitute for graph equality. CIP tags are read once per distinct
graph; feature-only canonicalisation disables further stereo assignment. Every temporary RDKit
molecule is deleted in `finally`. Non-Error throws use Emscripten's exception decoder when available,
otherwise their own properties are JSON-encoded, with separate numeric/object categories.
WASM out-of-bounds errors discard the affected module and retry that molecule in a fresh instance,
first with strict sanitization and then with sanitization disabled. Recovery reads only the input
graph's JSON and canonical SMILES: no CIP, descriptors, InChI or secondary canonicalisation calls.
`recovery` records `fresh-molfile` or `fresh-molfile-unsanitized`. Native molecules use their molfile
transport; exceptional high-radical JSON transport retains its native radical counts. Recovery keys
are conservative raw feature graphs; an equal full canonical SMILES can borrow derived keys from
its normally summarised peer, with measured counts, charge, strictness and displays still checked.
Exhausted retries remain `rdkit.wasm_oob` errors; processing continues with the next molecule.
Every molecule records `strict`. If strict parsing fails, RDKit's own error log supplies a reason:
`valence:<element>` (no atom index), `valence`, `kekulize`, `aromaticity`, `ring-info`, `parse`, or
`other`. The full diagnostic stays private at `sanitization.message`; only categories reach reports.
The harness retries without kekulization where possible, then with sanitization disabled. These
summaries use RDKit canonical unsanitized SMILES and the shared native graph formula, charge,
isotopes, radicals and atom/bond counts, with the drawing's wedge/hash counts. Such formulae follow
the drawing's skeletal hydrogen convention; they do not assert that strict valence is valid.
Unexpanded abbreviation, R-group and generic vertices become labelled dummy atoms, counted by kind
and label in `dummyAtoms`. Deterministic atom maps preserve which label occupies which graph vertex.
Their reasons are `abbreviation`, `r-group` or `generic`. Coordination drawings and unknown-order
query bonds also use non-strict summaries (`dative` and `query-bond`), even when RDKit accepts them.
Both non-strict summaries compare the same fields as strict summaries. Changing strictness always
fails with `sanitization-changed`; conversion warnings cannot excuse it. An unparseable graph still
produces a summary error. Counts beyond MDL's two-radical-electron transport limit use RDKit JSON
with the native count and shared native hydrogen convention, also marked non-strict (`other`).
`summary.molecules` contains successfully described molecules. A failure for one molecule is kept
under `summary.summaryErrors` as `{ objectId, summaryError }`, and the other molecules and drawing
still get summaries. Reaction summary errors use the same list. Incomplete summaries cannot produce
a round-trip PASS or ground-truth agreement; exports and other routes still run. The synthetic
`fixtures/external-graph.cdxml` exercises graph-only import, including
`cdxml.external_subset_imported`, `cdxml.structure_string_not_derived` and aromatic-bond warnings.

- **PASS:** all measured chemistry and survival metrics survive the comparison.
- **WARNED:** chemistry changed, and diagnostics from that export/reimport leg explicitly name every changed feature.
  Initial import warnings cannot excuse a later loss against the post-import baseline, and each
  stage of a chained route is checked separately. An object-specific warning applies only to that
  molecule; each differing molecule needs its own matching warning. A warning without an object
  ID can excuse a feature only when exactly one molecule differs in it on that leg.
  Generic unsupported-object warnings cannot excuse chemistry loss. Summary-transport warnings
  cannot excuse interchange loss. Warning-to-feature mapping is explicit in `model.ts`;
  unrecognised warning categories stay conservative until added to that map.
  Bond-order warnings must name that molecule's old or new object ID. They excuse only
  bond order: element/H-labelled sigma graphs must be isomorphic, with charge, isotope,
  radical, CIP labels and E/Z labels compared at mapped atoms and bonds. One mapping must
  preserve all unexcused features together. Canonical sigma rank classes guide a search
  through symmetric mappings, bounded to 50,000 operations; missing graph evidence or an
  exhausted search cannot excuse a changed graph. Connectivity and per-atom H changes
  are separate `connectivity` failures, never covered by bond-order diagnostics.
- **FAIL:** at least one measured chemistry feature changed silently. A definite silent loss
  takes precedence over unfinished graph checks in the same leg, another route or initial import.
- **DRAWN-DIFFERENTLY:** a molecule's identity, charge placement, bond orders or stereo drawing
  differ, but a guarded identity check finds the same species. Private differences carry
  `classification: "same-species-different-drawing"` and the deciding `identityCheck`.
  Both a fixed-hydrogen identity match and an electron-pair resonance proof are required, even
  when standard InChI keys match. The Node-loaded RDKit MinimalLib 2026.03.3 exposes
  `get_inchi("/FixedH")`, including the tautomer-specific `/f` layer, but no
  `ResonanceMolSupplier` binding. The harness compares the full FixedH InChI; if unavailable,
  it conservatively requires equal canonical SMILES with explicit atom H counts and charges.
  This fallback can decline genuine resonance drawings with different canonical SMILES.
  Standard InChI alone never excuses a tautomer change.
  The graph proof maps identical elements, isotopes, radicals and per-atom H counts on an
  identical sigma skeleton. All changed atoms must belong to one connected conjugated system.
  It searches actual pi-pair cleavage and lone-pair donation steps, checking nonbonding-electron
  parity, formal charge and the octet at every step; H and sigma bonds never move. The supported
  Lewis subset declines hypervalent changes and moves involving radicals. Mapping and attempted
  pushes share a 50,000-operation budget; exhaustion of this alternative-drawing proof records
  `undetermined` identity evidence and leaves an already measured silent difference as FAIL.
  Formula, net charge, atom count, isotope and radical changes never qualify.
  Changed tetrahedral or assigned double-bond stereo conservatively prevents this classification,
  including when a remote resonance change makes the stereo key differ. Missing evidence stays FAIL.
  Private `identityEvidence` records the standard-InChI result, fixed-H method, resonance result
  and deciding check, including rejected comparisons. Charge swaps on an unchanged indexed sigma
  graph are retained even when equivalent O atoms canonicalise to the same SMILES (carboxylate,
  nitro); aromaticity-canonicalised benzene Kekule forms remain PASS.
  Public reports give this outcome a separate table and rate, with `standard-inchi` and
  `electron-pair-resonance` method categories; both require the two proofs above. It never
  contributes to PASS or chemistry FAIL counts.
  Lost abbreviation drawings or display objects also produce this verdict, with private
  `classification: "drawing-object-loss"`; a ChemDraft warning that names the lost feature
  produces WARNED. Expanded molecular chemistry is still compared independently: an equal formula
  cannot excuse a changed species. These drawing losses do not claim a resonance identity proof.
- **ERROR:** a round-trip conversion or chemistry summary could not be completed.
  A bounded exact graph check that cannot finish also prevents PASS: private results
  retain `undetermined` feature checks, and public reports count these separately from
  chemistry failures. These checks yield ERROR only when there is no definite silent FAIL;
  conversion errors and incomplete chemistry summaries still yield ERROR.
  Equal connectivity/H values are accepted before sigma evidence;
  equal stereo-preserving RDKit canonical SMILES suppress connectivity and bond-order
  differences. Otherwise an exact element/charge/isotope/H/bond-order mapping is
  required to prove equality. Colour refinement only prunes that search.
- **SKIPPED:** no CDX support in this build; no conversion result is claimed for that route.
- **DRAWING-LOSS:** independent changes in arrows, brackets, text styling, colours, pages, or other
  graphics. A chemistry PASS can also have drawing loss. Geometry is not a pixel comparison.

`report.md` and `report.json` are shareable: only IDs, opaque groups, formats, year bands, counts,
rates, verdicts and category keys are emitted. Rates count files, deduplicated across comparison
routes; PASS rates exclude WARNED. Drawing rates use files with an import summary or a completed round trip.
Bracket summaries count pairs sharing a pair ID on the same page and count unpaired objects separately.
Survival counts use the source interchange tree as reference, including for the initial import,
for both CDXML and binary CDX. They count every resolvable arrow link per step (following
`SupersededBy`, rejecting missing or cyclic references), source nodes that create expanded
superatom records, and display objects by kind. Source abbreviation counting shares the importer's
structural expansion gate and follows only expanded descendants: an unsupported outer node hides
its inner labels, and a missing attachment, wrapper charge, excessive nesting or alternative-group
semantics prevents a record. One label classifier excludes R-groups and unknown-atom placeholders
(`*`) on both sides and includes nested groups.
Native abbreviations count standalone superatoms and molecule superatom metadata only.
Property-only nicknames, text-only `Unspecified` nodes and other label-only atoms are not superatom
records. Their labels still participate in molecular chemistry comparisons. External connection
points inside expansions never count. Display counts include grouped objects and every nested
bracket group; optional `displayObjectIds` records source IDs for every display kind. Each lost
object needs a separate warning naming its kind as a whole word (singular or plural); an
object-specific warning covers only its source ID. Bracket glyphs/groups with known IDs require
their own object-specific diagnostics. Legacy summaries without IDs use aggregate matching,
still requiring one diagnostic per lost object. Atom labels and hidden expansion graphics are
not standalone displays. Circle geometry remains a circle when export omits `OvalType="Circle"`.
Arrow elements and line graphics with arrow types or separate head/tail arrowheads share the
`arrow` display kind.
Legacy graphics with `SupersededBy` are excluded because their replacement is counted instead.
`stepArrows` is the total link count; `stepArrowLinks` retains counts in page/scheme/step order.
`stepIds` aligns those counts by source step ID, so skipped empty or unlinked steps cannot shift
the comparison. Comparisons check corresponding steps, so a gain in another step cannot offset a loss. Reports
show total links, `stepArrowLinksLost`, and `stepsWhoseArrowLinkWasLost` separately, including losses
in intermediate route legs that are restored later. Stored summaries without `stepArrowLinks`
retain their legacy aggregate comparison; rerun synthetic inputs to obtain per-step evidence.
Without stored step IDs a named diagnostic cannot establish which step lost a link, so rescoring
cannot excuse that loss; rerun synthetic inputs to obtain the IDs.

Private results retain `sourceSurvival`, native `summary.survival`, and `importComparison`.
The initial comparison contributes to the file verdict and report categories even when every
round trip preserves its already-lossy baseline. A lost step-arrow link is a reaction-structure
loss (`reaction-step-arrow`), FAIL unless a recognized warning names the step id and
`ReactionStepArrows`. This includes `cdxml.reaction_step_preserved` from older imports and
`cdxml.reaction_reference_unresolved`; generic preservation warnings do not excuse the loss.
Abbreviation or display loss alone
is DRAWN-DIFFERENTLY, or WARNED when named by a matching warning. Import warnings apply only to
the initial comparison; they never excuse a later round-trip loss. Rescore uses stored counts
to recompute this initial comparison without reopening any source file.

Both public reports include source counts, after-import counts, final counts for each measured
route, number lost, and files losing any for each metric (including each display kind).
JSON exposes `survival.source`, `survival.afterImport` and `survival.routes[route]`; each stage
has `filesMeasured`, `source`, `afterImport`, `after`, loss totals and per-metric file counts.
Route losses use the minimum count through initial import and every measured leg, so a restored
final count cannot hide an intermediate loss. Counts are relative to the source; these aggregate
counts cannot identify individual objects when counts happen to compensate. Missing legacy
survival data and skipped routes are excluded from measured-stage denominators.
Usage, repeat count, repeat unit, contained-object count and crossing-bond count are chemistry;
kind and label alone are drawing differences. Reports count pairs unchanged through every measured
leg of each route and files where a leg loses pairs. Legacy summaries without bracket data are
excluded from route survival counts.
The CDXML baseline section compares shared IDs' CDXML routes, flags worse chemistry verdicts or added drawing-loss
categories, and reports new IDs separately. Reports do not assert compatibility beyond their corpus.

Round-trip comparison pairs canonical identities (SMILES plus dummy labels), then
`compatibility.originalId` source identities. Remaining native
molecules are paired only when each is the other's unique closest candidate on the same page,
within one measured bond length (30 drawing units for an unbonded molecule), with identical
heavy-atom element multisets. Equal distances remain ambiguous. Native object IDs are used only
after geometry, since dropping a page object can shift those positional IDs. Residual molecules
without a matching native ID remain added/removed. Private differences for a best-match pair include element and visible atom-label
multiset additions/removals and net bond-count additions/removals. New summaries store the drawing
metadata needed for this pairing; legacy summaries without it retain the previous behavior during
rescore. Differences identify the affected molecule rather than
comparing aggregate feature counts. Every emitted difference passes a deep-equality invariant:
equal before/after values are dropped and counted in `comparisonInternalErrors`, also aggregated
in the public JSON report. Sanitization reasons are diagnostic metadata, not identity changes.
Before pairing, identical multisets of complete stored molecule chemistry summaries pass by
identity, excluding only object IDs and pairing geometry. Reaction and drawing checks still run.
`identityPasses` counts molecules across comparison legs, including legs in chained routes;
the private result records `chemistryPassReason: "identity"` when a leg used this shortcut.

`rescore --out <dir>` streams `private/results.jsonl`, recomputes comparisons with the current
comparator, and atomically replaces `private/results.rescored.jsonl`. It never reads or re-imports
source documents. Older summaries, including obsolete skeleton/ledger evidence, gain versioned
identity evidence from stored SMILES only; their measured
features are retained. Reports (including baseline reports) prefer the rescored file when present.
Rerun rescore after appending/resuming a run. Original results remain unchanged. Incomplete summaries
and conversion errors stay ERROR. New runs store per-leg summaries and warnings for chained routes;
legacy chained results contain only the final summary, so rescore can compare only baseline to final
and cannot reconstruct transient intermediate losses. A previously recorded unequal chained loss
cannot be cleared from final-state evidence alone: it becomes ERROR if the final comparison would
otherwise excuse it. It grants no warning exemptions on legacy chained comparisons. Older equal-value
diagnostics are counted as internal errors on rescore.
The error stage × category table (`errorCounts` in JSON) counts individual failure occurrences,
including truth errors, without messages, exception codes or stacks. Repeated failed invocations
on independent routes count separately; the top-level first-error alias is not counted twice.
The molecule sanitization table adds strict/non-strict counts and rates, fallback reason counts,
and RDKit rejection reason counts. Original molecules (`sanitization` in JSON) and all measured
round-trip summaries (`roundTripSanitization`) have separate denominators; existing tables remain.
Existing codec losses remain visible: synthetic CDX round trips currently lose some placeholder
labels, and unknown-order bonds become ordinary single bonds in both formats. These compare FAIL;
unchanged native/CDXML placeholder round trips compare PASS.

Ground truth accepts `<id>.smi` (one complete SMILES per nonblank line, no titles), `<id>.mol`,
and `<id>.sdf`. Each available format is compared as an independent multiset with RDKit canonical
identities, so reordered molecules match. A SMILES line may list explicit accepted alternatives
separated by ` || `, such as `N->B(F)(F)F || [NH3+][B-](F)(F)F`; either form matches that
one molecule. Dative and charge-separated forms are not otherwise normalized.

For ground truth only, a native SRU bracket pair's listed crossing bonds replace their outer
endpoint with `*`. The inner endpoint comes from source crossing data or atom membership, never
position. If the pair lacks enough data, it is left unchanged and the private result records
`sru.missing_crossing_data`. Existing results must be rerun to capture this projection; round-trip
chemistry always uses the original graph. If describing a projected molecule fails, its original
summary is retained with the private note `sru.projection_failed`. Missing and extra molecules remain mismatches even when
a near-miss can be classified. Private detail is in `private/groundtruth.jsonl`, one record per ID.
If several reference formats exist, each is compared independently; an ID agrees only when every
provided reference agrees. Top-level molecule counts describe the worst comparison and full details
remain under `comparisons`. Failed imports count as errors. Near-miss pairing is heuristic and never
counts as agreement. Reaction roles retain sorted multisets of canonical molecule SMILES for
reactants, products and agents, plus sorted exact native condition text (styled runs are already
concatenated by the importer). Explicit text participants instead use `{ kind: "text", text }`;
standalone superatom and R-group participants use their kind and label. Labelled molecular graphs
keep their canonical dummy-atom identity, including the labels. A molecule whose summary failed
retains its role as `{ kind: "unidentified", objectType: "molecule" }` and keeps its original
molecule summary error: incomplete chemistry still yields ERROR. No molecular identity is invented.
Reordering components is harmless;
swapping roles or replacing a component changes the summary. Native reactions have no arrow
references, so summaries retain document-wide arrow kinds beside each reaction.

`export-set` re-copies and re-hashes the original referenced by each selected ID, refuses changed
content, and writes ID-named visible CDX and CDXML exports. These contain private chemistry;
`--to` must resolve inside `<out>/private/` (for example `<out>/private/exports`). Public destinations,
symlinks and existing export files are refused. They are intended for local inspection in another program.

Synthetic verification:

```sh
pnpm vitest run --configLoader runner tools/cdx-compat-harness/features.test.ts tools/cdx-compat-harness/harness.test.ts tools/cdx-compat-harness/reactionSchemes.test.ts
pnpm vitest run --configLoader runner tools/cdx-compat-harness/truth.test.ts
pnpm vitest run --configLoader runner tools/cdx-compat-harness/supervision.test.ts
pnpm exec tsc --noEmit -p tools/cdx-compat-harness/tsconfig.json
```
