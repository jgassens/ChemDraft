# Plugin 3D chemistry (API 0.1.15)

Declare `apiVersion: "^0.1.15"` and `chemistry.compute`. The three methods are optional
for version skew and may be called only during the plugin's own command. No additional
permission is needed: RDKit runs in the existing conformer worker, without a subprocess.
The host terminates outstanding worker jobs when the command ends or the plugin unregisters.
Nothing in these methods reads or writes the active document.

```ts
const command: PluginCommandHandler = async context => {
  const chemistry = context.chemistry;
  if (!chemistry?.embed3d || !chemistry.minimize3d || !chemistry.flatten3d) {
    throw new Error("This command needs ChemDraft plugin API 0.1.15 3D chemistry.");
  }
  const embedded = await chemistry.embed3d({ components: [{ smiles: "CCO" }, { smiles: "O" }], seed: 42 });
  // A plugin may change embedded.model.coords to place the components. All graph data is immutable.
  const minimized = await chemistry.minimize3d({ model: embedded.model, forceField: "mmff94s", interfragment: true, maxIters: 2000 });
  if (minimized.clash) throw new Error("Clashing model; retry with another arrangement before insertion.");
  const flattened = await chemistry.flatten3d({ model: minimized.model, view: "auto" });
  // With document.write, insert these objects via the normal command-scoped documents.applyPatch.
  // Display/retain method and warnings beside any reported energies or distances.
};
```

Coordinates are finite Angstrom values in a right-handed, y-up frame, in stable atom order.
Each component is one connected input SMILES; components are embedded independently with explicit
hydrogens and laid out along +X with at least 4 A between their full atom extents. Limits are
1–8 components, 5,000 SMILES characters each, 500 heavy atoms total. Default seed is 42.
Spin 3D's actual adapter and shared candidate setting are used: 10-second attempts, `useRandomCoords` rescue for a
failed embed with at least 50 input atoms, and four candidates ranked with 50 MMFF94 steps
(two above 60 atoms; one above 120). The entire component has a hard 15-second worker deadline,
including retries and ranking. No OpenChemLib fallback or alternative chemistry is substituted.

Minimization defaults to MMFF94s with a total budget of 20,000 iterations, in passes of at most
1,000, stopping at convergence or setup failure. `iterationsBudget` is the sum of requested pass
budgets, not actual steps. Setup failure returns the input coordinates, `energy: null`, and a
warning; no alternative force field is substituted. The required boolean `interfragment` is
validated before RDKit's C++ `as_bool`, and forwarded as `ignoreInterfragInteractions = !interfragment`.
Minimization has a hard 60-second deadline. No geometry cache is used by the new path. Spin 3D's
refinement key and captured-refiner cache gate both include the interaction flag.
Incoming and minimized coordinates are read back through RDKit's 3D stereo assignment and compared
with only the tetrahedral parity and E/Z that each signed component explicitly specifies.
Unspecified centres/bonds are ignored. A reflected specified tetrahedron or flipped specified E/Z
bond is refused with the component number and one-based centre/bond, even if a force field could relax it.

Minimization also returns `clash: boolean` and, when present, `closestInterComponentHeavyAtomA`.
A contact below 2.2 A sets the flag and adds a specific warning even for a converged result.
Callers must screen starts and retry with another arrangement, never insert a clashing model.
Flattening recomputes this screen on the host after schema/token validation, before worker dispatch,
and again in the flatten helper. A clash is refused without starting a worker or loading RDKit,
with its distance and two global one-based atom indices/component numbers. Convergence alone
cannot rule out interpenetrating rings/chains. The caller remains responsible for retrying arrangements.

