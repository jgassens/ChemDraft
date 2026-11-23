# Send to Crystal Builder: plugin plan

Status: plan approved by the owner 2026-11-10; revised 2026-11-20 for the one-command build and the
return trip (owner direction below), and again the same afternoon after the hand-built "MOF-5" turned
out to be the wrong structure because it was built on one cell (see "MOF-5 correctness" under Test
results; open question 9, now answered). The new `runCompanion` method widens the security contract, so the
master session's OK and the Kimi review (condition 3) cover it too. The master session OKed the revised plan, including the `runCompanion` security contract scoped to official catalog plugins (2026-11-20); the usual gates apply when code starts. Questions 1–10 are answered (2026-11-20); questions 11 and 12 were answered by the owner overnight 2026-11-21. **Kimi plan review: PASS on 2026-11-22** (`run-20261122-120216-0753a8`, after two revisions; see "Kimi plan review (2026-11-21)", next section). The plan is approved; code waits for ChemDraft 1.2.2 to ship and then starts as a **1.2.3** slice (owner, 2026-11-23). Target: after ChemDraft 1.2.2 ships (1.2.x has priority; nothing here touches
`release/1.2-rc` or `main`). Final home of this document: `docs/plans/send-to-crystal-builder.md` on
local branch `plan/crystal-builder` (see "After approval").

## Master session conditions (2026-11-10)

Approved in principle, with these conditions:

1. **No code until 1.2.2 ships** (master session, 2026-11-20). This is 1.2.3 work (owner, 2026-11-23; was 1.3). Main is already at
   plugin API 0.1.26 (request-bound tools, PR #418), so this capability takes the **next patch
   version, 0.1.27 as of main 8125b66a**; the worker re-reads `PluginApiVersion` when Phase 1 starts.
2. ~~**Build phase runs from a MacBook session.**~~ **Changed (owner, 2026-11-20): workers run on the
   Intel iMac** through agentctl, installed there 2026-11-20 (smoke test: run `imac-smoke-0-3`).
3. **Before any code:** one Kimi high review of this plan, after the 1.2 big review, focused on the
   `apps.handoff` security contract: user consent, no path or argument injection, the app picked by
   the user and never by the plugin, and macOS/Windows parity.
   **Consent: resolved, pending Kimi** (master, 2026-11-10). One-time consent per plugin and app is
   accepted, provided (a) every handoff still comes only from a user-started command; (b) the consent
   is listed and revocable in Preferences or the plugin's settings; (c) a different app, or a changed
   app path or bundle ID, asks again; (d) the loss message box shows every time something specific
   would be lost (the "Warn before send" rows in Decision 1); losses inherent to every 3D file
   (layout, labels, colors, implicit hydrogens made explicit, the vacuum box) are always disclosed
   in the consent box, the status line after each send, and the file, with no extra box and no
   checkbox or opt-out (amended 2026-11-22 to match owner question 12). This settles owner question 2.
4. **Keep §7:** the handoff warns about or refuses charge, stereo, and abbreviation loss, per the
   table in Decision 1.

## Owner direction (2026-11-20): one click, and a way back

After a hand-run demo (terephthalic acid and a Zn₄O core drawn in ChemDraft 1.2.1, built into a
Zn₄O–terephthalate pcu framework in Crystal Builder that was later found not to be MOF-5; see the 2026-11-20 row under "Test results"), the owner asked for two changes:

1. **Much more automated.** The demo took about ten manual steps: draw `X` atoms, embed 3D, write a
   CIF, open it, save a building block, open the MOF builder, pick net, node and linker, build. The
   target is **one command**: select the drawn acid (and, optionally, the drawn metal ions), choose
   **Build MOF in Crystal Builder…**, confirm the suggested net and node, and the finished framework
   opens in Crystal Builder's window. Decision 1b (automatic cut), Decision 3 (`runCompanion`), and
   task 2H carry this.
2. **The reverse must be possible, and comes last.** Export a MOF unit cell from Crystal Builder and
   bring it into ChemDraft as a 3D object that can be moved and rotated on the page. This is Phase 5,
   scheduled after the one-click send ships. It needs a new native object in `chem-core` and touches
   the charter's "3D molecular visualization" non-goal (PLAN.md §5), which the owner lifted for this object on 2026-11-20 (question 7).

## Kimi plan review (2026-11-21)

`kimi-k3` (K3.1 Pro, effort high), read-only, on `c6f5977e` (agentctl run
`run-20261121-161757-0048e5`, dispatched by the master session from the MacBook; the first try,
`cb-plan-kimi-review`, stalled with no verdict). Verdict: **not ready for Phase 1 as written.** It
checked code at the plan branch's old base (API 0.1.20), so its line references are to that commit;
the conductor re-checked the main claims on `origin/main` (2026-11-21): the bridge's `command()` does
go through the same `host.command` as the app's UI and its `click()` synthesizes pointer events; the
selection carries only a molfile while `embed3d` takes only SMILES; the only plugin dialog is
`promptText`. Each finding and where it is handled:

| Finding | Severity | Handled in |
|---|---|---|
| `runCompanion` official-only was decided but never enforced | Blocker | Rule 13; task 1B; install provenance in 1D |
| No forgery-proof user action (shared dispatcher, synthetic bridge clicks) | Blocker | Rule 2 (separate entry point, `isTrusted`, Rust one-shot token); task 1B tests; 1C mint and check |
| Target check named a twist angle nothing measures | Blocker | Decision 1b target record now uses only reported numbers; "matches the target checks" wording |
| Material names from proxies ("MOF-5 family", any tritopic → HKUST-1) | Blocker | Suggestion table: MOF-5 for terephthalate only, others unnamed, HKUST-1 row disabled |
| `bb_dir` needs bonded XYZ, but only a CIF writer was planned | Blocker | Task 2B2 |
| No task owned molfile parsing and SMILES for `embed3d` | Blocker | Task 1G (host graph, RDKit, `embed3d` graph input); the plugin parses nothing |
| Regex params and substitution do not stop option or path injection | Important | Rule 11 (enum only, no `-`/`@`/separators); host placeholders only for paths |
| Inputs, stderr, timeouts, environment unbounded | Important | Rule 15 |
| Consent row had no template digest | Important | Rule 5 `templateDigest`, checked every call |
| Errors promised no paths but quoted one | Important | Rule 8 |
| App-change check spoofable; no Windows identity | Important | Rule 6 (hashes, signing identity, re-check before launch) |
| Code claims not verified on the target commit | Important | Task 0.5; 0.1.27 marked provisional |
| Repeat retry and question 11 unresolved, not fail closed | Important | Decision 1b rule (fail closed, Rebuild button); task 1H; question 11 |
| Automatic cut active for any node | Important | Decision 1b, task 2C3: cut only for N16, N17 |
| Loss audit impossible from the molfile alone | Important | Task 1G audit; Decision 1 table |
| Minimization states `not-converged` and `clash` missing | Important | Decision 1 table; task 2C |
| Master condition 3(d) vs inherent losses | Important | Question 12 |
| Input stem and edge name could disagree or collide | Important | Rule 7 reserved stem, `{inputStem}`; one input |
| Windows `.lnk` unclear; junctions not covered | Important | Decision 2 (refuse `.lnk`); rule 11 |
| Version pinning had no step; `inspect` order ambiguous | Important | Rule 14 pipeline (preflight, build, inspect) |
| No native dialog for net, node, repeat | Important | Task 1H (host confirmation dialog) |
| Consent lifecycle and manifest ownership gaps | Important | Task 1D owns install and update files; task 2A owns the final manifest |
| No source for a full node list; HKUST-1 untested | Important | Dialog offers validated rows only; HKUST-1 row disabled |
| Task 2G put layout math in the plugin (§9) | Important | Task 1G `suggestConnectionPoints`; task 2G |
| Phase 5 readback and raw CIF claims | Important | Tasks 5D, 5E |
| Failure result had no stdout; exit-code behavior unclear | Important | API `diagnostic`; rule 14 |
| Missing owned files (`package.json`, `workerProtocol.ts`, `build.rs`, AGENTS.md list) | Important | Tasks 1A, 1C, 1E |
| Windows consent-file ACL deferred | Minor | Rule 5 (owner-only DACL through `windows-sys`) |
| Stale X-handling text; "undocumented" bundle id; header; 2G "optional"; menu list; "learns nothing"; 0.4 text; Phase 3 stamp | Minor | Fixed in place |

**Re-review, 2026-11-21** (`run-20261121-172852-773bcb`, on `0b5a076b`): REVISE. Resolved: the
official-plugin gate, the bonded XYZ writer, the `embed3d` input, and question 11's design. Fixed in
this revision:

| Finding | Severity | Handled in |
|---|---|---|
| Renderer `isTrusted` then IPC mint: any IPC-capable code could mint | Blocker | Rule 2: only Rust-seen events start handoff commands; no renderer mint; Worker-only plugins; mint-from-IPC test |
| Every call burned the token, breaking `status` → `chooseApp` → send | Major | Rule 2: only the send consumes it |
| Disabled N17/tbo still reachable through separate enums | Major | Manifest `combinations`: one validated choice; N17/tbo not declared |
| Rebuild from a dialog window could not mint (main window only) | Major | Rule 2 (b) and task 1H: boxes shown from Rust; Rust mints on the click |
| Rebuild not tied to the original input | Major | Rule 16 result session; task 1H tests |
| MOF-5 named outright; no topology check | Partly resolved | Target record adds net agreement and the detected net from the build; every user-facing mention says "matches the MOF-5 target checks" |

**Re-check, 2026-11-22** (`run-20261122-114026-eb9e59`, on `41f889f5`): REVISE. All six findings
above closed. Fixed in this revision:

| Finding | Severity | Handled in |
|---|---|---|
| Rule 2 admitted renderer code could observe and race a live token | Major | Rule 2: no credential reaches the renderer; Rust-held arming; one `app_handoff_call` endpoint with no token field; races refused; credential tests. Rule 16: Rebuild runs in Rust. Tasks 1B, 1C, 1H |

## Context

Crystal Builder (github.com/JulesOpp/Crystal-Builder, MIT, Python/PySide6/VTK) builds crystals and
MOFs. ChemDraft draws the molecules that go into them. The owner wants a one-click "send what I drew
to Crystal Builder" that is fun, useful, and a good demo for the owner's perspective article (the owner's alone;
Crystal Builder's author is not a coauthor, owner 2026-11-18): draw a linker in ChemDraft, click once, build the framework in Crystal Builder.

**What Crystal Builder is for** (its README): opening and cleaning up crystal structures (symmetry,
bonds, missing hydrogens); assembling MOFs from a net, a node, and a linker (vendored PORMAKE), after
"Mark connection points" turns a molecule into a building block; filling pores with guest molecules;
force-field and quick quantum relaxation (UFF4MOF, xTB, DFTB+, ML potentials); powder diffraction;
export to simulation codes. A ChemDraft user draws one molecule, not a crystal, so that molecule is
useful there in two roles, and the plugin offers both (Decision 1b):

- **As a MOF linker** (the main feature and the article demo), with its connection points marked
  in ChemDraft before sending.
- **As a molecule** (guest, solvent, anything else), sent as plain 3D coordinates.

Two facts shape everything:

1. **ChemDraft plugins cannot start another app today.** The only process-spawning capability is
   `context.tools`, which is hard-wired to two AI command-line tools. So this needs one new, small,
   general host capability first. The plugin itself is then short.
2. **Crystal Builder's doors, from its README and docs:** it opens files (`crystal-builder file.cif`,
   drag-and-drop; registers `.cif` and `.xtalproj` only, not `.xyz`); its `xtal` CLI inspects and
   converts but has no "load this into the open window" command; its window MCP server is opt-in, off
   by default, on `127.0.0.1:7781` with a per-launch bearer token in a discovery file. SMILES is
   accepted only through a GUI command that needs its optional RDKit extra. Builds are ad-hoc signed
   (macOS) or unsigned. The bundle identifier is `org.crystalbuilder.CrystalBuilder` (test A3); the host
   never hard-codes it: it reads the identifier from the app the user picked and uses it only for
   change detection, never to find the app.

