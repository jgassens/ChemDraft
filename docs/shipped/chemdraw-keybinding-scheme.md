# ChemDraw-compatible keybinding scheme — shipped

**Status: complete.** A Preferences toggle (Preferences ▸ Keyboard shortcuts) switches the whole app
between the native ChemDraft bindings and a ChemDraw-compatible scheme, so users migrating from
ChemDraw keep their muscle memory. Persisted in `localStorage` (`chemdraft.keybindings.v1`),
applied live to every window, default remains `chemdraft`.

## Where it lives

| Piece | File |
| --- | --- |
| Setting (type, persistence, guards) | `apps/desktop/src/keybindingSettings.ts` |
| The scheme itself (registry overrides + hover hotkey maps) | `apps/desktop/src/keybindingScheme.ts` |
| Registry application (main window) | `MainWindow.tsx` — `toolCommandSpecs` / `shellCommandSpecs` / `shortcutCommands` memos |
| Registry application (detached palettes) | `PaletteWindow.tsx` — `allCommands` memo + its own settings listener |
| Scheme-aware hover ladder | `MainWindow.tsx` — `hoveredNativeTargetShortcutCommand(target, key, scheme)` |
| Cross-window live sync | `window-manager/index.ts` — `KEYBINDING_SETTINGS_EVENT`, `broadcastKeybindingSettings`, `listenForKeybindingSettings` |
| Native macOS menu accelerators | `src-tauri/src/lib.rs` — `KeybindingSchemeState`, `set_keybinding_scheme` (rebuilds the menu); JS pushes via `pushKeybindingSchemeToNativeMenu` on startup and change |
| Web menu-bar labels | `appMenu.ts` — `AppMenuContext.keybindingScheme` |
| Preferences UI | `PreferencesWindow.tsx` — "Keyboard shortcuts" radio group |

## Design rules the scheme follows

- **Behavioral parity, not transcription.** The mapping pairs ChemDraft commands with the keys
  ChemDraw users expect (derived from observed ChemDraw 23 behavior). ChemDraw actions with no
  ChemDraft equivalent are deliberately absent — their keys do *nothing*, never something surprising.
  Per AGENTS.md §12 UI, no proprietary shortcut documentation is copied into the repo.
- **Full replacement, not overlay.** The shortcut engine disables *both* commands on a conflicting
  chord, so `applyKeybindingSchemeToCommands` clears every ChemDraft default whose key means
  something else in ChemDraw (`null` entries), and clears `defaultShortcut` too — the engine falls
  back `shortcut ?? defaultShortcut`.
- **Hover hotkeys are case-sensitive under the ChemDraw scheme** (`b` → Br vs `B` → boron,
  `c` → C vs `C` → Cl), matching ChemDraw; the ChemDraft ladder stays case-insensitive.

## What the ChemDraw scheme covers

- **Tools:** Space → select, `x` → bond, `Shift+X` → chain, `j` → benzene, `t` → text,
  `Shift+T` → bracket, `e` → reaction arrow. ChemDraft's single-letter tool keys (V/L/M/C/R/E/+/−)
  are released — E belongs to the arrow tool in this scheme, so the eraser (which holds E in the
  ChemDraft scheme) is unbound here.
