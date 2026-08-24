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
  Per AGENTS.md §6.9, no proprietary shortcut documentation is copied into the repo.
- **Full replacement, not overlay.** The shortcut engine disables *both* commands on a conflicting
  chord, so `applyKeybindingSchemeToCommands` clears every ChemDraft default whose key means
  something else in ChemDraw (`null` entries), and clears `defaultShortcut` too — the engine falls
  back `shortcut ?? defaultShortcut`.
- **Hover hotkeys are case-sensitive under the ChemDraw scheme** (`b` → Br vs `B` → boron,
  `c` → C vs `C` → Cl), matching ChemDraw; the ChemDraft ladder stays case-insensitive.

## What the ChemDraw scheme covers

- **Tools:** Space → select, `x` → bond, `Shift+X` → chain, `j` → benzene, `t` → text,
  `Shift+T` → bracket, `e` → reaction arrow. ChemDraft's single-letter tool keys (V/L/M/C/R/+/−)
  are released.
- **Hovered atom:** element relabels (`h c n o f p s i` plus `w`→N, `q`→O, `l`/`C`→Cl, `b`→Br,
  `B`→B, `L`→Li, `S`→Si), `1` grow bond, `2` carbonyl, `+`/`−` charge. The element set gained
  Cl/Br/Li/Si commands (`nativeHotkeyElements` in `documentWorkflow.ts`) — the model always
  supported them; only the keyboard surface was single-letter.
- **Hovered bond:** `1`/`2`/`3` order, plus new display commands `bond.setHoveredBondDisplay.*`
  (`w` wedge, `h`/`H`/`W` hashed, `d` dashed, `b` bold).
- **Menus:** Export `Ctrl+Cmd+E`, zoom `Shift+Cmd+<`/`>`, rulers `Cmd+;`, crosshairs `Alt+Cmd+X`,
  front/back `Cmd+[`/`Cmd+]` (ChemDraw's orientation; the one-step variants are unbound), flip
  `Shift+Cmd+H`/`V`. Chords the apps already share (Cmd+N/O/S, clipboard, Copy As, `Cmd+D` CDXML,
  `Shift+Cmd+K` cleanup, group/ungroup, align/distribute) stay put.

## Deliberately not mapped

Nickname labels (`m`→Me, `O`→OMe, Boc/Cbz/Fmoc…), ring/fragment sprouts onto atoms (benzene,
cyclohexane, alkyne, t-Bu…), ring fusion onto bonds, wedge-direction sprouts (`4`/`5`), dialogs
(`=`, `/`), and tools ChemDraft lacks (TLC plate, orbitals, cyclopentadiene). Nicknames in ChemDraw
expand to real structure; a text-label imitation would change chemical identity, which cleanup/layout
code is forbidden to do. Revisit when structural abbreviations exist.

## Tests

- `App.test.ts` — "builds ChemDraw-compatible shortcuts…" (registry resolutions, conflicts empty
  including the detached-palette registry), "resolves ChemDraw hover hotkeys case-sensitively…",
  chemdraft-scheme identity through the transform.
- `keybindingSettings.test.ts` — persistence round-trip, invalid-value fallback, type guards.
- `PreferencesWindow.test.ts` — fourth radio group renders and reflects storage.
- Rust `registered_commands_have_permissions_and_capability_grants` covers the new
  `set_keybinding_scheme` command (build.rs app-manifest + `capabilities/default.json`).
