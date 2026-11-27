# Keyboard shortcuts: one built-in set — shipped

**Status: complete.** ChemDraft has **one** built-in keyboard-shortcut set (owner decision,
2026-11-26). It is the set below, chosen so users coming from other desktop drawing programs keep
their muscle memory. Users change any key in Preferences ▸ Keyboard; those custom keys are the only
per-user shortcut state. Persisted in the native `preferences.json` and mirrored in `localStorage`
(`chemdraft.keybindings.v1`), applied live to every window, the same on macOS and Windows.

Earlier builds had a second preset (the "ChemDraft" bindings, the default before 1.2.3) and a
chooser in Preferences and the first-run tour. Both are gone. The set's storage id stays
the legacy string in `KEYBINDING_SCHEME` (`keybindingSettings.ts`), because the native file, the native menu's `set_keybinding_scheme` and the tour's
dialog protocol carry it; it is never shown.

## Moving existing installs (once)

`shortcutDefaultMigration.ts` runs before the document window mounts. An install whose stored
preset is the retired `chemdraft` one — or that predates 1.2.3 and never named a preset, when that
one was the unnamed default — moves to the set:

- its own custom keys for the retired preset (`overrides.chemdraft`) are carried into the set when
  no other command in the set already uses the key, by the same rule Preferences ▸ Keyboard applies
  to an assignment (`mergeLegacyShortcutOverrides` in `customKeyboardShortcuts.ts`); conflicting
  and reserved keys (F5, Cmd/Ctrl+R) are dropped, and a key the user already set for the same
  command in the set wins;
- the status line says once, in the same words on every platform: "Keyboard shortcuts now use one
  standard set. You can change any key in Preferences ▸ Keyboard." (`SHORTCUT_SET_NOTICE`). A fresh
  install, and an install already on the set, see no message;
- the set's id in the native file is the done marker. The retired preset's stored keys stay in the
  file, unread.

Unreadable or malformed stored settings never stop the app: it runs on the set, and a launch that
can read the native file finishes the move.

## Where it lives

| Piece | File |
| --- | --- |
| Setting (type, persistence, guards) | `apps/desktop/src/keybindingSettings.ts` |
| The set itself (registry overrides + hover hotkey maps) | `apps/desktop/src/keybindingScheme.ts` |
| One-time move from the retired preset | `apps/desktop/src/shortcutDefaultMigration.ts`, `customKeyboardShortcuts.ts` (`mergeLegacyShortcutOverrides`) |
| Registry application (main window) | `MainWindow.tsx` — `toolCommandSpecs` / `shellCommandSpecs` / `shortcutCommands` memos |
| Registry application (detached palettes) | `PaletteWindow.tsx` — `allCommands` memo + its own settings listener |
| Hover ladder | `MainWindow.tsx` — `hoveredNativeTargetShortcutCommand(target, key, tables)` |
| Cross-window live sync | `window-manager/index.ts` — `KEYBINDING_SETTINGS_EVENT`, `broadcastKeybindingSettings`, `listenForKeybindingSettings` |
| Native macOS menu accelerators | `src-tauri/src/lib.rs` — `KeybindingSchemeState`, `set_keybinding_scheme` (rebuilds the menu); JS pushes the set and the user's custom keys via `pushKeybindingSchemeToNativeMenu` on startup and change |
| Web menu-bar labels | `appMenu.ts` — `AppMenuContext.keybindingOverrides` |
| Preferences UI | `KeyboardPreferences.tsx` — per-command customizing (no preset chooser) |

## Design rules the set follows

- **Behavioral parity, not transcription.** The mapping pairs ChemDraft commands with the keys
  users of classic desktop drawing programs expect (derived from observed behavior). Classic actions
  with no ChemDraft equivalent are deliberately absent — their keys do *nothing*, never something
  surprising.
  Per AGENTS.md §12 UI, no proprietary shortcut documentation is copied into the repo.
