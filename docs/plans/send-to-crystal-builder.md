# Send to Crystal Builder: plugin plan

Status: plan approved by the owner 2026-11-10; no code until the master session OKs it. Target: after ChemDraft 1.2 ships (1.2 has priority; nothing here touches
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
4. **Keep §7:** the XYZ handoff warns about or refuses charge, stereo, and abbreviation loss, per the
   table in Decision 1.

## Context

Crystal Builder (github.com/JulesOpp/Crystal-Builder, MIT, Python/PySide6/VTK) builds crystals and
MOFs. ChemDraft draws the molecules that go into them. The owner wants a one-click "send what I drew
to Crystal Builder" that is fun, useful, and a good joint demo for a perspective article with Crystal
Builder's author: draw a linker in ChemDraft, click once, build the framework in Crystal Builder.

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

**Recommendation: a 3D XYZ file, built from the host's existing `chemistry.embed3d` (RDKit ETKDGv3,
seed 42) followed by `chemistry.minimize3d` (MMFF94s, `interfragment: false`).** One file per send.

Why not the others:

- **SMILES**: no documented file or CLI route into Crystal Builder; it would depend on an optional
  extra on the user's install, and Crystal Builder would redo the 3D embedding out of our sight.
- **CIF**: ChemDraft has no unit-cell object. Wrapping a molecule in an invented box would fabricate
  crystallography. CIF comes later, only once a cell can actually be drawn (Phase 4).
- **XYZ** is on Crystal Builder's supported list, is plain text, and uses API we already ship
  (`Plugin3DModel`: elements plus Angstrom coordinates). No new chemistry code in the host.

The file's comment line records provenance: source SMILES, net charge, `ETKDGv3 seed 42; MMFF94s;
gas-phase local minimum, not a crystal structure`, and the ChemDraft version (extended-XYZ keys if
Crystal Builder tolerates them, otherwise a plain comment; question A3 below).

### What is lost, and how the user is told (AGENTS.md §7)

| Item | What happens in XYZ | Handling |
|---|---|---|
| Bond orders, aromaticity | Not stored; Crystal Builder re-derives bonds from distances | Always disclosed: first-run consent text, status line after each send, comment line |
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
consent in Decision 3) and the status line says `Sent to Crystal Builder as a 3D XYZ model (bond
orders are not stored in XYZ)`. Nothing is ever dropped silently.

## Decision 1b: two sends, and marking connection points in ChemDraft

Crystal Builder's MOF builder needs a linker whose connection points (where it bonds to the metal
node) are marked. Marking them over there by hand undoes the "one click" promise, so the user marks
them **in ChemDraft**, where drawing is easy.

**How a connection point is marked: an ordinary atom labelled `X`.** On terephthalic acid the user
draws an `X` on each carboxylate carbon, where the acid OH would otherwise be. That is a normal
ChemDraft atom label: visible, saved with the document, editable, undoable, and it needs no new host
object or tool. PORMAKE, which Crystal Builder's MOF builder uses, is believed to mark connection
points with `X` atoms in its building blocks; this is from memory and must be confirmed (A6).

**Two commands:**

| Command | Accepts | Sends |
|---|---|---|
| **Send as MOF Linker** (main) | One molecule with at least two `X` atoms, each bonded to exactly one heavy atom by a single bond | XYZ with `X` atoms at the connection positions; comment line adds `connection points: n` |
| **Send as Molecule** | Any molecule with no `X` atoms | Plain 3D XYZ, as in Decision 1 |

Linker refusals, each naming the problem: fewer than two `X` atoms ("Mark at least two connection
points: draw an atom labelled X where the linker bonds to a metal node"); an `X` bonded to zero, two
or more atoms, or by a multiple bond; `X` in a molecule of several components.

**How the 3D model is built with `X` present** (pure plugin code, no host change): the force field
cannot type a dummy atom, so the plugin gives `embed3d` a SMILES in which each `X` becomes an explicit
`[H]`, minimizes as usual, then writes those atoms back out as `X` in the XYZ. Atom order is stable
across embedding and minimization (`chemistry3d.ts`), so the mapping is exact. The `X` sits at a C–H
distance (about 1.1 Å) along the bond to its anchor; if Crystal Builder expects a different distance
(for example a metal–O or C–C length), the plugin rescales along the same bond vector (A6). How an
`X` label reaches the plugin in the selection SMILES (as `*`, as an unknown label, or refused by the
host) is part of the Phase 0 code map (0.3); if the host refuses it, the plugin reads `X` atoms from the
selection's atom list instead, and no host change is planned without a separate decision.

**Optional, later: a "Mark Connection Points" command** (task 2G). The user selects anchor atoms and
the plugin adds `X` atoms at the right bond length and direction, as one labelled undo entry with the
new atoms selected (§4.4). It needs `document.write`, a dangerous permission, so it ships only if the
owner wants it (owner question 6). Drawing `X` by hand stays the documented way and is enough.

## Decision 2: how to hand it over

**Recommendation: (a) a host-written temporary file, opened with the app the user picked.**

| Route | Verdict | Reason |
|---|---|---|
| (a) Temp file + "open with this app" | **Use now** | Works on every Crystal Builder install with no setup; no network; the plugin never sees a path; the same launch shape on macOS and Windows |
| (b) `xtal` CLI | Reject | It has no command that loads a file into the window. We would spawn a second binary for no gain |
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
}
```