## Decision 1: what to send

**Recommendation (revised 2026-11-18 after reading Crystal Builder's source): a CIF holding one
molecule in a P1 vacuum box, with Crystal Builder's own bond table.** Coordinates come from the
host's existing `chemistry.embed3d` (RDKit ETKDGv3, seed 42) followed by `chemistry.minimize3d`
(MMFF94s, `interfragment: false`). One file per send.

Why a bonded CIF:

- **It carries bonds, including bonds to `X`.** Crystal Builder never guesses a bond to `X`
  (`xtal/core/bonding.py`: `X` is its one dummy element, and distance perception skips dummies on
  purpose). A drawn bond is kept, though, and its CIF reader (`xtal/io/cif_reader.py`, `read_bonds`)
  takes a `_geom_bond` loop as the bond graph when the loop has the `_xtal_bond_kind` column, which is
  what its own writer emits. XYZ has no bonds, so an `X` arrives floating and the linker cannot be
  saved as a building block. Tested both ways below.
- **It carries bond orders** (`_xtal_bond_order`), so the bond-order loss in the old XYZ plan is gone.
- **`.cif` is a registered document type** on Crystal Builder, so double-click and "open with" work
  the normal way.
- **The box is not invented crystallography.** It is the same thing Crystal Builder does to any
  cell-less molecule: P1, 5 Å of vacuum on each side (`xtal/io/xyz.py`, `_padded_box`). The file says
  so in `_audit_creation_method` and a comment: `isolated molecule in a vacuum box, not a crystal
  structure`.

Format, matching Crystal Builder 1.1.1's writer: cell lengths, angles 90°, `P 1`, one symop
`x,y,z`; an `_atom_site` loop (label, type symbol, fractional x y z) with unique labels; then

```
loop_
_geom_bond_atom_site_label_1
_geom_bond_atom_site_label_2
_geom_bond_site_symmetry_2
_xtal_bond_order
_xtal_bond_kind
C1 C2 1_555 1.500 explicit
C2 X11 1_555 1.000 explicit
```

Risk: `_xtal_bond_*` are Crystal Builder's private tags, read from source, not a documented contract.
A later release could change them. The plugin keeps a fixture test of the exact text, and the
hands-on list re-checks it against each new Crystal Builder release. A plain `_geom_bond` loop
without `_xtal_bond_kind` is ignored by design (it is usually a distance table), so the tag is required.

Why not the others:

- **XYZ**: no bonds; `X` atoms come in unbonded, and the window refuses to save the linker. It is
  still fine headlessly (`bb_dir`), but the one-click demo is in the window.
- **SMILES**: no documented file or CLI route into Crystal Builder; it would depend on an optional
  extra on the user's install, and Crystal Builder would redo the 3D embedding out of our sight.

Provenance goes in CIF comment lines and `_audit_*` items: source SMILES, net charge, `ETKDGv3 seed
42; MMFF94s; gas-phase local minimum, not a crystal structure`, and the ChemDraft version.

### What is lost, and how the user is told (AGENTS.md §7)

| Item | What happens in the CIF | Handling |
|---|---|---|
| Bonds and bond orders | Kept in the bond table (aromatic bonds as order 1.5) | None needed |
| Vacuum box | A P1 box with 5 Å of vacuum, as Crystal Builder makes for any molecule | Always disclosed in the file and the status line: not a crystal structure |
| 2D layout, labels, text, colors | Dropped | Always disclosed (same places) |
| Implicit hydrogens | Become explicit atoms | Always disclosed |
| Formal charges | Per-atom charges not stored; net charge goes in the comment line | **Warn before send**, naming the atoms |
| Isotope labels | Not stored | **Warn before send**, naming them |
| Radicals | Not stored | **Warn before send** |
| Stereo flags (wedges, E/Z) | Specified stereo survives only as geometry. Unspecified centers and "either" bonds get one arbitrary 3D configuration | **Warn before send** when anything is unspecified, counting the centers and bonds. RDKit perceives them in the host (task 1G); the plugin does not parse stereo |
| Several molecules or a salt | Components sit side by side; their relative position means nothing | **Warn before send** |
| Abbreviations, superatoms | Must expand to real atoms | Expanded by the host's handoff graph (task 1G); a label it cannot expand is **refused** by name. A lossy serializer fallback is refused for this feature, never sent |
| Connection-point atoms labelled `X` (Decision 1b) | **Send as MOF Linker**: kept as `X` atoms at the connection positions. **Send as Molecule**: not chemistry | Linker send: always disclosed ("2 connection points marked"). Molecule send: **refuse**, naming the X atoms and pointing to Send as MOF Linker |
| R-groups, atom lists, polymer brackets, repeat units | Cannot be a single 3D molecule | **Refuse**, naming the object |
| Reaction context (arrows, roles, conditions, atom maps) | Dropped; only the selected molecules go | **Warn before send** if the selection is part of a reaction. The selection alone cannot tell (it carries only a molfile), so the host's handoff audit reports reaction membership and atom maps (task 1G) |
| Embedding or minimization fails (common with metals) | No coordinates | Per `PluginMinimize3DResult` (`chemistry3d.ts`): embed or setup failure and `clash` **refuse** with the engine's reason; `not-converged` **warns before send** with the iteration count ("geometry not fully relaxed"); engine warnings are listed in the box. Never send unminimized or made-up geometry without saying so |

"Always disclosed" items (layout, labels, colors, implicit hydrogens made explicit, the vacuum box)
are inherent to any 3D handoff: they are stated in the one-time consent box, the status line after
each send, and the file. They never get a box of their own, and the disclosure has no checkbox or
opt-out (owner question 12; master condition 3(d) amended to match, 2026-11-22).

"Warn before send" means a native message box listing the specific losses, with **Send** and
**Cancel**. With nothing specific to warn about, the send proceeds without a box (after the one-time
consent in Decision 3) and the status line says `Sent to Crystal Builder as a 3D model in a
vacuum box (not a crystal structure)`. Nothing is ever dropped silently.

## Decision 1b: two sends, and marking connection points in ChemDraft

Crystal Builder's MOF builder needs a linker whose connection points (where it bonds to the metal
node) are marked. Marking them over there by hand undoes the "one click" promise, so the user marks
them **in ChemDraft**, where drawing is easy.

**How a connection point is marked: an ordinary atom labelled `X`.** That is a normal ChemDraft atom
label: visible, saved with the document, editable, undoable, and it needs no new host object or tool.
PORMAKE, which Crystal Builder's MOF builder uses, marks connection points with `X` atoms in its
building blocks (confirmed by test, below).

**The host marks `X` atoms distinctly in the selection (added 2026-11-20 after task 0.3).**
`selection.read` returns a V2000 molfile, and on main an atom labelled `X` is written as `R#` with an
`M  RGP` line and a "not an element symbol" warning, exactly like a real R-group
(`chem-core/src/molfile.ts`, via `apps/desktop/src/plugins/selectionSnapshot.ts`). A plugin therefore
cannot tell a connection point from an R-group, and must not guess. The fix is in the host, as an
additive API change in the same 0.1.27 bump: `PluginSelectedMolecule` gains
`connectionPoints: { atom: number; anchor: number; bondOrder: number }[]` (1-based molfile atom
indices), listing exactly the atoms whose drawn label is `X`, with their one neighbor and bond order (`anchor: 0` when the `X` has no neighbor or more than one, so the plugin refuses it by name).
The molfile itself is unchanged for existing plugins; the warning for a listed atom names it as a
connection point instead of "not an element symbol". Real R-groups never appear in the list. Task
1A defines it, task 1F implements it, and the plugin reads only this field (task 2C2).

**Where the X goes follows PORMAKE's cut, not the acid.** PORMAKE's carboxylate nodes already contain
the carboxylates (node N16 is Zn4O(CO2)6 with 6 X), and the matching linker E14 is bare C6H4 with an
`X` on each ring carbon that bore a CO2. So for terephthalic acid the user draws a benzene ring with
`X` in place of each COOH, not an `X` on the carboxyl carbon (which would double the carboxylates).
The plugin's help and refusal messages say this, with the terephthalate picture.

**Automatic cut (in Phase 2, revised 2026-11-20; it is the default).** Chemists draw the real acid, as
the owner's demo did, so the plugin cuts it itself: each COOH or COO⁻ on a carbon becomes one `X` at
the midpoint of the ring C–carboxyl C bond (Crystal Builder's own rule for its E14 block, used in the
demo), and the pre-send box says "2 carboxylic acids cut to connection points (X) for the Zn₄O node".
The drawn document is not changed (§7). Hand-drawn `X` atoms still work and take precedence: if the
selection has any `X`, no automatic cut happens. Other connecting groups (pyridyl N, azolates,
phosphonates) are refused by name in Phase 2, not guessed. **The cut is bound to the node** (Kimi
2026-11-21): it runs only for a node whose record says it supplies the carboxylates (`N16`, `N17`);
if the user picks any other node, no automatic cut happens and hand-marked `X` is required, with
that said in the dialog.