Each plugin has at most one running 3D call and eight waiting calls; excess calls fail with a busy
error. The app shares two lazy reusable plugin 3D workers. Queue time counts toward the work timeout;
embedding also has a total budget of 15 seconds per supplied component. Command end clears that
plugin's queue and cancels its running call. Timeout/cancellation destroys the affected worker;
successful calls retain the already-loaded RDKit instance.
Cold worker/module/WASM startup has a separate 30-second limit. A job-tagged readiness reply after
loading all job code and RDKit resumes both the worker-pool timer and the outer plugin-host timer
with their remaining work budgets. Queue time already spent is retained; progress/duplicate readiness
cannot extend a deadline. Waiting behind another call's startup is still queue time.

Each internal worker job has a session-unique id, echoed on every progress, timing, result and
error reply. The pool keeps one message handler per worker and accepts replies only for that
slot's active job id, so delayed replies cannot complete a later call after reuse or cancellation.
Spin/warmup messages use their separate protocol and cannot complete a plugin 3D call. The plugin
bridge also binds capability replies to their originating worker and command invocation, including
across worker restarts. Before returning a provider result to a plugin, the host validates the
method's full result shape and rejects malformed data with the method and offending field path.
These checks do not change the public API or version.

A random, non-extractable HMAC-SHA-256 key is created lazily once per app session. `modelToken`
authenticates normalized atoms, bonds, component ranges/input SMILES, and the embedding seed,
excluding coordinates. Tokens cannot be used in another session. Minimization returns the same
token. The host copies and validates input before awaiting verification, preventing mutation races.

`flattenNativeMolecule3d` was factored from `flattenSpunMolecule` in `documentWorkflow.ts`.
Both paths now use that pure helper for frame conversion, fixed `ScreenPlacement`, projection,
wedges/hashes, stereo reconciliation, depth styling, double-bond sides, and molfile serialization.
The document wrapper alone applies patches and replaces page crossing overrides. The helper uses
V3000 above V2000's 999-atom/bond limit so explicit Hs do not impose a smaller heavy-atom limit.
Plugin flattening uses 20 document px/A without page clipping. The native drawing retains input
atoms (including separate explicit H atoms in the input SMILES) and omits H atoms added only for the
3D model. References are depicted from the signed input graph, so removed H wedges are assigned to
heavy-atom bonds by the shared stereo reconciliation. Canonical-SMILES checks still normalize
removable Hs and must pass. Returned per-component depths are centered on the **retained atom
centroid**, then rotated z values in each native molecule's atom order, exactly as in `projectSpin`
on that retained graph; they are not indexed by the full explicit-H model.
The host places new objects from one `documents.applyPatch` together, using one translation per
page, centered on the visible page rectangle and clamped inside page bounds. This preparation and
selection happen before the single labelled history commit, on every run. Batches preserve their
relative geometry and do not move existing objects. A batch too large to fit the page is refused
atomically rather than clipped, reflowed or rescaled; choose a larger page before insertion.
When no visible rectangle can be measured, authored on-page positions are preserved; off-page
groups are still centered and clamped to the page.
The shared helper uses one linear bridge pass for ring membership and a conservative spatial grid
for crossing candidates, retaining the original ordering and exact intersection/depth calculation.
Stereo-free references skip unused RDKit 2D depiction; stereo references retain it. The result is
`{ objects, depthByAtom, method, warnings }`.

`view.rotation` is a finite row-major 3×3 orthonormal **proper** rotation (tolerance 1e-6,
determinant +1; reflections are refused). `auto` tries identity, then 30°, 60°, 120° about
[1,2,3], X, and Y, taking the first view that preserves every component's stereo identity.
The chosen rotation is returned in `method.viewRotation`. Flattening retains a hard 5-second work
deadline including queue time, excluding its separately bounded cold startup. See the measurements
below for why PEG8 does not justify an atom-count-dependent work deadline.
Every native result's canonical isomeric SMILES is compared with its component's input through
the app's RDKit adapter, explicitly normalizing removable Hs on both sides. The current native atom
schema has no isotope mass field (its `chemistry.isotopeLabels` is molecule-level metadata), so
isotopic components are refused before depiction or view search with the component's input SMILES
and isotope labels. Embedding/minimization still preserve them.
References come from the signed input after a separate 3D stereo check, so an unspecified centre
cannot acquire a wedge/hash. Double bonds that RDKit perceives as stereogenic but whose E/Z is
unspecified in the signed SMILES become native `stereo: "either"` bonds. Their MOL representation
keeps the either marker, so projecting coordinates never assigns E/Z. Specified E/Z must survive
projection and canonical read-back. Carbonyls, terminal or symmetric alkenes, small-ring double
bonds, aromatic bonds, and the symmetric TTF central double bond receive no open-stereo flag.
Page crossing overrides are not document objects: when needed, a warning explains their omission.