Rules the host enforces (each one gets a test):

1. **Two permissions.** New `apps.handoff`, added to `dangerousPluginPermissions`; manifest validation
   refuses it without `native.execute` (same pattern as `assistant.run`, `index.ts:377`). The capability
   is absent without both, and every method re-checks both.
2. **Explicit user action only.** Methods work only while one of the plugin's own commands is
   running, and that command must have been invoked by the user (menu, toolbar, shortcut). Analyzers,
   background work, and commands invoked by an assistant or MCP tool call are refused.
3. **One send per command invocation.** A refused or declined call does not use up the allowance
   (same rule as `dialogs.promptText`).
4. **The plugin never supplies a path, argv, environment, or verb.** It supplies text, a base name,
   and an allowlisted extension. The host renders the fixed command line.
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

Every `#[cfg(target_os = "macos")]` gets its `cfg(windows)` side in the same change. The command line
is built by one pure function that takes the platform as a parameter, so both branches are tested
from one host (§1, §14).

## Decision 4: where it lives

- **Plugin repository**: `jgassens/ChemDraft-CrystalBuilder-Plugin`, MIT code license, no bundled
  data (so no `dataLicenses`). Imports only `@chemdraft/plugin-api`.
- **Plugin id**: `org.chemdraft.handoff.crystalBuilder`. Display name: "Send to Crystal Builder".
- **Commands**: `plugin.crystalBuilder.sendLinker` (main, "Send as MOF Linker"),
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
| 0.2 Note to Crystal Builder's author (owner sends; conductor drafts) | Answers to A1–A6 below | Answers recorded in this document |
| 0.3 One read-only code map (single worker) | Short note: how a user-invoked command is told apart from an assistant-invoked one in `plugin-host`; what SMILES the selection snapshot carries for abbreviations, R-groups, and an atom labelled `X`, and whether the selection exposes per-atom labels and bonds; the consent store's shape | Note attached; no files changed |

### Phase 1: host capability (ChemDraft repo, branch `feat/app-handoff` off `origin/main` after 1.2)

| Task | Owned paths | Acceptance and tests | Review |
|---|---|---|---|
| 1A API contract | `packages/plugin-api/src/index.ts` (+ new `appHandoff.ts`, `appHandoff.test.ts`), header comment | Schemas for the three methods; permission added and marked dangerous; manifest refuses `apps.handoff` without `native.execute`; version 0.1.26. Tests: name sanitizing cases, extension allowlist, 5 MB and warning limits, permission pairing | Kimi |
| 1B Host gate | `packages/plugin-host/src/**` (capability wiring + tests) | Absent without both permissions; rejects outside the plugin's own command; rejects assistant-invoked commands; one send per invocation, refused calls not counted; worker and in-process paths behave the same | Kimi |
| 1C Native side | `apps/desktop/src-tauri/src/app_handoff/**`, `lib.rs` registration, `capabilities/app-handoff.json` (window `main` only) | Pure command-line builder tested for macOS and Windows from one host; picker accepts only `.app` / `.exe`; temp path and cleanup tests (backslashes, 8.3 paths, reserved names); consent store with revoke and clear-on-uninstall; app-changed detection; serde/Zod wire fixtures like `externalToolsWire.test.ts`; clippy clean on both `cfg` sides | Kimi |
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
| 2B XYZ writer | `src/xyz.ts` + test | Pure function, `Plugin3DModel` → text; fixed decimals, CRLF-free, atom count and order equal the model; comment line carries SMILES, net charge, method | Kimi |
| 2C Loss audit | `src/lossAudit.ts` + test | Pure function returning refusals and warnings exactly per the table in Decision 1, per send mode; fixtures: charged, isotopic, radical, unspecified stereo, salt, abbreviation, R-group, reaction member, metal complex, X atoms in a molecule send | Kimi |
| 2C2 Connection points | `src/connectionPoints.ts` + test | Pure functions: find `X` atoms and their anchors; validate per Decision 1b (fewer than two, wrong valence, multiple bond, several components each refused with its message); X→`[H]` SMILES rewrite; map embedded atoms back to `X` by index; optional rescale along the anchor bond. Fixtures: terephthalic-acid linker with 2 X, a tritopic linker with 3 X, a molecule with 1 X (refused), X on a double bond (refused) | Kimi |
| 2D Command flow | `src/send.ts` + test with a mocked context | Both send commands: empty selection, cancelled picker, declined consent, embed failure, minimize failure, linker refusals, and success each produce the specified message; one send per command | Kimi |
| 2E Package and release | package zip, checksum, release body markers | Installs by hand through Add plugin from package on both platforms | Kimi |
| 2G (optional, owner question 6) Mark Connection Points | `src/markConnectionPoints.ts` + test; manifest adds `document.write` | Selected anchors get `X` atoms at bond length along the open direction, through `documents.applyPatch`, one labelled undo entry, new atoms selected (§4.4); anchors with no free valence refused by name; chemistry of the anchor molecule otherwise unchanged (§7 test: canonical SMILES with X removed equals the original) | Kimi |

