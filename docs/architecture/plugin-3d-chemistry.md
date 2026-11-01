# Plugin 3D chemistry

Plugin API 0.1.15 provides command-scoped 3D chemistry through optional
`context.chemistry.embed3d`, `minimize3d`, and `flatten3d` methods. A plugin receives them only
when it declares `chemistry.compute`; no new permission is involved. The host runs all three in its
in-process RDKit WASM worker, so the capability starts no process and performs no network access.
Calls are valid only while the plugin's own command is active and are cancelled when that command
ends.

`embed3d` runs ETKDGv3 with explicit hydrogens for each of 1–8 supplied SMILES components (seed 42
by default), then places the components side by side. It accepts at most 5,000 characters per SMILES
and 500 heavy atoms total, and has a total timeout of 15 seconds multiplied by the supplied component
count, including queue time. A plugin arranges the resulting
components itself, for example by moving a guest's coordinates relative to a host. Its result is
`{ model, method, warnings }`.

The model has a host-signed `modelToken` over its atoms and bonds. The worker accepts plugin-edited
coordinates, but validates the token so a plugin cannot change the chemical graph. `minimize3d` has
a 60-second timeout and supports `mmff94s` (default), `mmff94`, and `uff`, with an iteration budget
of at most 20,000. Its required `interfragment` flag includes forces between components when true;
that mode is refused for a single component. It returns `{ model, forceField,
clash, closestInterComponentHeavyAtomA?, method, warnings }`; `forceField` includes the field name, status,
energy, and `iterationsBudget`. Its status is `converged`, `not-converged`, or `setup-failed`.
`closestInterComponentHeavyAtomA` is a distance in Angstrom. Incoming and minimized 3D geometry
is read back through RDKit. Only tetrahedral centres and double bonds explicitly specified in the
signed input constrain the geometry; unspecified sites are ignored. Local tetrahedral parity and
cis/trans reference ligands are compared in stable atom order, so symmetry and neighbouring
unspecified sites cannot create a false CIP mismatch. A mismatch names the component and site:
`Component <n>: minimize3d <input|result> would change specified tetrahedral stereo at centre <atom>; restore the input geometry.`
or `Component <n>: minimize3d <input|result> would change specified E/Z stereo at bond <a>-<b>; restore the input geometry.`
Atom numbers are one-based within the component.

The boolean `clash` is true when the closest inter-component heavy-atom distance is below 2.2 A,
regardless of convergence, field setup status, or `interfragment`. Single-component models return
false and omit the distance. A clash always adds a warning identifying the distance, elements,
global one-based atom indices, and one-based component numbers. Callers must not insert a clashing
model: screen starting arrangements and retry with another arrangement. Local minimization cannot
guarantee an escape from interpenetrating loops or chains threaded through ring bonds.
Flattening recomputes the contact from the supplied coordinates on the host after token validation,
before worker dispatch (no cold worker or WASM is needed), and again in the worker helper. It refuses independently,
even when a plugin ignores the result flag or edits a previously clean model:
`flatten3d refused a clashing model: closest inter-component heavy-atom contact is 1.850 A between C atom 1 (component 1) and O atom 10 (component 2); below 2.2 A. Retry with another arrangement.`
This is a contact screen, not proof that an arrangement above the threshold is physically valid.

`flatten3d` has a 5-second work/queue timeout, excluding bounded cold startup, and accepts either an orthonormal row-major 3×3 rotation or
`"auto"`. It uses the shared Spin 3D flattening math to create one native molecule per component,
with 2D coordinates, wedges/hashes only at input-specified centres, depth by atom, and warnings.
It checks incoming geometry with the same input-specified stereo rule (phase `flatten3d input`).
Unspecified tetrahedral sites receive no wedge/hash. Specified stereo must survive the final
canonical isomeric SMILES read-back exactly.

Native bonds preserve open E/Z as `stereo: "either"`. `flatten3d` maps each double bond that RDKit
perceives as stereogenic but whose E/Z is unspecified in signed input SMILES to that flag.
The check uses a temporary CXSMILES cis tag on
each candidate and RDKit's stereo cleanup to test whether the bond supports E/Z. RDKit's SMILES
traversal maps preserve input indices across ring closures. No depiction or plugin-edited coordinates
are used for this perception. Endpoint pairs carry the result through molblock bond reordering.
Carbonyls, terminal and symmetric alkenes, small-ring double bonds, aromatic rings, and symmetric
TTF central double bonds receive no either flag. Embedding and minimization also accept unspecified E/Z.

Native atoms cannot store isotope mass labels. Before depiction or view search, isotopic components
fail specifically, for example:
`Component 1 ([13CH3]CO) carries isotope labels (13C), which ChemDraft drawings cannot store yet; flatten3d refuses rather than drop them.`
Embedding and minimization still preserve isotopes in the 3D model. The worker returns objects only:
a plugin with
`document.write` inserts them with `documents.applyPatch`, making that command one labelled undo
entry per call, including a batch. The result is `{ objects, depthByAtom, method, warnings }`.
Returned molecule frames use the shared SMILES-paste geometry helper, including its horizontal
and vertical atom-label padding. This frame normalization does not change atoms or `depthByAtom`.
For placement, the host measures each molecule by the union of its frame and atom extents, so
plugin-supplied frames that omit atoms cannot leave those atoms outside the page after translation.
Other object types keep their existing bounds; the same union determines whether a group is in-page.
The host leaves inserted groups whose combined bounds are fully inside the page at their authored
positions. Groups overlapping the page but extending beyond it are translated by the smallest offset
that brings the whole group inside. Groups entirely outside the page are translated as a whole to
the visible page center, clamped inside page bounds, before committing. Groups referencing any
pre-existing document object, including atom-anchored charges and arrows, are never moved.
Changed objects stay selected; placement needs
no second history entry. Only groups needing translation are refused as larger than the page, atomically with
`Plugin insertion is larger than the page; choose a larger page or a smaller drawing before inserting.`
No existing objects move and no component is independently reflowed or rescaled.
Object-id collisions are allocated before insertion references are remapped, so native self and
forward references resolve to the new batch members. This includes superatom/R-group attachment
points, arrow and mark anchors, reaction links, bracket/group/annotation targets, labels and
structured warning references. Atom and bond ids remain molecule-local and unchanged, as do
opaque metadata and source provenance ids. Attachment points to rebased batch members do not
count as anchors to pre-existing objects.