**Three commands:**

| Command | Accepts | Sends |
|---|---|---|
| **Build MOF in Crystal Builder…** (main, added 2026-11-20) | One linker (drawn acid or hand-marked `X`), optionally with drawn metal ions or a metal-oxo core beside it | Suggests a net and node (table below) in one native dialog; then the host writes the linker block, runs Crystal Builder's own `xtal run mof.build` headlessly (Decision 3, `runCompanion`), and opens the finished framework in Crystal Builder's window. Status line: formula, cell, net, and Crystal Builder's fit numbers |
| **Send as MOF Linker** | One molecule with at least two `X` atoms, each bonded to exactly one heavy atom by a single bond | Bonded CIF with `X` atoms at the connection positions, each bonded to its anchor; a comment adds `connection points: n` |
| **Send as Molecule** | Any molecule with no `X` atoms | Bonded CIF, as in Decision 1 |

**Suggesting the net and node.** The plugin ships a small table, so the dialog opens filled in and one
click builds:

| Drawn beside the linker | Linker | Suggested | Result |
|---|---|---|---|
| Zn²⁺ ions (any count), with or without O²⁻ | **terephthalate exactly** (after the cut, the linker graph equals C₆H₄X₂ with the X para) | combination `pcu-N16-2x2x2` (Zn₄O(CO₂)₆; see below) | "matches the MOF-5 target checks", only when every check passes; never "MOF-5" alone |
| Zn²⁺, or nothing | any other ditopic carboxylate | same net, node, and repeat; labelled "suggested; no metal drawn" when no metal is drawn | **Never a material name**: "Zn₄O pcu framework with this linker" plus the measured numbers (Kimi 2026-11-21: no "MOF-5 family" or IRMOF label from a proxy) |
| Cu²⁺ | tritopic carboxylate | net `tbo`, Cu paddlewheel node `N17` (Cu₂(CO₂)₄ with axial O; task 0.4) | **Row disabled in 1.2.3** until a real N17/tbo build plus `inspect` fixture gives its full target record; then named HKUST-1 only for trimesate exactly |
| anything else | any | no suggestion. In 1.2.3 the dialog offers only the validated rows above (no free node list), so no unvalidated id is ever built from the dialog | — |

Drawn ions only pick the node; they are never sent as atoms, because a 2D drawing of four loose
ions is not the cluster's geometry (the 2026-11-20 demo showed this). The dialog says so: "Node N16
(Zn₄O) from Crystal Builder's library, matching the Zn²⁺ you drew". The user can change net,
node, and repeat before building.

**A suggested build must reproduce its target, or it is not named after it (added 2026-11-20).** A
pcu/N16 build on **one** cell (`repeat=1x1x1`) is *not* MOF-5: one cell holds one Zn₄O site, so the
clusters cannot alternate, the two carboxylates of each linker end up in perpendicular planes, and
every benzene ring is twisted 45° from both (P222, a = 12.94 Å; Crystal Builder's own report shows
it as "Joint twist left 6.000", and its manual, `docs/manual/frameworks/orientation.md`, says one
pcu cell cannot alternate). Built on **2×2×2**, Crystal Builder's default `orientation=consistent`
alternates the clusters itself and gives real MOF-5: Fm-3m, a = 25.87 Å, Z = 8, 424 atoms, twist
0.00°. So the MOF-5 row asks for `repeat=2x2x2`, and each named row of the suggestion table also
carries a **target record**, checked only against numbers Crystal Builder itself reports (revised
2026-11-21: `inspect` has no dihedral measurement, and "Joint twist left" is a cost, not an angle, so
the old "ring–carboxylate twist ≤ 10°" criterion is dropped rather than claimed):

- from `mof.build --json`: an empty `detail` (Crystal Builder's own check that the built net agrees with
  the requested one, task 0.4) and "The net that came out" table naming `pcu` (topology detected by
  Crystal Builder, not assumed); "Joint twist left" exactly 0.000; no "Atoms overlap" rows; joints
  bonded equal to the row's count (48 for MOF-5);
- from `inspect --json`: `detected_space_group` (Fm-3m for MOF-5) at `symprec` 0.01, cell edge within
  2%, `z`, `formula` (Zn₃₂O₁₀₄C₁₉₂H₉₆), `n_atoms` (424), exactly one framework fragment, and no
  error-level diagnostics;
- the linker: the host-canonical graph of the sent block equals the row's linker exactly.

After every build the host runs Crystal Builder's own `xtal inspect` on the output (the fixed
pipeline in Decision 3, rule 14) and the plugin compares:

- **Match:** the status line says "matches the MOF-5 target checks: Fm-3m, a = 25.87 Å, 424 atoms"
  (a match on stated checks, not a proof of identity).
- **No match:** the framework still opens, but the status line says what it is and why it is not the
  target, for example "Zn₄O–terephthalate pcu net, P222, a = 12.94 Å, Joint twist left 6.000: does not match the MOF-5 target checks".
  A material name never appears for a structure that failed its check (§7, §8: no fabricated claims).
  If the user changes the repeat to 1×1×1, this is what they see.

**No per-MOF knowledge of the repeat (task 0.4, 2026-11-21).** Crystal Builder scores every
`consistent` build and reports the joints left twisted as the table row "Joint twist left" in its
`--json` output (6.000 for pcu/N16 at 1×1×1, 0.000 at 2×2×2). So for any row or any user choice the
plugin uses one generic rule: build with the chosen combination; the host parses the "Joint twist left" row **fail closed** (missing,
malformed, or non-numeric counts as "not zero"); if it is not zero, the result box says so with the
number and, when the combination declares `rebuildAs`, offers **Rebuild at 2×2×2**, a new
host-authenticated user action that rebuilds exactly the first input (rules 2 and 16) (question 11, option (b): owner decision, 2026-11-21). A failed
rebuild never names or reopens the first output as if it were the answer. A twist of zero is
necessary, not sufficient: naming still needs the full target check above. The repeat is **not
hard-coded per MOF** (`docs/plans/notes/crystal-builder-0.4-source-map.md`); the per-material
target records are a separate, narrower thing.

