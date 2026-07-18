# Report 0001: Runtime bring-up (M1–M3) — 2026-07-07

Assignment: [prompts/01-runtime-bringup.md](../prompts/01-runtime-bringup.md).
Executed directly by Claude (Opus 4.8) in worktree
`~/Documents/programming/chemdraw-nmr`, branch `codex/nmr-plugin`, cut from
`main` @ `64cf513e`. Build stamp: `7.7.9.53-opus`.

## Outcome

**Milestones 1–3 complete.** The live bundled-plugin runtime is up and the
`molscribe-ocsr` canary proves the full path in the running desktop and in
tests:

```
manifest → persistent PluginHost → bundled registration →
Analyze menu contribution → command invocation → declarative panel report
rendered by the desktop → bundled-plugin diagnostics
```

Validation (all actually run):
- `pnpm lint` (tsc --noEmit): clean.
- `pnpm test`: **1223 passed, 9 skipped, 81 files** (baseline was 1204/9/78 → +19 tests, +3 files, zero regressions).
- `pnpm --filter @chemdraft/desktop build:web` (Vite bundle): success in ~15s; the new modules and the cross-package `@chemdraft/molscribe-ocsr-plugin` import bundle cleanly. The chunk-size warning is pre-existing.
- Native `pnpm build` (= `tauri build`): **not run.** It packages and signs a native app; signing/notary is gated (`~/Documents/programming/.notary`) and inappropriate to run autonomously. Rust (cargo 1.96.0) is present, so this is a policy choice, not a toolchain gap.

## Assumption discrepancies

Verified against the prompt's "Verified repository state" list. All held except one nuance:

| Assumption | Verdict | Note |
|---|---|---|
| `PluginHost` only instantiated in host tests, never desktop | CONFIRMED | — |
| `MainWindow` builds `CommandRegistry` in a `useMemo` (~6306) | CONFIRMED | Now at ~6326 after edits |
| **Registry recreated on document/selection change** | **CONFIRMED (was PLAUSIBLE)** | The `useMemo` dependency array includes `selectedNativeMoleculePart` and `document.selection.objectIds`-derived values, so it genuinely rebuilds on selection/document change. This is exactly why the plugin host must live in a ref, not this memo. |
| `invokeCommandRef` ref pattern exists (~1714) | CONFIRMED | Plugin commands now route through the runtime before the core `registry.invoke` fallthrough. |
| conformer worker/client request-ID pattern exists | CONFIRMED | Not exercised (no worker work in M1–M3). |
| `molscribe-ocsr` is a package, unreferenced by desktop | CONFIRMED | Package name is `@chemdraft/molscribe-ocsr-plugin`; desktop did not depend on it — added as a dep. |
| Declarative `PluginPanelReport` + `showPanelReport` exist; desktop supplies neither | CONFIRMED | The desktop now supplies `showPanelReport` and the renderer. |
| Analyze menu exists in `appMenu.ts`; native drift test with `nativePredefined` exclusion | CONFIRMED | Added a parallel `pluginContributed` exclusion. |
| `toolsets.ts` keys plugin vs core off `plugin.` prefix | CONFIRMED | Canary command id `plugin.molscribeOcsr.recognizeImage` matches. |
| No bundled-plugin diagnostics view | CONFIRMED | Added one. |
| Selection-policy refactor pending (`PLANS-selection-policy.md`) | CONFIRMED | Selection provider kept a thin adapter over current state. |

New facts learned:
- The vitest `include` glob is `**/*.test.ts` — it does **not** match `.tsx`. Repo DOM tests use `createElement` in `.dom.test.ts` files; the new DOM tests follow that convention.
- `@chemdraft/molscribe-ocsr-plugin` is not in the tsconfig `paths` map but resolves via its package `exports` through the workspace symlink (Bundler resolution), so no `paths` edit was needed.
- `MainWindow.tsx` keeps `documentRef.current` current every render (line ~1784), so ref-backed providers observe live state.

## Files changed

New desktop runtime (`apps/desktop/src/plugins/`, all new):
- `types.ts` — `OpenPluginPanel`, `PluginDiagnostic`.
- `createPluginRuntime.ts` — persistent host + panel controller factory (injectable clock).
- `PluginPanelController.ts` — open-panel state, receives validated reports, records a controlled diagnostic for unknown panels.
- `registerBundledPlugins.ts` — one call registering molscribe with a canary handler (renders a report, proposes no patch).
- `pluginMenuModel.ts` — host menu contributions → app-menu items + the `plugin.runtime.showDiagnostics` opener.
- `PluginReportRenderer.tsx` — renders the four section kinds; SVG via inert `<img>` data URL.
- `PluginDiagnosticsPanel.tsx` — bundled-plugin list (id/name/version/contribution counts) + runtime diagnostics.
- `PluginPanelSurface.tsx` — desktop chrome (title, Close, Run again) around the report + diagnostics.
- `usePluginRuntime.ts` — one persistent runtime via lazy ref; subscribes React to host/panel changes.
- Tests: `pluginRuntime.test.ts` (5), `PluginPanelSurface.dom.test.ts` (5), `MainWindow.plugins.dom.test.ts` (2).