- **Hovered atom:** element relabels (`h c n o f p s i` plus `w`→N, `q`→O, `l`/`C`→Cl, `b`→Br,
  `B`→B, `L`→Li, `S`→Si), nickname labels (`d`→D, `e`→Et, `E`→CO2Me, `F`→CF3, `H`→Cbz, `m`→Me,
  `M`→MgBr, `N`→NO2, `O`→OMe, `P`→Ph, `Q`→Fmoc, `r`→R, `x`→X, `y`→Boc, `Z`→N3, `!`→?), `+`/`−`
  charge, and the full numeric drawing row: `1` grow bond,
  `2` carbonyl (sprouting a new carbon to carry the C=O when the hovered atom can't),
  `3`/`a` attach benzene, `4`/`5` wedge/hashed methyl sprouts, `6` cyclohexane, `7` cyclopentane,
  `8` methylidene C=CH2, `9` gem-dimethyl, and `0` cyclic bond (each press turns the same 60° the
  chain last turned, so repeated presses trace and close a ring). Sprouts are placed by pure
  geometry — open-space bisectors and ±chain-angle candidates, ties breaking upward — and commit
  the growth arrow's exact plan when a bond tool's arrow is on screen. The element set gained
  Cl/Br/Li/Si commands (`nativeHotkeyElements` in `documentWorkflow.ts`) — the model always
  supported them; only the keyboard surface was single-letter.
- **Hovered bond:** `1`/`2`/`3` order, ring fusion `4`–`8` (four- to eight-membered rings,
  bulging away from the molecule body), `9`/`0` the two chair cyclohexanes, `a` fuse benzene,
  plus new display commands `bond.setHoveredBondDisplay.*` (`w` wedge, `h`/`H`/`W` hashed,
  `d` sets the dative (dashed) style, which on this branch removes the bond's covalent valence
  from both atoms, so implicit hydrogens and the formula change with it (the status line says so),
  and it applies only to single bonds — a double or triple bond refuses the dashed style; `b` sets
  bold.)
- **Menus:** Export `Ctrl+Cmd+E`, zoom `Shift+Cmd+<`/`>`, rulers `Cmd+;`, crosshairs `Alt+Cmd+X`,
  front/back `Cmd+[`/`Cmd+]` (ChemDraw's orientation; the one-step variants are unbound), flip
  `Shift+Cmd+H`/`V`. Chords the apps already share (Cmd+N/O/S, clipboard, Copy As, `Cmd+D` CDXML,
  `Shift+Cmd+K` cleanup, group/ungroup, align/distribute) stay put.
- **Hover wins over tools, exactly as in ChemDraw.** Element, nickname, and numeric keys act on
  the hovered atom or bond; when nothing is hovered, they act on the currently selected atom or
  bond instead (a single selected part), the same way ChemDraw applies hotkeys to a selection. Only
  when nothing is hovered and no atom or bond is selected does the key fall through to its tool
  binding. So `e` over an atom (or with an atom selected) places the Et label while `e` over empty
  canvas with nothing selected arms the arrow tool; `x` splits the same way between the X label and
  the bond tool. Space, `j`, `t` and the other keys with no hover meaning switch tools regardless.

The numeric row is **not scheme-gated**: the tables (`numericAtomDrawingHotkeys` /
`numericBondDrawingHotkeys` in `commands.ts`) are shared, so those hover hotkeys are equally live
under the default ChemDraft scheme — `hoveredNativeTargetShortcutCommand` in `MainWindow.tsx`
consults the same tables ahead of its legacy fallbacks. Carbonyl, historically `k` over an atom
in the ChemDraft scheme, is `2` in both schemes; `k` keeps working under ChemDraft only.

## Nickname labels: the label stays, the chemistry is the group

The nickname hotkeys place the label verbatim: the document stores "OMe", and the canvas draws
"OMe". Since the abbreviation slice (2026-10-10), every label in the template library's
abbreviation table (Me, Et, Ph, OMe, CO2Me, CF3, NO2, N3, MgBr, Boc, Cbz, Fmoc and more) is read as
the group it stands for. Matching is case-sensitive: "OMe" is methoxy, "Ome" is text. See
`packages/template-library/README.md` and `nativeAtomLabelReading`.

- **Valence.** A group's label bonds must fill its free valence, typed or placed by hotkey. "OMe" on
  a ring carbon (an O with three bonds and no + charge) and a lone "OMe" (an open CH3O) are badged;
  the reason names the bonds it takes and the charge that would fix it.
- **Formula, SMILES, molfile, analysis.** A valid group counts and exports as its real atoms. A
  molfile carries each as a superatom (`SUP`) S-group with its label. A flagged group counts nothing
  and exports as a warned placeholder until it is fixed.
- **Drawing tools.** The bond tool may draw the bonds a group is missing, never more. Ring attach
  and bond-order changes still refuse non-element atoms.
- **Placeholders.** R, X and ? (and the rest of `isGenericAtomLabel`) stay warned placeholders,
  never badged. `D` is deuterium. Unrecognized text is badged and counts nothing.
- **Charges** attach to nickname atoms and sit on the group's attachment atom: "OMe" carrying −1 is
  methoxide.

## Deliberately not mapped

`A`→Ac is absent: "Ac" normalizes to the element actinium, and elements win over the abbreviation
table, so acetyl is in the table only as "COMe"/"MeCO". Also absent: the fragment sprouts ChemDraft has no template
for (t-Bu on `k`, alkyne), dialogs (`=`, `/`), and tools ChemDraft lacks (TLC plate, orbitals,
cyclopentadiene).

## Compatibility notes

This branch also changed the document schema and two rendering semantics, which matters when a
document moves between this build and an older one. The per-slice entries in
`docs/shipped/README.md` ("ChemDraw-parity drawing interactions") carry the same notes next to
the features that caused them.

- **`labelLiteral` / `warningSuppressed` atoms fail to open in older builds.** Both are new
  optional keys on the atom schema, which is `.strict()`, so the load fails with a validation
  error naming the unrecognized key. Re-saving from an older build is not possible (it can't
  open the file); strip the keys to downgrade.
- **Charge marks with magnitude >1 degrade silently in older builds.** The mark schema always
  accepted any integer, so the file opens — but the old renderer drew every mark as a plain ±1
  glyph and the old charge reconciliation recognized nothing beyond ±1, so the mark's
  contribution is recomputed away on load: a stored 2+ reads as +.
- **Pre-branch dashed bonds reinterpret as dative on open.** Dashed bonds now occupy no covalent
  valence slot, so labels on atoms with dashed contacts may gain implicit hydrogens the moment
  the document opens, and the stored formula keeps its pre-branch value until the first edit
  re-derives it.

## Tests

- `App.test.ts` — "builds ChemDraw-compatible shortcuts…" (registry resolutions, conflicts empty
  including the detached-palette registry), "resolves ChemDraw hover hotkeys case-sensitively…",
  chemdraft-scheme identity through the transform.
- `keybindingSettings.test.ts` — persistence round-trip, invalid-value fallback, type guards.
- `PreferencesWindow.test.ts` — fourth radio group renders and reflects storage.
- Rust `registered_commands_have_permissions_and_capability_grants` covers the new
  `set_keybinding_scheme` command (build.rs app-manifest + `capabilities/default.json`).
