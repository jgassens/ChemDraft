# Send to Crystal Builder: plugin plan

Status: plan approved by the owner 2026-11-10; revised 2026-11-20 for the one-command build and the
return trip (owner direction below), and again the same afternoon after the hand-built "MOF-5" turned
out to be the wrong structure (see "MOF-5 correctness" under Test results; open question 9). The new `runCompanion` method widens the security contract, so the
master session's OK and the Kimi review (condition 3) cover it too. No code until the master session OKs it. Target: after ChemDraft 1.2 ships (1.2 has priority; nothing here touches
`release/1.2-rc` or `main`). Final home of this document: `docs/plans/send-to-crystal-builder.md` on
local branch `plan/crystal-builder` (see "After approval").

## Master session conditions (2026-11-10)

Approved in principle, with these conditions:

1. **No code until 1.2 ships.** This is 1.3 work; plugin API 0.1.26 lands with 1.3, not 1.2 or
   1.2.1, unless the owner says otherwise.
2. **Build phase runs from a MacBook session** (agentctl lives there).
3. **Before any code:** one Kimi high review of this plan, after the 1.2 big review, focused on the
   `apps.handoff` security contract: user consent, no path or argument injection, the app picked by
   the user and never by the plugin, and macOS/Windows parity.
   **Consent: resolved, pending Kimi** (master, 2026-11-10). One-time consent per plugin and app is
   accepted, provided (a) every handoff still comes only from a user-started command; (b) the consent
   is listed and revocable in Preferences or the plugin's settings; (c) a different app, or a changed
   app path or bundle ID, asks again; (d) the loss message box shows every time something would be
   lost. This settles owner question 2.
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
   accepted only through a GUI command that needs its optional RDKit extra. Builds are unsigned.
   The macOS bundle identifier and the single-instance behavior are not documented.

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
| Stereo flags (wedges, E/Z) | Specified stereo survives only as geometry. Unspecified centers and "either" bonds get one arbitrary 3D configuration | **Warn before send** when anything is unspecified, counting the centers and bonds |
| Several molecules or a salt | Components sit side by side; their relative position means nothing | **Warn before send** |
| Abbreviations, superatoms | Must expand to real atoms | Expanded when the host's SMILES already does so; otherwise **refuse**, naming the label |
| Connection-point atoms labelled `X` (Decision 1b) | **Send as MOF Linker**: kept as `X` atoms at the connection positions. **Send as Molecule**: not chemistry | Linker send: always disclosed ("2 connection points marked"). Molecule send: **refuse**, naming the X atoms and pointing to Send as MOF Linker |
| R-groups, atom lists, polymer brackets, repeat units | Cannot be a single 3D molecule | **Refuse**, naming the object |
| Reaction context (arrows, roles, conditions, atom maps) | Dropped; only the selected molecules go | **Warn before send** if the selection is part of a reaction |
| Embedding or minimization fails (common with metals) | No coordinates | **Refuse** with the specific engine reason; never send unminimized or made-up geometry without saying so |

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
phosphonates) are refused by name in Phase 2, not guessed.

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
| Zn²⁺ ions (any count), with or without O²⁻ | ditopic carboxylate | net `pcu`, node `N16` (Zn₄O(CO₂)₆), **alternating node orientation, 2×2×2** (see below) | MOF-5 family (IRMOF) |
| nothing | ditopic carboxylate | same, labelled "suggested; no metal drawn" | as above |
| Cu²⁺ | tritopic carboxylate | net `tbo`, Cu paddlewheel node (catalog id from the Phase 0 code map) | HKUST-1, only after it passes the same target check |
| anything else | any | no suggestion; the user picks from Crystal Builder's node list | — |

Drawn ions only pick the node; they are never sent as atoms, because a 2D drawing of four loose
ions is not the cluster's geometry (the 2026-11-20 demo showed this). The dialog says so: "Node N16
(Zn₄O) from Crystal Builder's library, matching the Zn²⁺ you drew". The user can change net,
node, and repeat before building.