Modified:
- `packages/plugin-host/src/index.ts` (+88) — `RegisteredContribution<T>`, `subscribe`, `listCommand/Menu/Panel/AnalyzerContributions`, and `assertContributionCommands` (registration-time rejection of menu/analyzer/panel entries referencing a non-contributed command).
- `packages/plugin-host/src/index.test.ts` (+5 tests) — duplicate rejection, subscribe, command-ref rejection, enumeration, panel-report routing + undeclared-panel rejection.
- `apps/desktop/src/appMenu.ts` (+68) — `pluginContributed` flag (excluded from `nativeRoutedCommandIds`), `PluginAppMenuItem`, `pluginMenuItems` distribution into sections.
- `apps/desktop/src/appMenu.test.ts` (+2 tests) — distribution + drift-exclusion.
- `apps/desktop/src/MainWindow.tsx` (+57) — `usePluginRuntime` wiring, plugin/diagnostics routing in `invoke`, plugin menu items into the menu model, `<PluginPanelSurface>` render, build stamp.
- `apps/desktop/package.json` — `@chemdraft/molscribe-ocsr-plugin` and `@chemdraft/plugin-api` workspace deps.
- `AGENTS.md`, `PLANS.md` — replaced `main`'s structure-inspector branch docs with the NMR branch versions (the large diff is this doc swap, not code).

## How the key requirements were met

**Host persistence.** `usePluginRuntime` creates the runtime once via a lazy
`useRef` guard (`if (runtimeRef.current === null)`), and bundled plugins are
registered inside that guard so registration is coupled to host creation
(no double-registration under StrictMode). Providers are `() => documentRef.current`
and a selection snapshot builder, read on demand — so the host never rebuilds
on document/selection change. Proven by `PluginPanelSurface.dom.test.ts`
("keeps one host instance across re-renders with changing providers") and the
provider-on-demand runtime test.

**Menu contributions + drift test.** `pluginMenuModel` converts
`host.listMenuContributions()` into `AppMenuCommand`s marked `pluginContributed`;
`buildAppMenuModel` appends them to their section; `nativeRoutedCommandIds`
excludes `pluginContributed` (mirroring `nativePredefined`), so the native-sync
drift test is unchanged and still meaningful. Native Tauri menu integration is
deferred — plugin items are web-menu-only for now (documented risk).

**Panel reports without React in generic packages.** `packages/plugin-api` and
`packages/plugin-host` gained no React import (verified by tsc + inspection).
Plugins push declarative `PluginPanelReport` data; the desktop's
`PluginReportRenderer` is the single renderer; SVG renders through an `<img>`
data URL (script-inert), asserted by the DOM test.

**Molscribe canary.** Registered through the real host path
(`validateTrustedPluginManifest` → `registerPlugin`) with a canary handler that
runs the plugin's pure `runMolScribeOcsrMockRecognition` and pushes a report —
no `proposePatch`, so the document is untouched. `MainWindow.plugins.dom.test.ts`
drives the real menu bar: open Analyze → click "Recognize Structure from Image"
→ panel renders the report → Close works; and the diagnostics opener lists the
bundled plugin.

## Deviations from PLANS.md

- **Diagnostics entry point.** PLANS left the diagnostics trigger open; it is a
  `pluginContributed` "Bundled Plugins…" item in the Analyze menu
  (`plugin.runtime.showDiagnostics`), handled directly in `invoke`. This keeps it
  reachable and testable without a new top-level menu section (which would break
  the "expected sections" test) and without native-menu drift.
- **Panel controller filename.** PLANS suggested `PluginPanelSurface.tsx` +
  `pluginMenuModel.ts`; the controller logic lives in a separate
  `PluginPanelController.ts` (non-React) so it is unit-testable in Node. No
  behavioral difference.
- No `PluginReportRenderer`/`PluginDiagnosticsPanel` split was mandated; added for clarity.

## ADR updates

- **ADR-0009 (Analyze menu via appMenu model)** → validated in practice; recommend promoting from `proposed` to `accepted`. The `pluginContributed` exclusion works and the drift test stays green.

## Unresolved risks / follow-ups

1. **Native Tauri menu** does not show plugin items yet (web menu only). Adopt the dynamic-toolset-menu approach in `lib.rs` in a later slice, or accept web-only for bundled plugins. Documented, not blocking.
2. **Selection snapshot is not yet deep-copied** by the host (verified gap A17) and carries no fingerprint/document-page identity — deliberately deferred to M4.
3. **Worker bundling across workspace packages** is untested (no worker work in M1–M3); retire with a spike early in M7.
4. **Native `tauri build` not exercised** — packaging/signing gated. Web bundle validated instead.

## Next milestone

M4–M5 ([prompts/02-selection-analysis-apis.md](../prompts/02-selection-analysis-apis.md)):
extend the existing selection API (format enum, `sourceFingerprint`,
immutability, document/page identity) and add the generic analysis API + store.
Not started.