Linker refusals, each naming the problem: fewer than two `X` atoms ("Mark at least two connection
points: draw an atom labelled X where the linker bonds to a metal node"); an `X` bonded to zero, two
or more atoms, or by a multiple bond; `X` in a molecule of several components.

**How the 3D model is built with `X` present** (revised 2026-11-21): the plugin never parses a
molfile. The host's handoff graph (task 1G) gives atoms, bonds, and the `X` atoms; the plugin turns
each `X` into an explicit H (the force field cannot type a dummy atom), passes the **graph** to
`embed3d` (task 1G adds a graph input; RDKit sanitizes it in the host), minimizes as usual, then
writes those atoms back out as `X`, bonded to their anchors. Atom order is stable across embedding
and minimization (`chemistry3d.ts`), so the mapping is exact. The `X` sits at a C–H distance (about
1.1 Å) along the bond to its anchor. Tested: the builder accepts 1.09 Å as well as PORMAKE's own
0.75 Å, so no rescaling is needed.

**A "Mark Connection Points" command** (task 2G; approved for Phase 2, owner question 6). The user
selects anchor atoms and the plugin adds `X` atoms as one labelled undo entry with the new atoms
selected (§4.4). It needs `document.write`. Where each `X` goes (bond length and open direction) is
layout math, which AGENTS.md §9 keeps in `layout-engine`, so the host supplies it (task 1G,
`suggestConnectionPoints`); the plugin only builds the patch. Drawing `X` by hand stays the
documented way.

### Test results: Crystal Builder 1.1.1, macOS Intel (2026-11-18)

The official `Crystal-Builder-1.1.1-x86_64.dmg` (SHA-256 matches the release digest) was run from a
scratch folder on the Intel iMac, never installed into `/Applications`, with the owner's approval. Driven
headlessly through its bundled `xtal` CLI and, for the window, through background app control.

| Question | Answer | How it was checked |
|---|---|---|
| A1 Plain XYZ | Opens as a molecule in a padded box (5 Å vacuum) with a warning, "no Lattice= in the comment line". Extended-XYZ keys (`smiles=`, `net_charge=`, `method=`) are tolerated | `xtal info` / `inspect` on benzene with plain and extended comment lines; both C6H6, 12 bonds |
| A2 App already running (macOS) | One process; each file opens as a **new tab** in the existing window | `open -a <app> -- file` twice while running; process count stayed 1; window shows a tab per file |
| A3 Names (macOS) | Bundle ID `org.crystalbuilder.CrystalBuilder`; ad-hoc signed; Intel build is x86_64 only; macOS 12.3 or later; `xtal` ships in `Contents/MacOS` | `Info.plist`, `codesign -dv` |
| A4 File types | Registers `.cif` and `.xtalproj` only, not `.xyz`. `open -a` opens the `.xyz` anyway, so registration is not needed for the handoff | `Info.plist`, launch test |
| A6 Linker, headless | **Works.** A plain XYZ with `X` atoms and no bond table, used through `bb_dir`, builds MOF-5 (pcu, node N16): C24H12O13Zn4, identical to the stock linker. Accepted with X at 0.75 Å and 1.09 Å, and with slightly non-planar geometry | `xtal run mof.build -p topology=pcu -p nodes=N16 -p edges=<name> -p bb_dir=<dir>` |
| A6 Linker XYZ, in the window | **Refused.** Opened from XYZ, the `X` atoms get no bonds, so Structure → Building blocks → Save as a building block refuses: "X1 is a connection point with no bonds… this cell holds 3 separate pieces". Same with PORMAKE's own bond-table XYZ, and after Recalculate bonds. This is by design in Crystal Builder's source, not a bug | Background app control on the scratch copy; nothing saved |
| End-to-end by hand, ChemDraft 1.2.1 (2026-11-20) | **Works.** Terephthalic acid pasted into ChemDraft 1.2.1 as SMILES and copied out as MOL V2000 (12 atoms, 12 bonds); cut to C₆H₄ + 2 `X` by the automatic-cut rule (X at the ring C–carboxyl C midpoint), with fixed ring geometry because the plugin's `embed3d` is reachable only from a plugin; `xtal run mof.build -p topology=pcu -p nodes=N16 -p edges=<block> -p bb_dir=<dir> -o out.cif` built C24H12O13Zn4, a = 12.936 Å cubic, fit RMSD 0.000 Å, net confirmed pcu; `open -a` showed it in the window. Zn²⁺ and O²⁻ drawn as ions only named the node; they could not become the cluster. **The structure was later found not to be MOF-5 (next row)** | Hand run on the Intel iMac; files in the session scratchpad |
| MOF-5 correctness (2026-11-20, rehearsal) | **One cell is wrong; Crystal Builder's own 2×2×2 build is right.** Rebuilt from a fresh drawing: every Zn is ZnO₄ (1.92–1.94 Å) and every linker is intact, but each ring is twisted 45.0° from both of its carboxylates, and `xtal symmetry` gives P222, not Fm-3m; the 12.936 Å cell holds one cluster orientation. The owner saw it in the window and called it "a box full of nonsense". A script that keeps Crystal Builder's own N16 cluster, inverts it on alternate sites of a 2×2×2 cell, and lays each ring in its carboxylate plane gives a = 25.872 Å, Z = 8, 424 atoms (Zn₃₂O₁₀₄C₁₉₂H₉₆), one framework, 0.00° twist, closest contact 1.08 Å (C–H); `xtal inspect` detects Fm-3m at 0.01 Å (R3m at the strictest tolerance, from rounded coordinates). Positions are idealized, not minimized. **Then, after reading Crystal Builder's manual:** the same `xtal run mof.build` with only `-p repeat=2x2x2` added, no script, gives a = 25.871 Å, Z = 8, 424 atoms, 48 joints bonded, every ring 0.00° from its carboxylates, Fm-3m at 0.01 Å. The 45° twist came from building one cell, not from a fault in Crystal Builder; the script is not needed | `mof5_alternate.py`, `xtal run mof.build … repeat=2x2x2`, `xtal symmetry`, `xtal inspect`; Intel iMac |
| A6 Linker CIF with bond table, in the window | **Works.** The same C6H4 + 2 `X` linker, written as a P1 CIF with a `_geom_bond` loop carrying `_xtal_bond_kind explicit`: each `X` comes in with one bond to its carbon; Save as a building block reports "2-connected — it will appear in the MOF builder's picker", and writes a PORMAKE block with both `X`–C bonds. The same CIF without the bond loop gives the `X` atoms 0 bonds | `xtal bonds` on both CIFs; `open -a` then Save as a building block on the scratch copy |

What this changes:

- **The send format is a bonded CIF, not XYZ** (Decision 1, revised). The one-click demo works in
  the window with no change on Crystal Builder's side, so **nothing needs to be asked of its author**.
- Still unverified: everything on **Windows** (tab behavior, installed executable and folder names);
  run from the Windows session against the official `setup.exe`.

## Decision 2: how to hand it over

**Recommendation: (a) a host-written temporary file, opened with the app the user picked.**

| Route | Verdict | Reason |
|---|---|---|
| (a) Temp file + "open with this app" | **Use now** | Works on every Crystal Builder install with no setup; no network; the plugin never sees a path; the same launch shape on macOS and Windows |
| (b) `xtal` CLI | **Use for the build step** (revised 2026-11-20) | It cannot load a file into the window, but it builds headlessly (`xtal run mof.build … -o out.cif --json`), and (a) then opens the result. That is what makes the one-command build possible without the MCP server. It ships inside the app the user picked (`Contents/MacOS/xtal` on macOS; the Windows name is checked by the Windows session) |
| (c) localhost MCP/HTTP | **Later, with the author** (Phase 4) | Off by default; needs `network.fetch` to localhost plus reading another app's token file; its doc is a design record, not verified shipped behavior. It is the right route for "open in the already-running window" and for calling its MOF builder, but only once the author confirms a stable contract |

Platform parity for (a):

- **Finding the app: the user picks it** in a native file dialog (starting in `/Applications` on
  macOS, the Start-menu Programs folder on Windows). No hard-coded paths, no bundle-ID lookup (the ID is
  used only for change detection, rule 6), no registry reads, no PATH search. The host remembers the pick.
- **macOS**: accept only a `.app` bundle; launch with `/usr/bin/open -a <bundle> -- <file>` (argument
  array, no shell). This routes to the running instance when the app supports it.
- **Windows**: accept only a `.exe`. Shortcuts are **not** resolved: a picked `.lnk` is refused with
  "Choose Crystal Builder.exe itself (in its install folder), not a shortcut", and `.bat`, `.cmd`,
  `.ps1` are refused because their quoting rules are unsafe (Kimi 2026-11-21); launch with
  `std::process::Command` and the file as one argument. No `ShellExecute` verbs, no `cmd /c`.
- **Both**: the process is detached; the host does not read its output, wait for it, or kill it on
  quit. Unsigned Crystal Builder builds may trigger Gatekeeper or SmartScreen on first run; that
  prompt belongs to the OS and the user, and our error text says so.

## Decision 3: the host gap (smallest general capability)

New API, `PluginApiVersion` 0.1.26 → **0.1.27** (additive, patch bump per §4.1; the next free patch when Phase 1 starts). Sketch for workers;
exact names are settled in review.

```ts
// context.apps: present only with BOTH "apps.handoff" and "native.execute".
interface PluginAppsAPI {
  /** Host-owned native picker. The plugin gets an opaque id and a display name, never a path. */
  chooseApp(request: { purpose: string /* ≤200 chars, shown in the dialog */ }):
    Promise<{ status: "chosen"; app: { appId: string; displayName: string } } | { status: "cancelled" }>;
  /** Is a previously chosen app still there and unchanged? */
  status(request: { appId: string }): Promise<{ available: boolean; displayName?: string; reason?: string }>;
  /** Write text to a host temp file and open it with that app. */
  sendFile(request: {
    appId: string;
    fileName: string;        // base name only; sanitized by the host
    extension: PluginHandoffExtension;  // allowlist of data formats: xyz, cif, mol, sdf, pdb, smi, csv, json, txt
    text: string;            // UTF-8, ≤ 5 MB
    warnings?: string[];     // ≤ 20 lines, ≤ 300 chars each; shown in the pre-send message box
  }): Promise<{ status: "sent" } | { status: "declined" } |
              { status: "failed"; code: "app-missing" | "app-changed" | "launch-failed" | "write-failed"; message: string }>;
  /** Added 2026-11-20 for the one-command build; revised 2026-11-21 after the Kimi review.
   *  Run the companion PIPELINE the plugin declared in its manifest, inside the chosen app. */
  runCompanion(request: {
    appId: string;
    pipeline: string;                 // id of a manifest-declared pipeline, e.g. "mofBuild"
    combination: string;              // id of a declared combination (rule 11)
    input?: { extension: PluginHandoffExtension; text: string }; // exactly one file, ≤ 1 MB UTF-8
    openOutput?: boolean;             // open the declared output file with the app afterwards
  }): Promise<{ status: "done"; steps: { id: string; json: unknown /* parsed, ≤ 1 MB */ }[]; opened: boolean } |
              { status: "declined" } |
              { status: "failed"; code: "app-missing" | "app-changed" | "tool-missing" | "bad-param" |
                  "version-untested" | "timeout" | "exit-nonzero" | "bad-output" | "write-failed";
                message: string;              // no host paths (rule 8)
                diagnostic?: { step: string; exitCode?: number; json?: unknown; stderrTail?: string /* ≤ 4 KB */ } }>;
}
```

The manifest declares each pipeline in full, so consent can show it and review can read it. Only the
host's placeholders (`{inputDir}`, `{inputStem}`, `{outputFile:cif}`, `{previousOutput}`) carry paths
or file names; plugin parameters are typed values that can never be a path or an option:

```json
"companions": [{
  "id": "mofBuild",
  "tool": { "macos": "Contents/MacOS/xtal", "windows": "xtal.exe" },
  "testedVersions": ["1.1.1"],
  "steps": [
    { "id": "preflight", "args": ["capabilities", "--json"], "timeoutSeconds": 30 },
    { "id": "build",
      "args": ["run", "mof.build", "-p", "topology={combination.topology}",
               "-p", "nodes={combination.node}", "-p", "edges={inputStem}",
               "-p", "bb_dir={inputDir}", "-p", "repeat={combination.repeat}",
               "-o", "{outputFile:cif}", "--json"],
      "input": { "extension": "xyz" },
      "timeoutSeconds": 120 },
    { "id": "inspect", "args": ["inspect", "{previousOutput}", "--json"], "timeoutSeconds": 60 }
  ],
  "combinations": {
    "pcu-N16-2x2x2": { "topology": "pcu", "node": "N16", "repeat": "2x2x2" },
    "pcu-N16-1x1x1": { "topology": "pcu", "node": "N16", "repeat": "1x1x1",
                       "rebuildAs": "pcu-N16-2x2x2" }
  }
}]
```

The plugin passes one `combination` id; net, node, and repeat are never chosen separately, so an
unvalidated pairing cannot be built (Kimi re-review). Only validated combinations are declared; the
N17/tbo combination is added in the release that ships its target record, not before.

The host runs the steps in order, as one unit, and the plugin cannot call a step on its own (rule 14).

Rules the host enforces (each one gets a test):

1. **Two permissions.** New `apps.handoff`, added to `dangerousPluginPermissions` (and to the list in
   AGENTS.md §4.1); manifest validation refuses it without `native.execute` (same pattern as
   `assistant.run`). The capability is absent without both, and every method re-checks both.
2. **Explicit user action only, with proof (revised 2026-11-21 and 2026-11-22; Kimi).** Methods work
   only while one of the plugin's own commands is running **and** Rust holds a live **arming** for
   it, made from a native event Rust saw. On main, the agent bridge's `command()` calls the same `host.command`
   dispatcher as the app's own UI, and the bridge's `click()` synthesizes pointer events
   (`apps/desktop/src/agentBridge.ts`), so a flag on the shared dispatcher would be forgeable.
   Therefore:
   - The flag never goes on the shared dispatcher. Handoff commands (any command of a plugin with
     `apps.handoff`) can be **started only by events Rust itself sees** (revised 2026-11-21 after the
     Kimi re-review: an `isTrusted` check in the renderer followed by an IPC mint request would let
     any code that can reach the IPC mint a token, because Rust never sees the real event):
     (a) the **native menu**, including its keyboard accelerators, whose events arrive in Rust; and
     (b) buttons in **host-owned native boxes shown from Rust** (the consent box, the build
     confirmation, the result box with Rebuild, task 1H). Toolbar buttons, palettes, overlays, and
     webview-only shortcuts cannot start a handoff command in 1.2.3; they show the menu path instead.
     There is **no renderer IPC command that creates an arming.**
   - **No credential ever reaches the renderer** (revised 2026-11-22 after the Kimi re-check: a
     bearer token handed to the renderer could be observed and raced by other main-renderer code,
     such as an enabled agent bridge). On such an event Rust records an **arming** in its own state:
     (pluginId, commandId), one-shot, 60 s. A choice the user makes later in a Rust-shown box, such
     as the combination in the build box, is written into the arming by Rust at that click, and a
     request can never override it. Rust then tells the host to run that plugin command;
     the message carries no secret, and nothing the renderer holds or sends is ever checked as proof.
     The bridge's `command()` and synthetic `click()`, MCP, `invokeAssistantTool`,
     `invokeRequestTool`, panels' programmatic calls, and a plugin invoking its own command keep using
     `host.command` and never create an arming.
   - **One narrow Rust endpoint.** Handoff calls reach Rust through a single command,
     `app_handoff_call(pluginId, method, request)`, whose wire type has no token, arming id, or
     command id field and rejects unknown fields. Rust accepts a call only while it holds a live
     arming for that pluginId, and takes the command id and every bound parameter from the arming,
     never from the request. No IPC command creates, returns, or accepts an arming.
   - **Arming lifetime across calls:** `status` and `chooseApp` need a live arming but **do not
     consume it**; only the side-effecting call (`sendFile`, or `runCompanion` as one whole pipeline,
     rule 14) consumes it, so `status` → `chooseApp` → `runCompanion` in one invocation works and a
     second send does not.
   - **Races are refused, not decided.** An arming accepts one side-effecting submission. A second
     submission for the same arming while the first is pending (before its launch, or before its
     Rust-shown box is answered) cancels both and closes the box; the status line says the handoff
     was refused because two requests claimed one menu click, and nothing launches.
   - **What is bound when, stated honestly.** The plugin computes the input text (the 3D model) after
     the click, in the renderer, so the text cannot be bound when the arming is made. Binding it there
     would not add protection: code that can race in the main renderer can already change the
     selection the plugin reads. What Rust enforces is the user-intent property: every launch matches
     exactly one native user action, used once, by one submission, with the app, pipeline, and
     combination fixed in Rust. For `runCompanion`, the Rust-shown build box (task 1H) also shows the
     formula and atom count Rust computes from the text it holds, so the user sees what goes before
     anything runs, and the launch uses that held copy.
   - **`apps.handoff` plugins run Worker-only.** Their commands execute in the plugin's module Worker,
     which has no handle on the Tauri IPC; registering an `apps.handoff` plugin in-process is
     refused. The host relays the Worker's handoff calls to `app_handoff_call`.
   - Tests cover `bridge.command`, `bridge.click`, synthetic `KeyboardEvent`s, MCP, both tool paths,
     a plugin calling its own command, `source` in plugin input, in-process registration refused,
     and `status` → `chooseApp` → `runCompanion` succeeding on one arming while a second send is
     refused. **Credential tests (Kimi re-check):** the `app_handoff_call` wire type has no token,
     arming, or command field, and a request carrying one is rejected; a call with no live arming is
     refused even when it repeats every value the renderer saw during a real armed invocation (event
     payloads, invocation ids, earlier requests); an expired arming refuses; a call cannot change the
     arming's command id or combination; two submissions on one arming launch nothing; and a static
     check that no Tauri command registered by `app_handoff` returns an arming or token.
3. **One pipeline or one send per command invocation** (`sendFile` or `runCompanion`, not both). A
   refused or declined call does not use up the allowance (same rule as `dialogs.promptText`). A
   rebuild (question 11) is a new native click with a new arming, run by Rust (rule 16).
4. **The plugin never supplies a path, free argv, environment, or verb at run time.** It supplies
   text, an allowlisted extension, a pipeline id fixed in its manifest, and typed parameter values
   (rule 11). The host renders the command line.
5. **Consent per plugin and per app**, once, in a native message box that names the plugin (name and
   id), the app's display name and location, and the declared pipeline, and says the plugin will start
   that app's tool and give it a file each time its command runs. Task 0.3 found the external-tools
   store can't hold this (its `ToolId` is a closed Claude/Codex enum, rows use `deny_unknown_fields`,
   and the UI strings are hard-coded), so apps get a **new, separate store**, and the external-tools
   schema is not widened. `app_local_data_dir()/app-handoff/consents.json`: a top-level object with
   `schemaVersion: 1` and `rows: [{ pluginId, appId, appPath, appIdentity, templateDigest,
   consentTextVersion, granted, at }]`, keyed by (pluginId, appId). **`templateDigest`** is SHA-256 of
   the canonical JSON of the declared pipeline, and it is **re-checked on every call**, not only at
   update time, so a missed update hook or an interrupted swap can never run a changed template
   (Kimi 2026-11-21). Written atomically like `consent.rs` (temp, sync, rename); 0o600 on Unix; on
   Windows the file gets an owner-only DACL through `windows-sys` (already a dependency; a feature
   flag may be added), tested by reading the ACL back. Unknown fields are kept on read and rewrite.
   Behavior, each with a test:
   - **Uninstall:** every row for the plugin is deleted.
   - **Disable:** rows are kept; while disabled, the plugin's commands don't run, so nothing is sent.
   - **Update:** rows are kept if the new version still declares both permissions; a changed pipeline
     simply fails the digest check, so consent is asked again on the next call (the box shows the new
     command); if the permission is dropped, the rows are deleted.
   - **App changed or missing** (rule 6): that row stops counting and consent is asked again.
   - **Revoke** in the Plugin Manager sets `granted: false`; the row is listed until uninstall.