**A suggested build must reproduce its target, or it is not named after it (added 2026-11-20).** The
pcu/N16 build with Crystal Builder's default (`orientation=consistent`, 1×1×1) is *not* MOF-5: every
Zn₄O cluster has the same orientation, so the two carboxylates of each linker lie in perpendicular
planes and every benzene ring is twisted 45° from both (Crystal Builder detects P222; see "MOF-5
correctness" below). Real MOF-5 alternates the cluster orientation on neighboring sites: Fm-3m,
a ≈ 25.8 Å, Z = 8, 424 atoms, linkers flat. So each row of the suggestion table carries a **target
record** (space group, cell edge within 2%, Z, formula, maximum ring–carboxylate twist 10°), and after
every build the plugin runs Crystal Builder's own `xtal inspect` on the output (a second fixed
companion template, `inspect`) and compares:

- **Match:** the status line names the material ("MOF-5: Fm-3m, a = 25.87 Å, 424 atoms").
- **No match:** the framework still opens, but the status line says what it is and why it is not the
  target, for example "Zn₄O–terephthalate pcu net, P222, a = 12.94 Å: linkers twisted 45°, not MOF-5".
  A material name never appears for a structure that failed its check (§7, §8: no fabricated claims).

How the alternating orientation is obtained is open question 9: Crystal Builder 1.1.1's
`mof.build` offers only `orientation=consistent` or `as-found`, and `repeat=2x2x2` alone keeps one
orientation.