Flattening builds its reference from the signed input graph, retaining input-explicit H atoms and
omitting model-added Hs before depiction/projection. RDKit and shared Spin reconciliation choose
wedges on the retained graph; the existing canonical isomeric SMILES round trip remains mandatory.
`depthByAtom` follows each returned native molecule's retained atom order, centered on its retained
atom centroid before rotation, in Angstrom; it no longer follows the full explicit-H model order.

The host allows one in-flight 3D call per plugin and eight waiting calls. Further calls fail with
`Plugin "<id>" 3D chemistry is busy: at most 1 running call and 8 queued calls are allowed.`
Queue time counts toward the call deadline, including a total embedding budget of 15 seconds
per supplied component. A host queue timeout reports `<method> timed out after <seconds> seconds
including queue time.` Command end clears that plugin's queue as well as cancelling its active
request. Two lazy reusable RDKit workers serve plugin 3D calls app-wide; timeout/cancellation
terminates the affected worker, while successful calls reuse the loaded WASM engine.
Cold module/worker/WASM initialization has a separate 30-second budget. A job-tagged readiness
message after all lazy job code and RDKit load resumes **both** outer plugin admission and worker
pool timers with their remaining work budgets. Queue time before assignment is retained; duplicate
readiness and progress cannot reset it. Startup expiry reports
`<method> worker startup timed out after 30 seconds.`. Queueing behind another job's startup still counts.

Warm flatten measurements after H removal (Apple M1 Pro, arm64 Node v26.9.0, vendored WASM,
seven samples after warm-up, non-clashing separated seed-42 geometries): PEG2, 170 model/86 native
atoms, 20.66–31.33 ms (median 27.44); PEG8, 338 model/158 native atoms, 63.03–67.79 ms (median 64.01).
Keep the fixed five-second work limit for PEG8 rather than scaling by atom count: measured compute
has over 70x headroom. This does not verify WebView startup or every maximum-size/stereo case.
The reproducible command and fixture details are in the chemistry3d README.

## Host and caller responsibilities

Placement is a host responsibility. Flattening is document-independent and its origin-centered
coordinates are not page placement. The direct-write path prepares insertion, any needed group
translation and selection together before its one labelled history commit. In-page inserts and
groups anchored to pre-existing objects keep their authored placement. The same off-page batch inserted twice is
covered by mounted MainWindow tests with macOS and Windows shortcut detection, including viewport
bounds, unchanged component offsets, selection, labelled Undo and exact Redo.

The write-path inspection found only one history commit per `applyPatch`: the chem-core batch and
selection patches do not push history themselves, and neither commit normalization nor a
post-insert fit/centering/reflow effect issues another move. The original packaged run's additional
unlabelled entry has therefore **not been attributed to a specific issuer**. It should be rerun on
this build with the original caller; the automated regression does not establish what issued that
earlier entry. Do not ascribe it to the plugin without a command trace.

The timeout masking a clash was a host boundary defect: RDKit initialization preceded the worker's
contact check, while both admission and worker timers charged that initialization to flatten's five
seconds. Host-side contact screening and bounded startup/readiness now cover it. The caller's
deliberate decision to continue after `clash: true` is a separate negative control; production callers
must retry/refuse that arrangement. Model placement relative to other components and escape from
ring/chain interpenetration also remain the caller's responsibility.

Drawing every generated H was a host flatten defect: the reference used `inputWithHydrogens` and
all model coordinates despite the signed `addedHydrogen` flags. The reference now uses the signed
input graph and the retained coordinate subset, with input-explicit H, stereo and SMILES checks
preserved. No calling-plugin code or plugin API shape/version changes are required.

The native either flag and its CTAB encoding both survive flattening, selection read-back and MOL
copy. Spin 3D shares the flatten helper: open `CC=CC` remains open; a projection changing specified
E/Z is refused. Tetrahedral read-back checks assigned and open sites after wedge reconciliation.

Every result carries the method contract: RDKit MinimalLib Release_2026_03_3 + patches 0001-0008;
ETKDGv3 seed; force field; nonbonded cutoff 10 A; gas phase; no counterions or solvent; energies rank
starting geometries only and are not binding energies; a local minimum, not an equilibrium structure.
Plugins must not present energy as meaningful. Single molecules should use normal 2D
`structureFromSmiles` layout instead of paying for 3D minimization.

## Cutoff decision

The nonbonded cutoff is 10 A. At the same geometry, a 10 A versus 100 A MMFF cutoff changed a +4
host–guest complex's energy by 68–102 kcal/mol while the shapes held. In vacuum without counterions,
neither cutoff is more correct. The energy is therefore useful only to rank starting geometries, not
as a binding energy or other meaningful user-facing value.

The [PEG2/PEG8 investigation](../../apps/desktop/src/chemistry3d/PERFORMANCE.md) records the real-WASM
ring-piercing clash reproduction, cutoff effects, timing tables, instrumentation flags, and deadline
headroom assessment. Neither optimizer convergence nor a 10 A cutoff guarantees a clash-free model.