6. **The app is re-confirmed if it changes** (revised 2026-11-21). `appIdentity` holds SHA-256 of the
   main executable and of the companion tool, plus the code-signing identity where one exists (macOS
   cdhash for ad-hoc builds or the Team ID for signed ones; the Windows Authenticode publisher when the
   file is signed). Before every launch the host canonicalizes the path again, re-hashes, and fails
   closed on any mismatch (`app-changed`), then asks again. Path, size, and modified time stay as a
   fast pre-check only.
7. **Temp files are the host's**: `<app cache>/handoff/<pluginId>/<random>/<name>.<ext>`, built with
   `path` APIs; the name is stripped of separators, control characters, Windows reserved names, and
   trailing dots or spaces; anything older than 24 hours is removed at startup. The input block gets a
   collision-resistant reserved stem, `cdx_<128-bit random hex>`, used as `{inputStem}`, so it can never
   shadow or be shadowed by a block shipped with Crystal Builder (its `bb_dir` lets a user block
   override a shipped one with the same stem).
8. **Specific errors, without paths to the plugin** (§13; revised 2026-11-21). The plugin gets a code,
   a message with no host paths, and a bounded `diagnostic`. Paths appear only in host-owned native UI,
   for example the host's own box: `Send to Crystal Builder failed: "Crystal Builder.app" is no longer
   at /Applications. Choose the app again.`
9. **Web build and other hosts**: the capability rejects with a plain error and the same shape.
10. **No new Rust dependency**: `std::process::Command`, the existing `tauri-plugin-dialog`, and the
    existing `windows-sys` (feature flags only). No shell or opener plugin is added.
11. **`runCompanion` runs only what the manifest declared, with typed values** (revised 2026-11-21).
    The tool path is resolved inside the chosen app's folder (bundle on macOS, install folder on
    Windows), with `..`, symlinks, and Windows junctions and other reparse points out of it, and
    absolute paths, refused. Arguments are the declared steps only. A placeholder fills one whole
    argument, or follows a fixed literal prefix that ends in `=` in the same argument (as in
    `topology={topology}`); nothing else may surround it. The only plugin-chosen value is a declared `combination` id; each `{combination.*}` value
    is fixed in the manifest, ≤ 32 characters, and validated at install: it can never start with `-` or
    `@`, contain a path separator, `..`, `=`, or a control character, or add an argument. Option-like and response-file values are tested as well as
    shell metacharacters.
12. **Consent names the pipeline.** The consent box shows the tool's name and each declared step's
    command line with its placeholders ("xtal run mof.build … -o <output>.cif"). A changed pipeline
    fails the digest (rule 5) and asks again.
13. **Official plugins only in 1.2.3** (owner question 8; added 2026-11-21, Kimi blocker). A host-owned
    allowlist in Phase 1, `OFFICIAL_COMPANION_PLUGINS` (plugin id plus its release repository), is
    checked when the plugin registers and on every `runCompanion` call. A plugin passes only if its
    installed package came through the host's catalog or update path from that repository with a
    verified SHA-256 (the install record keeps the provenance). Phase 2 testing, before the catalog
    entry exists (Phase 3), installs the plugin from a GitHub pre-release of its repository through the
    same verified path, which the allowlist already names. Development builds (`ChemDraft (dev)`) may
    also accept a hand-installed package for an allowlisted id, and say so in the consent box; stable
    builds never do. Tests: a sideloaded package with an allowlisted id and both permissions is refused
    on a stable build; an unlisted plugin is refused everywhere; a dev build accepts the hand install.
14. **A pipeline runs whole, in order** (added 2026-11-21). `preflight` (`xtal capabilities --json`)
    must report a version in `testedVersions`, or the call fails with `version-untested` naming the
    tested versions (question 10). `build` runs only after it; `inspect` runs only on the regular file
    `build` just wrote inside the handoff temp folder (checked before the call). A step's stdout must
    parse as JSON, or the call fails with `bad-output`; a nonzero exit still returns the parsed JSON in
    `diagnostic` when there is one, so Crystal Builder's own message reaches the user (exit 1 is bad
    input, exit 2 a build that ran and failed; task 0.4).
15. **Bounds and environment** (added 2026-11-21). One input file, ≤ 1 MB; parameters ≤ 32 characters;
    `timeoutSeconds` ≤ 300 per step and ≤ 600 per pipeline, and the timeout kills the process tree;
    stdin is null; stdout ≤ 1 MB and stderr ≤ 256 KB per step, drained concurrently so a full pipe
    cannot hang the tool; Windows `CREATE_NO_WINDOW`. The environment is cleared (`env_clear`) and
    rebuilt from a fixed platform allowlist (macOS: `HOME`, `TMPDIR`, `LANG`, a fixed `PATH`; Windows:
    `SystemRoot`, `TEMP`, `TMP`, `USERPROFILE`, `LOCALAPPDATA`, a fixed `PATH`). Tests show that
    `XTAL_*`, `PYTHON*`, `DYLD_*`, and `LD_*` set in ChemDraft's environment never reach the tool.
16. **Rebuild repeats exactly the first build, inside Rust** (added 2026-11-21, Kimi re-review;
    revised 2026-11-22, Kimi re-check). After a pipeline, **Rust** keeps a **result session**: the
    exact input text it ran, the combination, the app identity, the template digest, and the
    handoff-graph digest, for 10 minutes or until the plugin's next send. When the result box offers
    Rebuild (only if the combination declares `rebuildAs`), the click is a native button Rust sees,
    and Rust runs the `rebuildAs` combination itself from the session, with no call into the renderer
    or the plugin; the plugin only receives the result, through the same path as the first build. A
    changed selection therefore cannot change what is rebuilt, and no credential exists to steal. An
    expired session, a changed app, consent, or template digest refuses the rebuild with a message to
    start again.

Every `#[cfg(target_os = "macos")]` gets its `cfg(windows)` side in the same change. The command line
is built by one pure function that takes the platform as a parameter, so both branches are tested
from one host (§1, §14).