- **Full replacement, not overlay.** The shortcut engine disables *both* commands on a conflicting
  chord, so `applyKeybindingSchemeToCommands` clears every command-registry key whose key means
  something else in the set (`null` entries), and clears `defaultShortcut` too — the engine falls
  back `shortcut ?? defaultShortcut`.
- **Hover hotkeys are case-sensitive** (`b` → Br vs `B` → boron, `c` → C vs `C` → Cl).

## What the set covers

- **Tools:** Space → select, `x` → bond, `Shift+X` → chain, `j` → benzene, `t` → text,
  `Shift+T` → bracket, `e` → reaction arrow. The command registry's own single-letter tool keys
  (V/L/M/C/R/E/+/−) are replaced. Eraser, lasso, cyclopentane, the charge tools and the one-step
  front/back commands have no default key; they stay in the menus, the toolbar and Customize, and
  Preferences ▸ Keyboard lists them so the user can give them one.
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
  front/back `Cmd+[`/`Cmd+]` (the classic orientation; the one-step variants are unbound), flip
  `Shift+Cmd+H`/`V`. Chords the apps already share (Cmd+N/O/S, clipboard, Copy As, `Cmd+D` CDXML,
  `Shift+Cmd+K` cleanup, group/ungroup, align/distribute) stay put.
- **Hover wins over tools, as in classic desktop programs.** Element, nickname, and numeric keys act on
  the hovered atom or bond; when nothing is hovered, they act on the currently selected atom or
  bond instead (a single selected part), the way classic programs apply hotkeys to a selection. Only
  when nothing is hovered and no atom or bond is selected does the key fall through to its tool
  binding. So `e` over an atom (or with an atom selected) places the Et label while `e` over empty
  canvas with nothing selected arms the arrow tool; `x` splits the same way between the X label and
  the bond tool. Space, `j`, `t` and the other keys with no hover meaning switch tools regardless.

The numeric row comes from the shared tables (`numericAtomDrawingHotkeys` /
`numericBondDrawingHotkeys` in `commands.ts`). Carbonyl is `2`; the retired preset's `k` is gone,
as is its hover-label continuation (typing O, M, e over an atom to build OMe): the set places
whole labels with single keys (`O` → OMe), and the Atom Label tool or the Text tool edits any label.

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
table, so acetyl is in the table only as "COMe"/"MeCO". Also absent: dialogs (`=`, `/`) and tools
ChemDraft lacks (TLC plate, orbitals).

## Known limitations

- If an older build left custom keys only in the webview cache while `preferences.json` already names
  the standard set, and saving to `preferences.json` then fails, those cache-only keys can be lost on
  the next window read.

## Compatibility notes

This branch also changed the document schema and two rendering semantics, which matters when a
document moves between this build and an older one. The per-slice entries in
`docs/shipped/README.md` ("Classic-parity drawing interactions") carry the same notes next to
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

- `keybindingScheme.test.ts` — the set's command and hover keys on macOS and Windows (platform passed
  in), unbound commands, custom keys overriding the set, F5/Ctrl+R never bound.
- `App.test.ts` — "builds the built-in shortcut set's keys" (registry resolutions, conflicts empty
  including the detached-palette registry), "resolves the built-in hover hotkeys case-sensitively".
- `keybindingSettings.test.ts` — persistence round-trip; the retired id, unknown values and corrupt
  storage all resolve to the set; type guards.
- `shortcutDefaultMigration.test.ts` — the one-time move: kept and dropped custom keys, platform
  conflicts, the message shown once, unreadable and malformed settings.
- `shortcutSetNotice.dom.test.ts` — the document window shows the message in its status line once
  after a move, never after a later launch or on a fresh install.
- `PreferencesWindow.test.ts`, `tour/*.dom.test.tsx` — no preset chooser renders anywhere, even
  with the retired preset stored.
- Rust `registered_commands_have_permissions_and_capability_grants` covers the new
  `set_keybinding_scheme` command (build.rs app-manifest + `capabilities/default.json`).