Linker refusals, each naming the problem: fewer than two `X` atoms ("Mark at least two connection
points: draw an atom labelled X where the linker bonds to a metal node"); an `X` bonded to zero, two
or more atoms, or by a multiple bond; `X` in a molecule of several components.

**How the 3D model is built with `X` present** (pure plugin code, no host change): the force field
cannot type a dummy atom, so the plugin gives `embed3d` a SMILES in which each `X` becomes an explicit
`[H]`, minimizes as usual, then writes those atoms back out as `X` in the CIF, bonded to their anchors. Atom order is stable
across embedding and minimization (`chemistry3d.ts`), so the mapping is exact. The `X` sits at a C–H
distance (about 1.1 Å) along the bond to its anchor. Tested: the builder accepts 1.09 Å as well as
PORMAKE's own 0.75 Å, so no rescaling is needed. How an
`X` label reaches the plugin in the selection SMILES (as `*`, as an unknown label, or refused by the
host) is part of the Phase 0 code map (0.3); if the host refuses it, the plugin reads `X` atoms from the
selection's atom list instead, and no host change is planned without a separate decision.

**Optional, later: a "Mark Connection Points" command** (task 2G). The user selects anchor atoms and
the plugin adds `X` atoms at the right bond length and direction, as one labelled undo entry with the
new atoms selected (§4.4). It needs `document.write`, a dangerous permission, so it ships only if the
owner wants it (owner question 6). Drawing `X` by hand stays the documented way and is enough.

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
| MOF-5 correctness (2026-11-20, rehearsal) | **The default build is wrong; the alternating cell is right.** Rebuilt from a fresh drawing: every Zn is ZnO₄ (1.92–1.94 Å) and every linker is intact, but each ring is twisted 45.0° from both of its carboxylates, and `xtal symmetry` gives P222, not Fm-3m; the 12.936 Å cell holds one cluster orientation. The owner saw it in the window and called it "a box full of nonsense". A script that keeps Crystal Builder's own N16 cluster, inverts it on alternate sites of a 2×2×2 cell, and lays each ring in its carboxylate plane gives a = 25.872 Å, Z = 8, 424 atoms (Zn₃₂O₁₀₄C₁₉₂H₉₆), one framework, 0.00° twist, closest contact 1.08 Å (C–H); `xtal inspect` detects Fm-3m at 0.01 Å (R3m at the strictest tolerance, from rounded coordinates). Positions are idealized, not minimized | `mof5_alternate.py`, `xtal symmetry`, `xtal inspect`; Intel iMac |
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
  macOS, the Start-menu Programs folder on Windows). No hard-coded paths, no bundle-ID lookup (Crystal
  Builder's ID is undocumented), no registry reads, no PATH search. The host remembers the pick.
- **macOS**: accept only a `.app` bundle; launch with `/usr/bin/open -a <bundle> -- <file>` (argument
  array, no shell). This routes to the running instance when the app supports it.
- **Windows**: accept only a `.exe` (a picked Start-menu shortcut resolves to its target; `.bat`,
  `.cmd`, `.lnk`, `.ps1` targets are refused because their quoting rules are unsafe); launch with
  `std::process::Command` and the file as one argument. No `ShellExecute` verbs, no `cmd /c`.
- **Both**: the process is detached; the host does not read its output, wait for it, or kill it on
  quit. Unsigned Crystal Builder builds may trigger Gatekeeper or SmartScreen on first run; that
  prompt belongs to the OS and the user, and our error text says so.

## Decision 3: the host gap (smallest general capability)

New API, `PluginApiVersion` 0.1.25 → **0.1.26** (additive, patch bump per §4.1). Sketch for workers;
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
  /** Added 2026-11-20 for the one-command build. Run a companion tool shipped inside the chosen app,
   *  using a command template the plugin DECLARED IN ITS MANIFEST, then optionally open its output. */
  runCompanion(request: {
    appId: string;
    template: string;                 // id of a manifest-declared template, e.g. "mofBuild"
    params: Record<string, string>;   // each checked against the template's declared enum or pattern
    inputs?: { name: string; extension: PluginHandoffExtension; text: string }[]; // written to a host temp dir
    openOutput?: boolean;             // open the declared output file with the app afterwards
  }): Promise<{ status: "done"; stdout: string /* ≤ 1 MB, JSON if the template says so */; opened: boolean } |
              { status: "declined" } |
              { status: "failed"; code: "app-missing" | "app-changed" | "tool-missing" | "bad-param" | "timeout" | "exit-nonzero" | "write-failed"; message: string }>;
}
```

The manifest declares each template in full, so consent can show it and review can read it:

```json
"companions": [{
  "id": "mofBuild",
  "tool": { "macos": "Contents/MacOS/xtal", "windows": "xtal.exe" },
  "args": ["run", "mof.build", "-p", "topology={topology}", "-p", "nodes={node}",
           "-p", "edges={edge}", "-p", "bb_dir={inputDir}", "-p", "repeat={repeat}",
           "-o", "{outputFile:cif}", "--json"],
  "params": { "topology": { "pattern": "^[a-z]{3}(-[a-z0-9]+)?$" },
              "node": { "pattern": "^[A-Za-z0-9_]{1,32}$" },
              "edge": { "pattern": "^[A-Za-z0-9_]{1,32}$" },
              "repeat": { "pattern": "^[1-4]x[1-4]x[1-4]$" } },
  "timeoutSeconds": 120
}, {
  "id": "inspect",
  "after": "mofBuild",
  "tool": { "macos": "Contents/MacOS/xtal", "windows": "xtal.exe" },
  "args": ["inspect", "{previousOutput}", "--json"],
  "timeoutSeconds": 60
}]
```

A template with `after` (added 2026-11-20 for the target check in Decision 1b) takes no plugin
parameters and no plugin text: its only input is the file the named template just wrote, and it
writes nothing. It may run once, right after that template, in the same command invocation.

Rules the host enforces (each one gets a test):

1. **Two permissions.** New `apps.handoff`, added to `dangerousPluginPermissions`; manifest validation
   refuses it without `native.execute` (same pattern as `assistant.run`, `index.ts:377`). The capability
   is absent without both, and every method re-checks both.
2. **Explicit user action only.** Methods work only while one of the plugin's own commands is
   running, and that command must have been invoked by the user (menu, toolbar, shortcut). Analyzers,
   background work, and commands invoked by an assistant or MCP tool call are refused.
3. **One send per command invocation** (`sendFile` or `runCompanion`, not both). A refused or
   declined call does not use up the allowance (same rule as `dialogs.promptText`). The one exception
   is a declared `after` template, which may follow its parent once and reads only the parent's output.
4. **The plugin never supplies a path, free argv, environment, or verb at run time.** It supplies
   text, a base name, an allowlisted extension, and for `runCompanion` only the id of a template fixed
   in its manifest plus parameter values checked against that template (rule 11). The host renders
   the command line.
5. **Consent per plugin and per app**, once, in a native message box that names the plugin (name and
   id), the app's display name and location, and says the plugin will start that app and give it a
   file each time its command runs. Stored like external-tool consent
   (`src-tauri/src/external_tools/consent.rs` is the pattern), listed and revocable in the Plugin
   Manager, cleared on uninstall.
6. **The app is re-confirmed if it changes**: the host records path, size, modified time, and on
   macOS the bundle identifier. A mismatch returns `app-changed` and asks again.
7. **Temp files are the host's**: `<app cache>/handoff/<pluginId>/<random>/<name>.<ext>`, built with
   `path` APIs; the name is stripped of separators, control characters, Windows reserved names, and
   trailing dots or spaces; anything older than 24 hours is removed at startup. (The other app may
   still hold the file, so it cannot be deleted right after the send.)
8. **Specific errors** (§13): for example `Send to Crystal Builder failed: "Crystal Builder.app" is no
   longer at /Applications. Choose the app again.`
9. **Web build and other hosts**: the capability rejects with a plain error and the same shape.
10. **No new Rust dependency**: `std::process::Command` plus the existing `tauri-plugin-dialog`. No
    shell or opener plugin is added, so no broad "open anything" surface appears in the webview.
11. **`runCompanion` runs only what the manifest declared** (added 2026-11-20). The tool path is
    resolved inside the chosen app's folder (bundle on macOS, install folder on Windows), with `..`,
    symlinks out of it, and absolute paths refused. Arguments are the declared template only; every
    `{param}` fills one whole argument, matches its declared enum or pattern, and can never add an
    argument. `{inputDir}` and `{outputFile:ext}` are host paths in the handoff temp folder. No shell,
    no environment from the plugin, a hard timeout that kills the process tree, stdout capped at 1 MB,
    stderr kept for the error message. Windows: `CREATE_NO_WINDOW`, so no console flashes.
12. **Consent names the template.** The one-time consent box for a companion shows the tool's name
    and the declared command line with its placeholders ("xtal run mof.build … -o <output>.cif"). A
    changed template in a plugin update asks again.

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
  (re-pick); optional later `plugin.crystalBuilder.markConnectionPoints` (task 2G).
  **Menus**: `menu.crystalBuilder.sendLinker`, `menu.crystalBuilder.sendMolecule`,
  `menu.crystalBuilder.chooseApp`, location `plugins`.
- **Permissions**: `selection.read`, `chemistry.compute`, `apps.handoff`, `native.execute`,
  `plugin.storage`, `ui.menu`. `apiVersion: "^0.1.26"`. Nothing else: no network, no clipboard, no
  filesystem, no document write. (Only the optional task 2G would add `document.write`.)
- **Release assets**: `crystal-builder-handoff-X.Y.Z.zip` and `.zip.sha256`, with the two release-body
  markers (`ChemDraft-Plugin-API: ^0.1.26`, `ChemDraft-Min-App:` the first app version with 0.1.26).
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
| 0.4 Crystal Builder source map (same single worker, after 0.3) | Short note from its MIT source: the node and net ids in `xtal/mof/catalog.py` (Zn₄O = N16 confirmed; the Cu paddlewheel id); what `mof.build --json` prints (fit numbers, formula, output path) and its exit codes; whether `bb_dir` accepts a CIF block or only PORMAKE XYZ; how `orientation` is implemented and where an `alternating` choice would go (input to open question 9); what `xtal inspect --json` prints for space group, Z, and coordination; the Windows `xtal` executable name and location in the installer | Note attached; no files changed |

### Phase 1: host capability (ChemDraft repo, branch `feat/app-handoff` off `origin/main` after 1.2)

| Task | Owned paths | Acceptance and tests | Review |
|---|---|---|---|
| 1A API contract | `packages/plugin-api/src/index.ts` (+ new `appHandoff.ts`, `appHandoff.test.ts`), header comment | Schemas for the four methods and the manifest `companions` block; permission added and marked dangerous; manifest refuses `apps.handoff` without `native.execute`, and refuses a template whose placeholder is undeclared or sits inside a larger argument; version 0.1.26. Tests: name sanitizing cases, extension allowlist, 5 MB and warning limits, permission pairing, template and param-pattern validation | Kimi |
| 1B Host gate | `packages/plugin-host/src/**` (capability wiring + tests) | Absent without both permissions; rejects outside the plugin's own command; rejects assistant-invoked commands; one send per invocation, refused calls not counted; worker and in-process paths behave the same | Kimi |
| 1C Native side | `apps/desktop/src-tauri/src/app_handoff/**`, `lib.rs` registration, `capabilities/app-handoff.json` (window `main` only) | Pure command-line builder tested for macOS and Windows from one host; companion runner per rule 11 (tool resolved inside the app folder, symlink and `..` escapes refused, timeout kills the tree, 1 MB stdout cap, no console window on Windows), tested with a stub tool on both platforms; picker accepts only `.app` / `.exe`; temp path and cleanup tests (backslashes, 8.3 paths, reserved names); consent store with revoke and clear-on-uninstall; app-changed detection; serde/Zod wire fixtures like `externalToolsWire.test.ts`; clippy clean on both `cfg` sides | Kimi |
| 1D Desktop wiring | `apps/desktop/src/appHandoff/**`, plugin runtime hookup, Plugin Manager consent rows | Native message boxes for consent and warnings (no in-viewport dialog, §12); status-line success; specific errors; consent visible and revocable | Kimi |
| 1E Docs and closeout | `docs/plugin-architecture/AUTHORING.md` (new section + version table row), AGENTS.md §4.1 version line, `docs/manual-stress-checklist.md`, `docs/plans/PLANS.md`, build stamp | Docs match the code; a short AUTHORING example ("send a text file to an app the user picked"); gauntlet green | Kimi |

Hands-on, both platforms (owner's MacBook for macOS UI; the Intel iMac checks only processor-specific
behavior; Windows on the CI-built installer): pick an app; decline consent; accept; send; revoke and
resend; move the app and resend (expect `app-changed` / `app-missing`); file name with spaces,
non-ASCII characters, and a reserved name; palettes keep focus rules; no console flash on Windows;
quitting ChemDraft leaves the other app running.

### Phase 2: the plugin (new repository)

| Task | Owned paths | Acceptance and tests | Review |
|---|---|---|---|
| 2A Scaffold | manifest, `src/index.ts`, `src/workerEntry.ts`, LICENSE, README | Manifest parses; boundary rule holds (only `@chemdraft/plugin-api`) | Kimi |
| 2B CIF writer | `src/cif.ts` + test | Pure function, `Plugin3DModel` plus bonds → text in the Decision 1 format: P1 box with 5 Å vacuum, unique labels, `_geom_bond` loop with `_xtal_bond_order` and `_xtal_bond_kind explicit`; fixed decimals, LF only, atom count and order equal the model; provenance comments. Golden-file test of the exact text for the terephthalate linker (guards the private-tag risk) | Kimi |
| 2C Loss audit | `src/lossAudit.ts` + test | Pure function returning refusals and warnings exactly per the table in Decision 1, per send mode; fixtures: charged, isotopic, radical, unspecified stereo, salt, abbreviation, R-group, reaction member, metal complex, X atoms in a molecule send | Kimi |
| 2C2 Connection points | `src/connectionPoints.ts` + test | Pure functions: find `X` atoms and their anchors; validate per Decision 1b (fewer than two, wrong valence, multiple bond, several components each refused with its message); X→`[H]` SMILES rewrite; map embedded atoms back to `X` by index. Fixtures: terephthalate linker (benzene ring with X in place of each COOH, PORMAKE E14 cut), a tritopic linker with 3 X, a molecule with 1 X (refused), X on a double bond (refused) | Kimi |
| 2C3 Automatic cut | `src/carboxylateCut.ts` + test | Pure function: each COOH / COO⁻ on carbon → one `X` at the ring C–carboxyl C midpoint, per Decision 1b; skipped when the selection already has `X`; other connecting groups refused by name. Fixtures: terephthalic acid → C₆H₄X₂ matching the 2026-11-20 block; disodium terephthalate; trimesic acid → 3 X; nicotinic acid (pyridyl refused) | Kimi |
| 2H Build MOF command | `src/buildMof.ts`, `src/nodeSuggest.ts` + tests, manifest `companions.mofBuild` | Node and net suggestion per the Decision 1b table (drawn Zn²⁺ → N16/pcu with alternating orientation per open question 9; Cu²⁺ + tritopic → paddlewheel/tbo; else no suggestion); one native dialog to confirm or change net, node, repeat; then one `runCompanion` call with the linker block as input and `openOutput: true`, then the `inspect` template on the output; `src/targetCheck.ts` compares it with the row's target record (space group, cell within 2%, Z, formula, ring–carboxylate twist ≤ 10°) and names the material only on a match. Mocked-context tests: success, user cancels, tool missing, timeout, nonzero exit with Crystal Builder's message passed through, net mismatch reported; **the 2026-11-20 twisted P222 build (fixture) must not be called MOF-5, and the Fm-3m cell must be** | Kimi |
| 2D Command flow | `src/send.ts` + test with a mocked context | Both send commands: empty selection, cancelled picker, declined consent, embed failure, minimize failure, linker refusals, and success each produce the specified message; one send per command | Kimi |
| 2E Package and release | package zip, checksum, release body markers | Installs by hand through Add plugin from package on both platforms | Kimi |
| 2G (optional, owner question 6) Mark Connection Points | `src/markConnectionPoints.ts` + test; manifest adds `document.write` | Selected anchors get `X` atoms at bond length along the open direction, through `documents.applyPatch`, one labelled undo entry, new atoms selected (§4.4); anchors with no free valence refused by name; chemistry of the anchor molecule otherwise unchanged (§7 test: canonical SMILES with X removed equals the original) | Kimi |

Hands-on, both platforms, with Crystal Builder installed by the owner (agents do not install it):
**the one-command demo first**: draw terephthalic acid and four Zn²⁺, select both, Build MOF in
Crystal Builder…, accept the suggested pcu/N16, and MOF-5 (Fm-3m, a ≈ 25.9 Å, Z = 8, 424 atoms, flat linkers)
opens in the window with no other clicks, and the status line names it only because the check passed; then
a benzene ring with `X` in place of each COOH (terephthalate) sent as a MOF linker, then built into MOF-5 with node N16 in Crystal
Builder's MOF builder (the demo; Save as a building block must report "2-connected" with no
re-marking or hand-drawn bonds);
the same molecule without `X` (linker send refused with its message); benzene as a molecule; a charged species; a molecule with one unspecified
center; a salt; an abbreviation; an R-group (refused); a ferrocene-like complex (expect an honest
refusal or warning); confirm the structure appears in Crystal Builder and matches atom count and
formula.

### Phase 3: catalog and docs (ChemDraft repo)

One task: catalog entry, the four capability URLs, `pluginUpdates.test.ts`, AUTHORING catalog
paragraph, move the slice to `docs/shipped/README.md`. Acceptance: one-click install from **Add or
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
| 5D Export | `export-engine` | SVG and PDF draw the current projection exactly as the canvas does; CDXML writes the projection as graphics with a warning that the 3D cell is not kept; the native `.chemdraft` file keeps everything; **Send back to Crystal Builder** re-sends the stored CIF unchanged |
| 5E Optional automation | plugin | "Bring back from Crystal Builder" after a 2H build: the host already holds the output CIF from `runCompanion`, so one command inserts it as a `crystal3d` object, with no file dialog |

The picture-only fallback was considered and dropped (owner, 2026-11-20).

## Open questions

For the owner:

1. **Release target.** Ship the host capability in the first release after 1.2 (API 0.1.26)? Recommended: yes.
2. **How often to ask.** Consent once per plugin and app, then a message box only when something
   specific would be lost (recommended), or a confirmation on every send?
3. **Minimize or not.** Send the MMFF94s-minimized geometry (recommended) or raw ETKDG coordinates?
4. **Names.** Are `jgassens/ChemDraft-CrystalBuilder-Plugin`, `org.chemdraft.handoff.crystalBuilder`,
   and "Send to Crystal Builder" acceptable, and does the author agree to their app's name in our catalog?
5. **Agent tooling on this iMac.** `agentctl`, `~/.agentctl/`, and `~/programming/chemdraw-wt/` do
   not exist on this machine. Should the workers run from the MacBook, with this session only conducting?
6. **Mark Connection Points command.** Ship the optional one-click marker (task 2G, adds the dangerous
   `document.write` permission), or keep "draw an atom labelled X" as the only way? Recommended: ship
   without it first; add it if the demo feels clumsy. (2026-11-20: less needed now; the automatic
   cut in Decision 1b covers the common case.)
7. ~~**A 3D object in the core (Phase 5).**~~ **Answered yes (owner, 2026-11-20):** the "3D molecular
   visualization" non-goal (PLAN.md §5) is lifted for one native `crystal3d` object that can be moved,
   rotated, and exported. The picture-only fallback is dropped. The PLAN.md §5 wording changes in
   Phase 5's first pull request (task 5A), not before, since nothing touches `main` until 1.2 ships.
8. **`runCompanion` scope.** The new host method runs a tool inside an app the user picked, from a
   template fixed in the plugin's manifest. It is general (any plugin could declare one) but tightly
   bounded (rule 11). Accept it as general, or allow it only for official catalog plugins at first?
   Recommended: official catalog plugins only in 1.3, opened up after a release without problems.
9. **How to get the alternating Zn₄O orientation (added 2026-11-20).** Crystal Builder's builder
   cannot make real MOF-5 today. Options:
   (a) **Fix it upstream** (recommended): a small pull request to Crystal Builder (MIT) adding
   `orientation=alternating` to `mof.build` for nets whose nodes sit on a bipartite lattice, with
   MOF-5 as its test. The builder stays the one place that builds frameworks, and the plugin only
   passes a parameter. This reverses the "no contact with the author" decision for this one item.
   ~~(b) The plugin corrects the output itself.~~ **Rejected (owner, 2026-11-20):** it would need a
   hand-written fix for each net and node whose default build is wrong, so the plugin would have to
   know how to build MOFs. The plugin builds nothing; Crystal Builder builds, the plugin only checks.
   (c) Drop the Zn → pcu/N16 suggestion until (a) lands; the user can still build pcu by hand, and the
   target check keeps it from being called MOF-5.
   Recommended: (a), with (c) as the state at 2H if (a) has not merged by then.

For Crystal Builder's author: **none.** No email is needed (owner, 2026-11-18). A1–A4 and A6 were
answered by testing on macOS and by reading its MIT source (see "Test results" under Decision 1b).
The Windows details (tab behavior, executable and folder names) are checked by the Windows session
against the official installer, and the app is picked by the user anyway. A5 (the window MCP server)
matters only for Phase 4 and can be read from its source when Phase 4 starts.

## Verification

- Per task: the task's own test files only (`pnpm vitest run <files>`, `cargo test <module>`).
- Per phase, when the machine is free: the full gauntlet in AGENTS.md §14, on CI's three hosts.
- Hands-on lists above, on macOS and Windows; the report names any platform not run as unverified.
- Chemistry check (§7): for each fixture, atom count, formula, and bond count in the CIF equal the drawn
  molecule's with explicit hydrogens; every loss in the table produces its warning or refusal.
- One-command build check: terephthalic acid + Zn²⁺ gives MOF-5 as Crystal Builder itself reports it:
  `xtal inspect` detects Fm-3m (at 0.01 Å), a = 25.8–25.9 Å, Z = 8, 424 atoms, one framework, every
  ring within 10° of its carboxylates. Equal atoms to the corrected 2026-11-20 cell
  (`MOF5_alternating.cif`). A pcu build at a ≈ 12.9 Å is a failure, whatever its fit numbers say:
  fit RMSD 0.000 and "net confirmed pcu" both passed on the wrong structure.
- Every other target in the suggestion table is checked the same way before its row ships.

## After approval (conductor's next steps, no code)

1. Create the folder `~/programming/chemdraw-wt/`, then a worktree `plan-crystal-builder` on new
   branch `plan/crystal-builder` off `origin/main`; save this plan there as
   `docs/plans/send-to-crystal-builder.md`; commit locally; do not push.
2. Send a three-line summary to the "Chemdraft master session".
3. Wait for its OK. No worker writes code before that.