## Decision 4: where it lives

- **Plugin repository**: `jgassens/ChemDraft-CrystalBuilder-Plugin`, MIT code license, no bundled
  data (so no `dataLicenses`). Imports only `@chemdraft/plugin-api`.
- **Plugin id**: `org.chemdraft.handoff.crystalBuilder`. Display name: "Send to Crystal Builder".
- **Commands**: `plugin.crystalBuilder.buildMof` (main, "Build MOF in Crystal Builder…", menu
  `menu.crystalBuilder.buildMof`), `plugin.crystalBuilder.sendLinker` ("Send as MOF Linker"),
  `plugin.crystalBuilder.sendMolecule` ("Send as Molecule"), `plugin.crystalBuilder.chooseApp`
  (re-pick), and `plugin.crystalBuilder.markConnectionPoints` (task 2G, approved for Phase 2).
  **Menus**: `menu.crystalBuilder.buildMof`, `menu.crystalBuilder.sendLinker`,
  `menu.crystalBuilder.sendMolecule`, `menu.crystalBuilder.chooseApp`, and
  `menu.crystalBuilder.markConnectionPoints` (task 2G), location `plugins`.
- **Permissions**: `selection.read`, `chemistry.compute`, `apps.handoff`, `native.execute`,
  `plugin.storage`, `ui.menu`, and `document.write` (task 2G, Mark Connection Points; owner
  2026-11-20). `apiVersion: "^0.1.27"`. Nothing else: no network, no clipboard, no filesystem.
- **Release assets**: `crystal-builder-handoff-X.Y.Z.zip` and `.zip.sha256`, with the two release-body
  markers (`ChemDraft-Plugin-API: ^0.1.27`, `ChemDraft-Min-App:` the first app version with 0.1.27).
- **Host catalog**: one entry in `OFFICIAL_PLUGIN_CATALOG` (`apps/desktop/src/plugins/pluginUpdates.ts`)
  and four exact URLs in `apps/desktop/src-tauri/capabilities/plugin-updates.json` (latest,
  `?per_page=20`, `.zip`, `.zip.sha256`); `pluginUpdates.test.ts` guards them.
- Public text names only Crystal Builder and file formats, never a commercial competitor.

## Decision 5: phases and tasks

Working rules for every task: workers write the code through agentctl, one at a time; the conductor
writes none. No builds, no full test runs, and no parallel fan-outs while the machine is overloaded;
each worker runs only the test files for its task, and the full gauntlet (§14) runs once per phase
when the owner says the machine is free. Review is kimi-k3 only, one at a time machine-wide:
`mkdir ~/.agentctl/kimi-slot.lock`, review, then `rm` the lock only if that `mkdir` succeeded. The
Windows installer comes only from the GitHub workflow; the Windows session tests that installer.

### Phase 0: before any code (this week, around 1.2)