Every result carries the pinned engine, ETKDGv3 seed, field/variant (or `none` when this call
does not minimize), interaction mode, units and these conventions:

> nonbonded cutoff 10 A, gas phase, no counterions or solvent; energies rank starting geometries
> only and are not binding energies; a local minimum, not an equilibrium structure

No counterions or solvent are added. Flattening does not run a force field; its field `none` and
interaction mode `off` describe that call, not the optimization history of plugin-edited coordinates.

## Refusal messages

Schema failures include the offending field path. Besides standard strict-Zod type, size, unknown-key,
integer and range errors, the explicit schema and host refusals are:

- `3D model coordinates must all be finite numbers.`
- `3D model coordinates length must equal 3 times its atom count.`
- `3D chemistry accepts at most 500 heavy atoms total.`
- `3D model component ranges must partition the atoms in component order.`
- `3D model bonds must join distinct atoms within one component.`
- `minimize3d interfragment must be a boolean (true or false).`
- `minimize3d interfragment:true requires more than one component.`
- `flatten3d rotation must be an orthonormal 3x3 proper rotation (determinant +1).`
- `3D modelToken is invalid for this app session or the atoms, bonds, or components were changed; only coordinates may be edited.`
- `Plugin "<id>" may call chemistry.<method> only while one of its own commands is executing.`
- `chemistry.<method> cancelled because the plugin command ended.`
- `Plugin "<id>" 3D chemistry is busy: at most 1 running call and 8 queued calls are allowed.`
- `<method> timed out after <seconds> seconds including queue time.`
- `<method> worker startup timed out after 30 seconds.`
- `3D chemistry worker pool is closed.` (internal transport teardown)
- `This host provides no 3D embedding engine.` / `This host provides no 3D minimization engine.` / `This host provides no 3D flattening engine.`
- `<method> worker failed: <worker error>`
- `chemistry.<method> returned an invalid result at <field path>: <validation error>`
- `<context>: RDKit could not parse the structure.` (context names the component or operation)
- `Component <n>: the structure has no atoms.`
- `Component <n>: each SMILES must describe one connected component.`
- `3D embedding timed out after 15 seconds for a component.`
- `RDKit explicit-hydrogen generation is unavailable.`
- `RDKit ETKDGv3 found no 3D conformer (or timed out), including the useRandomCoords retry where applicable.` (with the adapter's specific warnings when available)
- `3D embedding returned an invalid molecular graph.`
- `Component <n>: 3D chemistry cannot represent a query or dummy atom.`
- `Component <n>: 3D chemistry cannot preserve bond order <order>.`
- `Component <n>: RDKit returned invalid 3D coordinates.`
- `3D chemistry cannot preserve more than two radical electrons on an atom.`
- `RDKit returned an invalid force-field status.`
- `RDKit minimization returned invalid 3D coordinates.`
- `Component <n>: RDKit could not read back <minimize3d input|minimize3d result|flatten3d input> stereochemistry.`
- `Component <n>: <minimize3d input|minimize3d result|flatten3d input> would change specified tetrahedral stereo at centre <atom>; restore the input geometry.`
- `Component <n>: <minimize3d input|minimize3d result|flatten3d input> would change specified E/Z stereo at bond <a>-<b>; restore the input geometry.`
- `Component <n> (<SMILES>) carries isotope labels (<labels>), which ChemDraft drawings cannot store yet; flatten3d refuses rather than drop them.`
- `RDKit could not perceive potential double-bond stereochemistry.`
- `RDKit could not read the signed component SMILES.`
- `RDKit could not read the explicit-hydrogen input.`
- `RDKit could not read back the flattened structure.`
- `RDKit canonical stereo SMILES is unavailable.`
- `RDKit could not perceive flattened stereochemistry.`
- `Component <n>: RDKit 2D stereo depiction is unavailable.`
- `Component <n>: RDKit changed the atom count while preparing flatten3d.`
- `Component <n>: flatten3d refused this view: <shared Spin 3D refusal reasons>`
- `Component <n>: flatten3d would change canonical SMILES with stereochemistry (expected <input>, got <output>); choose another view or restore the input geometry.`
- `Plugin insertion is larger than the page; choose a larger page or a smaller drawing before inserting.` (document write refusal)

RDKit loading/parsing/binding failures and the shared Spin 3D constraints retain their specific engine
messages. Plugin permission and worker-bridge errors retain the existing host messages.

The API's public usage sequence is in `docs/plugin-architecture/AUTHORING.md`.

## Warm flatten deadline measurement (2026-10-27)

`CHEMDRAFT_PROFILE_FLATTEN_3D=1 pnpm vitest run apps/desktop/src/chemistry3d/flattenPerformance.test.ts --no-cache`
measures production flatten calls on the vendored WASM in Node, after a warm-up call, with seven
samples each. Fixtures are seed-42 independently embedded, separated CBPQT4+ and TTF with four PEG
arms; contact screening confirms non-clashing coordinates. No force field runs during measurement.
On Apple M1 Pro, arm64 Node v26.9.0 (load averages 10.6/16.1/19.3):

| Fixture | Full model atoms | Native atoms | Minimum | Median | Maximum |
| --- | ---: | ---: | ---: | ---: | ---: |
| PEG2 | 170 | 86 | 20.66 ms | 27.44 ms | 31.33 ms |
| PEG8 | 338 | 158 | 63.03 ms | 64.01 ms | 67.79 ms |

Recommendation: retain 5 seconds for warm flatten; these PEG8 samples have over 70x compute
headroom. Remove cold initialization from that budget instead of scaling it by explicit-H count.
These are Node compute measurements, not packaged WKWebView/WebView2 or all 500-heavy-atom/stereo
cases. Repeat there before broadening this recommendation; queue congestion can still time out.

## Opt-in profiling

`CHEMDRAFT_PROFILE_CLASH_3D=1 pnpm vitest run --configLoader runner --no-cache apps/desktop/src/chemistry3d/clashPerformance.test.ts`
runs PEG2/PEG8 against the real vendored WASM in a reusable Node worker. It prints tables plus raw
events: cold asset read/compile/init, component embeds, every ETKDG attempt's seed/random-coordinate
flag/success, candidate scoring, every minimization pass, parse time, flattening and roundtrip
residuals. The Node worker uses local assets rather than Tauri fetch; the cold residual includes
worker startup/module dispatch, and warm residuals include structured clone and timing-message cost.
It checks that WASM initializes only once. Centred PEG8 is retried beyond convergence and compared
with a single long pass and a separated start. No production timeout is extended or disabled;
the diagnostic protocol runner itself is not a desktop deadline enforcement test.

`VITE_CHEMDRAFT_PROFILE_3D=1` at desktop dev/build time enables the same events through the real
conformer-worker transport (`[chemistry3d timing]` in the host console), including host queue,
synchronous `postMessage`, roundtrip and worker load/compute times. Tests may instead pass
`createConformerWorkerPool({ onTiming })`. With profiling off there are no profiling clocks, binding wrappers,
timing messages or logs. See `PERFORMANCE.md` for measured results and limitations.

When the existing agent-bridge switch is enabled, `[chemistry3d reply]` records metadata-only worker-pool
and plugin-bridge replies for diagnosing late or stale 3D calls. It includes ids, method names, status and
top-level result keys only; it never includes structures, coordinates, or other result contents.