Hands-on, both platforms, with Crystal Builder installed by the owner (agents do not install it):
terephthalic acid with two `X` atoms sent as a MOF linker, then built into a framework with Crystal
Builder's MOF builder (the demo; confirm the connection points are recognized without re-marking);
the same molecule without `X` (linker send refused with its message); benzene as a molecule; a charged species; a molecule with one unspecified
center; a salt; an abbreviation; an R-group (refused); a ferrocene-like complex (expect an honest
refusal or warning); confirm the structure appears in Crystal Builder and matches atom count and
formula.

### Phase 3: catalog and docs (ChemDraft repo)

One task: catalog entry, the four capability URLs, `pluginUpdates.test.ts`, AUTHORING catalog
paragraph, move the slice to `docs/shipped/README.md`. Acceptance: one-click install from **Add or
Remove Plugins** on macOS and Windows; update check finds a newer release. Kimi review; gauntlet.

### Phase 4: later, with the author (not scheduled)

- "Open in the running window" and "build a MOF from this linker in one step" (pick a net and node
  in ChemDraft, call `mof.build`) through Crystal Builder's MCP `open(path)` and `mof.build`, once the
  author confirms a stable contract and token handling. The linker send in Phase 2 already carries the
  connection points; this only removes the steps inside Crystal Builder.
- CIF export when ChemDraft can draw a unit cell.
- Return trip: a fragment from Crystal Builder back onto the ChemDraft page (through proposals).

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
   without it first; add it if the demo feels clumsy.

For Crystal Builder's author (owner relays):

- A1. Does a plain XYZ with no lattice open as a molecule? Are extra extended-XYZ comment keys tolerated?
- A2. What happens when a file is opened while the app is already running: new tab, new window, or a second copy? Same on macOS and Windows?
- A3. What is the macOS bundle identifier, and the Windows executable and install folder names? Will they stay stable?
- A4. Would they add `.xyz` to the declared document types, or accept a pull request for it?
- A5. Is the window MCP server (`open(path)`, `mof.build`) shipped and stable enough to build Phase 4 on?
- A6. How should a linker arrive so the MOF builder uses it without re-marking: an XYZ with `X` atoms
  at the connection points (as in PORMAKE building blocks)? At what distance from the anchor atom?
  If XYZ is not enough, which format does "Mark connection points" save?

## Verification

- Per task: the task's own test files only (`pnpm vitest run <files>`, `cargo test <module>`).
- Per phase, when the machine is free: the full gauntlet in AGENTS.md §14, on CI's three hosts.
- Hands-on lists above, on macOS and Windows; the report names any platform not run as unverified.
- Chemistry check (§7): for each fixture, atom count and formula in the XYZ equal the drawn
  molecule's with explicit hydrogens; every loss in the table produces its warning or refusal.

## After approval (conductor's next steps, no code)

1. Create the folder `~/programming/chemdraw-wt/`, then a worktree `plan-crystal-builder` on new
   branch `plan/crystal-builder` off `origin/main`; save this plan there as
   `docs/plans/send-to-crystal-builder.md`; commit locally; do not push.
2. Send a three-line summary to the "Chemdraft master session".
3. Wait for its OK. No worker writes code before that.