| Task | Output | Done when |
|---|---|---|
| 0.1 Owner approves this plan; summary goes to the master session | Master session's OK | OK received |
| 0.2 ~~Note to Crystal Builder's author~~ | Dropped 2026-11-18: every question was answered by testing and reading its source | Done |
| 0.3 One read-only code map (single worker) | Short note: how a user-invoked command is told apart from an assistant-invoked one in `plugin-host`; what SMILES the selection snapshot carries for abbreviations, R-groups, and an atom labelled `X`, and whether the selection exposes per-atom labels and bonds; the consent store's shape | Note attached; no files changed |
| 0.4 Crystal Builder source map (same single worker, after 0.3) | Short note from its MIT source: the node and net ids in `xtal/mof/catalog.py` (Zn₄O = N16 confirmed; the Cu paddlewheel id); what `mof.build --json` prints (fit numbers, formula, output path) and its exit codes; whether `bb_dir` accepts a CIF block or only PORMAKE XYZ; which nets need a repeat above 1×1×1 before their nodes can alternate (as pcu/N16 needs 2×2×2), and how a build reports it (now: "Joint twist left", read fail closed, with a Rebuild action per question 11); what `xtal inspect --json` prints for space group, Z, and coordination; the Windows `xtal` executable name and location in the installer | **Done 2026-11-21:** `docs/plans/notes/crystal-builder-0.4-source-map.md` (worker's node table corrected by the conductor) |
| 0.5 Rebased code map (added 2026-11-21, Kimi) | Redo the 0.3 map on the exact commit Phase 1 branches from, after 1.2.2 ships: `PluginApiVersion`, `invokeCommand` and the tool paths, every dispatch site that calls `host.command` (menus, toolbar, shortcuts, panels, overlay, agent bridge), whether plugin code (worker and in-process) can reach the Tauri IPC, `workerProtocol.ts` capability whitelist, `build.rs` command registration, and the install record's provenance fields. The plan branch's own base (5008267c, API 0.1.20) is too old to cite | Note attached; line references in rules 1–15 and tasks 1A–1H updated to that commit |

### Phase 1: host capability (ChemDraft repo, branch `feat/app-handoff` off `origin/main` after 1.2.2 ships)

| Task | Owned paths | Acceptance and tests | Review |
|---|---|---|---|
| 1A API contract | `packages/plugin-api/src/index.ts` (+ new `appHandoff.ts`, `appHandoff.test.ts`), header comment, `packages/plugin-api/package.json` (version must match, `index.test.ts` checks it), `packages/plugin-api/src/workerProtocol.ts` (whitelist `apps`) | Schemas for the four methods and the manifest `companions` pipelines; permission added and marked dangerous; manifest refuses `apps.handoff` without `native.execute`, refuses a step whose placeholder is undeclared or sits inside a larger argument other than after a fixed `key=` prefix, refuses any plugin-chosen value but a declared `combination` id (each combination's values validated per rule 11), and refuses timeouts over the rule 15 caps; version 0.1.27 (provisional: the next free patch when Phase 1 starts, re-read by task 0.5). Tests: name sanitizing, extension allowlist, size and warning limits, permission pairing, combination values that look like options or paths refused, failure `diagnostic` shape | Kimi |
| 1B Host gate | `packages/plugin-host/src/**` (capability wiring + tests); the trusted entry points in `apps/desktop/src/` (the native menu handler and the Rust-shown boxes) that call `invokeCommandFromUser`; the agent bridge untouched except tests | User intent per rule 2: handoff commands start only from Rust's run-command message (native menu, Rust-shown boxes), which carries no secret; the host relays the Worker's calls to `app_handoff_call` and never holds a token; Worker-only execution for `apps.handoff` plugins, in-process registration refused; arming required by `status` and `chooseApp` but consumed only by the send; spoofing tests for `bridge.command`, `bridge.click`, synthetic key events, MCP, both tool paths, self-invocation, and `source` in input; official-only allowlist per rule 13 at registration and on every call, with the sideload tests; absent without both permissions; one pipeline or send per invocation, refused calls not counted; worker and in-process paths behave the same | Kimi |
| 1C Native side | `apps/desktop/src-tauri/src/app_handoff/**`, `lib.rs` registration, `apps/desktop/src-tauri/build.rs` (register the new commands so their permissions are generated), `capabilities/app-handoff.json` (window `main` only) | Pure command-line builder tested for macOS and Windows from one host; arming kept in Rust state and the single `app_handoff_call` endpoint per rule 2, with the credential tests listed there (no token field, replay of renderer-observed values refused, expired arming, bound command and combination unchangeable, two submissions launch nothing, no command returns an arming); Rust-held result session and Rebuild run in Rust per rule 16; companion pipeline runner per rules 11, 14, and 15 (tool resolved inside the app folder, symlink, junction, and `..` escapes refused, preflight version check, `inspect` only on the file `build` wrote, timeout kills the tree, output caps with concurrent draining, null stdin, cleared environment, no console window on Windows), tested with a stub tool on both platforms; app identity per rule 6 (hashes, signing identity, re-check before every launch); picker accepts only `.app` / `.exe` and refuses `.lnk`; temp path and cleanup tests (backslashes, 8.3 paths, reserved names); new `app_handoff` consent store per rule 5 (separate file, `schemaVersion`, `templateDigest` re-checked on every call, owner-only file on both platforms, unknown fields kept), with tests for disable, a changed pipeline, app changed, and revoke; the external-tools store untouched; app-changed detection; serde/Zod wire fixtures like `externalToolsWire.test.ts`; clippy clean on both `cfg` sides | Kimi |
| 1D Desktop wiring | `apps/desktop/src/appHandoff/**`, plugin runtime hookup, Plugin Manager consent rows (own section, not the AI-tool rows), `apps/desktop/src/plugins/installPluginPackage.ts` and the update path (uninstall deletes rows; permission dropped on update deletes rows; install provenance recorded for rule 13) with their tests | Native message boxes for consent and warnings (no in-viewport dialog, §12); the host-owned **build confirmation dialog** (task 1H); status-line success; specific errors with paths only in host UI; consent visible and revocable; lifecycle tests for uninstall, update, and permission dropped | Kimi |
| 1F Connection points in the selection | `apps/desktop/src/plugins/selectionSnapshot.ts`, `packages/plugin-api/src/index.ts` (field), `chem-core` molfile warning text | `connectionPoints` per Decision 1b: lists exactly the atoms labelled `X` with anchor and bond order; molfile bytes unchanged for existing plugins; tests: X only, R1 only, X and R1 together, X with two neighbors (listed with `anchor: 0` so the plugin refuses it by name), `X` inside an abbreviation, a document saved and reopened | Kimi |
| 1G Handoff graph and audit (added 2026-11-21, Kimi blockers) | `packages/plugin-api/src/index.ts` and `chemistry3d.ts` (types), `apps/desktop/src/plugins/` (host implementation using RDKit through the existing chemistry engine), `packages/layout-engine` (export the bond tool's new-bond direction for an atom, no copy) | `chemistry.handoffGraph({ objectId })` returns, for one selected molecule: atoms (element, charge, isotope, radical electrons, explicit H count, drawn label, `isConnectionPoint`), bonds (order 1/2/3/aromatic, stereo flags), RDKit canonical SMILES, unspecified stereocenters and double bonds (RDKit perception), reaction membership with roles and atom maps, abbreviations expanded or refused by name, and every serializer loss (a lossy fallback refuses). `embed3d` gains a `{ graph }` component (RDKit sanitizes; failure refuses). `suggestConnectionPoints({ objectId, anchors })` returns the bond-tool position for each new `X` (for task 2G). Tests: unspecified centers, a reaction member with atom maps, a radical with more than two electrons, an unknown bond, an abbreviation, writer fallback refused, graph round trip equals the drawn canonical SMILES | Kimi |
| 1H Build confirmation dialog (added 2026-11-21) | `apps/desktop/src/appHandoff/**` (dialog through the shared native dialog host), `plugin-api` type | `runCompanion` shows, before the first step, a host-owned native box **shown from Rust** listing the declared combinations as one choice, with the plugin's suggestion preselected, and the formula and atom count Rust computes from the input text it holds; Cancel returns `declined`. The result box, also shown from Rust, offers **Rebuild at 2×2×2** only when the combination declares `rebuildAs`; Rust runs the rebuild itself from its result session (rule 16; question 11 (b)). Tests: a changed selection before Rebuild still rebuilds the first input; an expired session refuses. The plugin API stays without a general choice dialog (only `promptText` exists today) | Kimi |
| 1E Docs and closeout | `docs/plugin-architecture/AUTHORING.md` (new section + version table row), AGENTS.md §4.1 version line and dangerous-permission list (`apps.handoff`), `docs/manual-stress-checklist.md`, `docs/plans/PLANS.md`, build stamp | Docs match the code; a short AUTHORING example ("send a text file to an app the user picked"); gauntlet green | Kimi |

Hands-on, both platforms (owner's MacBook for macOS UI; the Intel iMac checks only processor-specific
behavior; Windows on the CI-built installer): pick an app; decline consent; accept; send; revoke and
resend; move the app and resend (expect `app-changed` / `app-missing`); file name with spaces,
non-ASCII characters, and a reserved name; palettes keep focus rules; no console flash on Windows;
quitting ChemDraft leaves the other app running.

### Phase 2: the plugin (new repository)

| Task | Owned paths | Acceptance and tests | Review |
|---|---|---|---|
| 2A Scaffold | manifest (final: every command, menu, permission, and the `mofBuild` pipeline; later tasks chain off 2A and do not edit it), `src/index.ts`, `src/workerEntry.ts`, LICENSE, README | Manifest parses; boundary rule holds (only `@chemdraft/plugin-api`) | Kimi |
| 2B CIF writer | `src/cif.ts` + test | Pure function, `Plugin3DModel` plus bonds → text in the Decision 1 format: P1 box with 5 Å vacuum, unique labels, `_geom_bond` loop with `_xtal_bond_order` and `_xtal_bond_kind explicit`; fixed decimals, LF only, atom count and order equal the model; provenance comments. Golden-file test of the exact text for the terephthalate linker (guards the private-tag risk) | Kimi |
| 2B2 Linker block writer (added 2026-11-21, Kimi blocker) | `src/pormakeXyz.ts` + test | Pure function, embedded model plus graph → the bonded PORMAKE XYZ that `bb_dir` reads (task 0.4): atom count; the line of 0-based connection-atom indices; `symbol x y z` lines with `X` for connection atoms; bond lines `i j S\|D\|T\|A` (aromatic as `A`). Golden-file tests of the exact text for terephthalate and trimesate: index line, 0-based indices, coordinates to fixed decimals, every bond and its letter, atom order equal to the model | Kimi |
| 2C Loss audit | `src/lossAudit.ts` + test | Pure function over the host's `handoffGraph` audit (task 1G; the plugin parses no molfile) returning refusals and warnings exactly per the table in Decision 1, per send mode, including minimization `not-converged` and `clash`; fixtures: charged, isotopic, radical, unspecified stereo, salt, abbreviation, R-group, reaction member, metal complex, X atoms in a molecule send | Kimi |
| 2C2 Connection points | `src/connectionPoints.ts` + test | Pure functions: find `X` atoms and their anchors; validate per Decision 1b (fewer than two, wrong valence, multiple bond, several components each refused with its message); read connection points only from the host (`connectionPoints` / `handoffGraph`, never by guessing which `R#` is an `X`); rewrite them to H in the graph for embedding; map embedded atoms back to `X` by index. Fixture: a molecule with one `X` and one real `R1` (the `R1` is refused as an R-group, the `X` accepted). Fixtures: terephthalate linker (benzene ring with X in place of each COOH, PORMAKE E14 cut), a tritopic linker with 3 X, a molecule with 1 X (refused), X on a double bond (refused) | Kimi |
| 2C3 Automatic cut | `src/carboxylateCut.ts` + test | Pure function on the host graph: each COOH / COO⁻ on carbon → one `X` at the ring C–carboxyl C midpoint, per Decision 1b; skipped when the selection already has `X`; runs only for a node that supplies carboxylates (N16, N17), refused with "mark X by hand" for any other node; other connecting groups refused by name. Fixtures: terephthalic acid → C₆H₄X₂ matching the 2026-11-20 block; disodium terephthalate; trimesic acid → 3 X; nicotinic acid (pyridyl refused) | Kimi |
| 2H Build MOF command | `src/buildMof.ts`, `src/nodeSuggest.ts`, `src/targetCheck.ts` + tests (chained after 2A, 2B2, 2C, 2C2, 2C3) | Suggestion per the Decision 1b table (MOF-5 row only for terephthalate exactly; other ditopic carboxylates unnamed; the HKUST-1 row disabled); one `runCompanion` call on the `mofBuild` pipeline with the 2B2 block as the single input and the suggested values (the host's confirmation dialog, task 1H, lets the user change them); `targetCheck.ts` reads the `build` and `inspect` step JSON per the Decision 1b target record ("Joint twist left" parsed fail closed, no overlap rows, joints bonded, detected space group, cell within 2%, Z, formula, atom count, one fragment, linker graph equal) and names the material only on a full match, as "matches the MOF-5 target checks". Mocked-context tests: success; user cancels; tool missing; untested Crystal Builder version; timeout; exit 1 and exit 2 with Crystal Builder's JSON message passed through; non-JSON output; JSON failure without `tables`; missing, malformed, and non-numeric twist rows; nonzero twist offers Rebuild; failed rebuild names nothing; **the 2026-11-20 twisted P222 build (fixture) is not called MOF-5, and the Fm-3m cell is** | Kimi |
| 2D Command flow | `src/send.ts` + test with a mocked context | Both send commands: empty selection, cancelled picker, declined consent, embed failure, minimize failure, linker refusals, and success each produce the specified message; one send per command | Kimi |
| 2E Package and release | package zip, checksum, release body markers | Installs by hand through Add plugin from package on both platforms | Kimi |
| 2G Mark Connection Points (in Phase 2, owner 2026-11-20) | `src/markConnectionPoints.ts` + test (chained after 2A, which already declares `document.write`) | Selected anchors get `X` atoms at the positions the host's `suggestConnectionPoints` returns (task 1G; no layout math in the plugin, §9), through `documents.applyPatch`, one labelled undo entry, new atoms selected (§4.4); anchors with no free valence refused by name; chemistry of the anchor molecule otherwise unchanged (§7 test: canonical SMILES with X removed equals the original) | Kimi |

Hands-on, both platforms, with Crystal Builder installed by the owner (agents do not install it):
**the one-command demo first**: draw terephthalic acid and four Zn²⁺, select both, Build MOF in
Crystal Builder…, accept the suggested pcu/N16 combination, and the framework (Fm-3m, a ≈ 25.9 Å, Z = 8, 424 atoms)
opens in the window with no other clicks, and the status line says "matches the MOF-5 target checks" only because every check passed; then
a benzene ring with `X` in place of each COOH (terephthalate) sent as a MOF linker, then built into MOF-5 with node N16 in Crystal
Builder's MOF builder (the demo; Save as a building block must report "2-connected" with no
re-marking or hand-drawn bonds);
the same molecule without `X` (linker send refused with its message); benzene as a molecule; a charged species; a molecule with one unspecified
center; a salt; an abbreviation; an R-group (refused); a ferrocene-like complex (expect an honest
refusal or warning); confirm the structure appears in Crystal Builder and matches atom count and
formula.

### Phase 3: catalog and docs (ChemDraft repo)

One task: catalog entry, the four capability URLs, `pluginUpdates.test.ts`, AUTHORING catalog
paragraph, move the slice to `docs/shipped/README.md`, bump `CURRENT_BUILD_STAMP`. Acceptance: one-click install from **Add or
Remove Plugins** on macOS and Windows; update check finds a newer release. Kimi review; gauntlet.

### Phase 4: later (not scheduled)

- The one-command build moved into Phase 2 (task 2H) on 2026-11-20, through the `xtal` CLI, so the
  MCP server is no longer needed for it. Crystal Builder's MCP `open(path)` stays a possible later
  route only if a file open ever fails to reach the running window on Windows.

### Phase 5: the return trip, a unit cell as a 3D object (last; owner 2026-11-20)

Goal: a MOF built in Crystal Builder comes back into ChemDraft as **one object on the page that can be
moved, rotated in 3D, and exported**, not flattened into a 2D drawing. Starts only after Phase 3 ships
(owner question 7 answered yes, 2026-11-20).

Why it is its own phase:

- **ChemDraft has no lasting 3D object.** Spin 3D rotates a molecule and flattens it back; nothing 3D
  is stored in the document (checked on `origin/main`, 2026-11-20). No CIF reader exists either.
- **A framework is not a molecule.** It is periodic: bonds cross the cell edge, and there is no
  SMILES. Flattening it into ordinary atoms and bonds would invent a finite molecule and break §7, so
  that route is refused.
- **The charter lists "3D molecular visualization" as a non-goal** (PLAN.md §5). Adding a 3D object
  to the core is an owner decision (question 7).

Recommended shape (if the owner says yes):

| Piece | Where | What |
|---|---|---|
| 5A Native object | `chem-core` (type, Zod schema, migration), `plugin-api` type, version bump, PLAN.md §5 non-goal wording | `crystal3d`: atoms (element, label, fractional or Cartesian Å), bonds with periodic image offsets, cell (a, b, c, α, β, γ), space group as read, repeat (1–4 per axis), a view rotation, and provenance (file name, source app, formula). Read-only chemistry: analyzers return `unsupported` ("periodic structure") |
| 5B Drawing and rotation | `layout-engine` (projection, depth cues, cell edges; §9 says this math lives there only), `apps/desktop/src/interaction/` (drag-rotate, reusing the Spin 3D `ScreenPlacement` contract) | Shown as a ball-and-stick or stick projection with the cell box; move like any object; drag inside it to rotate; typed angles; repeat cells; the rotation is saved |
| 5C Import | plugin importer contribution (`.cif`), host open dialog | The user exports or saves a CIF in Crystal Builder and opens or drops it in ChemDraft; one labelled undo entry, new object selected (§4.4). Malformed CIF fails with a specific message (§13) |
| 5D Export | `export-engine` | SVG and PDF draw the current projection exactly as the canvas does; CDXML writes the projection as graphics with a warning that the 3D cell is not kept; the native `.chemdraft` file keeps everything; **Send back to Crystal Builder** re-sends the original CIF text, which 5A stores in the object with its SHA-256 (revised 2026-11-21: the object must keep the raw CIF for this to be true). Tests: schema and migration, periodic bonds, malformed CIF, undo, projection and export parity, both platforms |
| 5E Optional automation | plugin, plus a host readback contract | "Bring back from Crystal Builder" after a 2H build. `runCompanion` returns no output bytes today, so this needs a host-mediated readback of the declared output file (bounded, same handoff folder, one user action), designed in Phase 5, not assumed |

The picture-only fallback was considered and dropped (owner, 2026-11-20).

## Open questions

For the owner:

1. ~~**Release target.**~~ **Answered (owner, 2026-11-20): 1.3; changed (owner, 2026-11-23): ship the host capability in 1.2.3** (API 0.1.27, the next free patch when Phase 1 starts; main took 0.1.26 for request-bound tools).
2. ~~**How often to ask.**~~ **Answered (owner, 2026-11-20): consent once per plugin and app, then a
   message box only when something specific would be lost.** Consent once per plugin and app, then a message box only when something
   specific would be lost (recommended), or a confirmation on every send?
3. ~~**Minimize or not.**~~ **Answered (owner, 2026-11-20): MMFF94s-minimized.** Send the MMFF94s-minimized geometry (recommended) or raw ETKDG coordinates?
4. ~~**Names.**~~ **Answered (owner, 2026-11-20): the proposed names.** Crystal Builder's author is not
   contacted (question 10). Are `jgassens/ChemDraft-CrystalBuilder-Plugin`, `org.chemdraft.handoff.crystalBuilder`,
   and "Send to Crystal Builder" acceptable, and does the author agree to their app's name in our catalog?
5. ~~**Agent tooling on this iMac.**~~ **Answered (owner, 2026-11-20): install agentctl on the iMac so
   workers run here and the MacBook is offloaded.** A short setup plan goes to the master session
   before anything is installed; logins are the owner's to do. Original question: `agentctl`, `~/.agentctl/`, and `~/programming/chemdraw-wt/` do
   not exist on this machine. Should the workers run from the MacBook, with this session only conducting?
6. ~~**Mark Connection Points command.**~~ **Answered (owner, 2026-11-20): ship it in Phase 2 (task 2G,
   with `document.write`).** Original question: Ship the optional one-click marker (task 2G, adds the dangerous
   `document.write` permission), or keep "draw an atom labelled X" as the only way? Recommended: ship
   without it first; add it if the demo feels clumsy. (2026-11-20: less needed now; the automatic
   cut in Decision 1b covers the common case.)
7. ~~**A 3D object in the core (Phase 5).**~~ **Answered yes (owner, 2026-11-20):** the "3D molecular
   visualization" non-goal (PLAN.md §5) is lifted for one native `crystal3d` object that can be moved,
   rotated, and exported. The picture-only fallback is dropped. The PLAN.md §5 wording changes in
   Phase 5's first pull request (task 5A), not before, since nothing touches `main` until 1.2 ships.
8. ~~**`runCompanion` scope.**~~ **Answered (owner, 2026-11-20): official catalog plugins only in 1.2.3 (was 1.3; release moved 2026-11-23),**
   opened up later after a clean release. Original question: The new host method runs a tool inside an app the user picked, from a
   template fixed in the plugin's manifest. It is general (any plugin could declare one) but tightly
   bounded (rule 11). Accept it as general, or allow it only for official catalog plugins at first?
   Recommended: official catalog plugins only in the first release, opened up after a release without problems.
9. ~~**How to get the alternating Zn₄O orientation.**~~ **Answered (2026-11-20): no change to
   Crystal Builder is needed.** Its manual says one pcu cell cannot alternate, and a 2×2×2 build with
   its default settings gives real MOF-5 (Test results, "MOF-5 correctness"). The suggestion row asks
   for `repeat=2x2x2`; the target check stays. Plugin-side correction stays rejected (owner): the
   plugin builds nothing.
10. ~~**A stable API proposal to Crystal Builder's author.**~~ **Answered (owner, 2026-11-20): no
   contact.** Crystal Builder already builds the frameworks correctly, so there is nothing to ask for.
   The plugin pins the Crystal Builder versions it was tested with (1.1.1 now): it reads the version
   from `xtal capabilities --json`, refuses an untested version with a plain message naming the
   tested ones, and the release checklist re-runs the target checks before adding a new version.
11. **The 2×2×2 retry and the one-build rule (new, 2026-11-21).** The generic repeat rule in Decision
   1b (rebuild at 2×2×2 when "Joint twist left" is above zero) needs a second `mofBuild` run in one
   command, which rule 3 forbids today. Options: (a) the template declares one retry that may change
   only a named parameter (`"retry": {"param": "repeat", "values": ["2x2x2"]}`), shown in the consent
   box; (b) no retry: the result's message box offers **Rebuild at 2×2×2**, and that click starts a
   new command invocation; (c) keep presetting the repeat per table row and use the twist only to
   refuse the name. Recommended: (b), because every build stays one user action. The Kimi review
   (2026-11-21) also recommends (b), as a new host-authenticated user action with rule 3 unchanged;
   the plan is now written for (b) (task 1H). **Answered (owner, 2026-11-21 overnight): (b), the
   Rebuild button,** run by Rust from its result session (rule 16).
12. **Inherent format losses and master condition 3(d) (new, 2026-11-21, from the Kimi review).**
   Layout, labels, colors, implicit hydrogens made explicit, and the vacuum box are lost on every send
   by the nature of a 3D file. Owner question 2 chose a box only for specific losses; condition 3(d)
   reads as a box whenever anything is lost. Recommended: treat these as format behavior, always
   disclosed in the consent box, status line, and file, and amend condition 3(d) to say so.
   **Answered (owner, 2026-11-21 overnight): always disclose the inherent losses, with no checkbox or
   opt-out box.** Condition 3(d) is amended to match (2026-11-22).

For Crystal Builder's author: **nothing required.** No email is needed for the plan (owner, 2026-11-18); question 10 was answered no contact (owner, 2026-11-20). A1–A4 and A6 were
answered by testing on macOS and by reading its MIT source (see "Test results" under Decision 1b).
The Windows details (tab behavior, executable and folder names) are checked by the Windows session
against the official installer, and the app is picked by the user anyway. A5 (the window MCP server)
matters only for Phase 4 and can be read from its source when Phase 4 starts.

**No dependency on the author (owner, 2026-11-23).** There is no note to the author and none is
planned; A1–A5 are not blockers for any phase. Phase 1 is designed so nothing in the host depends on
an answer from the author; every app-specific fact is either read from the installed app or is data
in the plugin's manifest, never host code:

- **Which app:** the user picks it, and rule 6 records its identity (executable and tool hashes,
  code-signing identity) from the pick. No app name, bundle identifier, or folder is built in.
- **Where the tool is:** the manifest's `tool` entry, resolved inside the picked app (macOS) or
  beside the picked `.exe` (Windows), with the same path guards. A missing tool returns
  `tool-missing`; the path it looked for appears only in the host's own box (rule 8). If the installed layout differs from the source
  (`packaging/windows.spec`), the fix is a plugin manifest change, not a host release.
- **Which version:** the `preflight` step (`xtal capabilities --json`) reads the installed version;
  outside `testedVersions` the call fails with `version-untested` (rule 14). Supporting a new Crystal
  Builder release is a plugin manifest change after a real build plus `inspect`, not a host release.
- **Already-running behavior** (new tab, new window, or second copy): the host launches detached and
  never depends on which; the status line says only that the file was opened. Task 1C tests the
  launch with no assumption about it.
- **Windows names and tab behavior** stay checks for the Windows session on the official installer;
  a difference changes the plugin manifest or a docs line, never the host contract.

## Verification

- Per task: the task's own test files only (`pnpm vitest run <files>`, `cargo test <module>`).
- Per phase, when the machine is free: the full gauntlet in AGENTS.md §14, on CI's three hosts.
- Hands-on lists above, on macOS and Windows; the report names any platform not run as unverified.
- Chemistry check (§7): for each fixture, atom count, formula, and bond count in the CIF equal the drawn
  molecule's with explicit hydrogens; every loss in the table produces its warning or refusal.
- One-command build check: terephthalic acid + Zn²⁺ gives a build that matches the MOF-5 target checks
  as Crystal Builder itself reports them (net agreement and detected pcu from the build):
  `xtal inspect` detects Fm-3m (at 0.01 Å), a = 25.8–25.9 Å, Z = 8, 424 atoms, one framework, and
  the build reports "Joint twist left" 0.000 with 48 joints bonded and no overlaps, as the 2026-11-20
  `repeat=2x2x2` build gave (rings measured flat by hand then; the plugin does not claim to measure it). A pcu build at
  a ≈ 12.9 Å is a failure, whatever its fit numbers say: fit RMSD 0.000 and "net confirmed pcu"
  both passed on the wrong structure.
- Every other target in the suggestion table is checked the same way before its row ships.

## After approval (conductor's next steps, no code)

1. Create the folder `~/programming/chemdraw-wt/`, then a worktree `plan-crystal-builder` on new
   branch `plan/crystal-builder` off `origin/main`; save this plan there as
   `docs/plans/send-to-crystal-builder.md`; commit locally; do not push.
2. Send a three-line summary to the "Chemdraft master session".
3. Wait for its OK. No worker writes code before that.
