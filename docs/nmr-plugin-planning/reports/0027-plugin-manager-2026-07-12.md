# Report 0027 — M32: Plugins menubar and live Add or Remove Plugins manager

**Date:** 2026-07-12
**Worktree:** `~/Documents/programming/chemdraw-nmr` @ `codex/nmr-plugin`, commit `ed29ce25` (pushed)
**Build stamp:** `7.12.20.15-codex`
**Decision:** ADR-0027

## Milestone completed

**M32 is implemented and verified locally.** ChemDraft now has a top-level **Plugins** menu in both
the web and native menu models. **Add or Remove Plugins…** opens a core-owned modal that lists every
compiled bundled plugin, enables/disables it live, persists disabled IDs across restarts, and keeps a
disabled plugin visible so it can be restored. Package installation is present only as an explicitly
disabled, deferred affordance.

## Files changed

- `apps/desktop/src/appMenu.ts`, `appMenu.test.ts`: core Plugins section, `plugins.manage`, and
  native-parity/contribution placement coverage.
- `apps/desktop/src-tauri/src/lib.rs`: routed command ID, native Plugins submenu between Analyze and
  Window, and Rust routing coverage.
- `apps/desktop/src/plugins/pluginPreferences.ts` + test: best-effort
  `chemdraft.plugins.disabled` persistence.
- `apps/desktop/src/plugins/registerBundledPlugins.ts`, `usePluginRuntime.ts`,
  `pluginRuntime.test.ts`: runtime-scoped descriptor catalog, startup filtering, idempotent live
  reconciliation, menu/command removal and restoration, and close-before-unregister lifecycle.
- `apps/desktop/src/plugins/PluginManagerDialog.tsx` + DOM test, `apps/desktop/src/App.css`: modal,
  generic rows, live toggles, deferred package control, Escape/backdrop/Close behavior, and styling.
- `apps/desktop/src/MainWindow.tsx`, `apps/desktop/src/plugins/MainWindow.plugins.dom.test.ts`: core
  command registration, dialog wiring, and end-to-end web-menu opening test.
- `AGENTS.md`: synchronized build stamp.

## Architecture decisions

- The descriptor catalog is a factory per desktop runtime because the NMR registration owns mutable
  cancellation state. It is not a shared module singleton.
- The manager renders descriptor manifests, not only `host.listPlugins()`: disabled means
  unregistered, so a host-only list would make the row disappear and impossible to re-enable.
- `applyEnabledPlugins` guards both registration and unregistration, making repeated reconciliation
  a no-op instead of triggering duplicate/unknown-plugin errors.
- A plugin-owned panel closes before unregistration so the existing cancellation hook remains live.
- Existing `PluginHost.subscribe` + `usePluginRuntime` version updates are the single notification
  path. No parallel host signal or NMR-specific manager logic was added.

## Assumption discrepancies

1. The assignment suggested that `PluginDiagnosticsPanel` / `PluginPanelSurface` had an existing
   listing/toggle affordance. The current source had a registered-plugin listing only; there was no
   toggle. A dedicated modal was therefore the smallest coherent UI.
2. The assignment allowed for adding a change-notification signal if one was missing. It was not
   missing: `PluginHost.subscribe` already fires on register/unregister, and `usePluginRuntime`
   already re-derives plugin menus from it. The generic host package required no change.

No `PLANS.md` boundary changed.

## Dependencies

No dependencies were added, removed, or version-changed. No lockfile changed.

## Verification actually run

- Baseline targeted suite before edits: **17/17 passed**.
- Focused M32 suite after edits: **28/28 passed**.
- `pnpm lint`: passed.
- `pnpm test`: **1,491 passed, 9 skipped** (111 test files passed, 3 skipped).
- `pnpm --filter @chemdraft/desktop exec vite build`: passed (2,733 modules transformed).
- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml`: **40/40 passed**.
- `git diff --check`: passed before commit.
- Bundle boundary: NMR worker remains **7,555,923 bytes**, exactly the prior recorded size;
  OpenChemLib appears only in the NMR/conformer worker chunks and not the desktop main chunk.
- Build labeling: the production bundle embeds `chemdraw-nmr [codex/nmr-plugin]` in the title/build
  stamp. A packaged-app visual launch was not performed in this assignment.

## Commands that failed

- The first `git add` attempt was blocked by the worktree Git-metadata sandbox; the approved retry
  succeeded.
- The first `git push origin codex/nmr-plugin` attempt was rejected by the external-action approval
  reviewer because it required explicit user authorization. No workaround was attempted. After the
  user explicitly authorized the push, the retry succeeded and `origin/codex/nmr-plugin` was verified
  at `ed29ce255d08ec17a6f84a9c918ed4b3bd8e16fb`.
- No lint, test, Vite-build, Rust-test, or bundle-boundary check failed in the final state.

## NMR status (unchanged)

- Active predictor: `chemdraft.ocl-hose`, version `nmrshiftdb2.nmredata.sd`.
- Data version/provenance: `NMRShiftDB2 (full NMReDATA export)`, checksum
  `831a31e78b004a308c7c40989e27d30698a34c506e722a91c78b6ed448fc4720`, NMRShiftDB2 Database
  License (ODbL-derived).
- Values are aggregated experimental reference statistics, not synthetic fixtures (fixture backend
  remains available for architecture tests).
- Supported nuclei remain ¹³C and experimental ¹H. Solvent conditioning, conformer averaging,
  stable source atom identity, and fully measured coupling are not supported.
- `nmr-predictor` was not re-evaluated in M32; its prior ADR-0013 rejection remains in force.
- No duplicate-OpenChemLib or bundling change was introduced; the worker chunk is unchanged.

## Unresolved risks

- Runtime installation from a package does not exist; the disabled affordance is intentionally
  honest about that boundary.
- `localStorage` preferences are profile-local and best-effort. If storage is blocked, live toggles
  still work for the current session but cannot survive restart.
- Native menu construction is covered by Rust routing tests and the TypeScript drift test, but the
  packaged macOS menu was not visually smoke-tested in this run.
- Runtime package installation and the later core-only extraction/merge remain future work; the M32
  implementation itself is committed and pushed.

## Next milestone

Extract the NMR plugin as a standalone zip, and prepare a minimal merge of **only** the ChemDraft-core
changes needed to host it (menu/host/runtime/renderer surface) back to ChemDraft `main`. This is a
future packaging/merge milestone; it was not started in M32.
