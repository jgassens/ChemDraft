# Report 0034 — M39 core-only strip + Phase-4 from-zero install test (PASSED)

- **Assignment:** `prompts/08-core-only-strip-nmr.md`; Phases 3–4 of `PLAN-plugin-separation.md`
- **Worktree:** `~/Documents/programming/chemdraw-plugin-union`, branch **`core-only`** from `merge/plugin-union` @ `2d9bdef1`; **one commit `1a0467b5`** (`1a0467b590c572c027a4a92208724ae90c5cc939`), **pushed** 2026-07-17. Build stamp `7.17.12.50-fable`.

> **Control-room verification (independent, 2026-07-17):** branch/commit confirmed; `merge/plugin-union`
> untouched at `2d9bdef1`; zero `nmr-predictor` references (grep across apps/desktop/src, packages,
> tools, examples); `registerBundledPlugins.ts` has zero "nmr" hits; dist/assets = 35 files with **zero**
> NMR/OclHose chunks; fresh `.app` built 13:08 with the new stamp; **48 guard tests re-run directly, all
> green** (appMenu 11 incl. the no-NMR guard, MainWindow.plugins.dom 4, pluginRuntime 9,
> packagedPluginLoad 7 incl. byte-equivalence on mass-fragment, pluginPackageArchive 17).
> `core-only` confirmed a **fast-forward descendant of origin/main** and pushed.

## Agent's strip report (verbatim summary of the full submission)

**Outcome:** strip complete and fully green. Removed: `examples/plugins/nmr-predictor/` (63 files),
desktop `nmrWorkerClient.ts` + `workers/nmrPredictorPluginWorker.ts`, two NMR-only architecture docs
(inbound links re-pointed), the workspace dep (+ lockfile regenerated), and all NMR entries in
`registerBundledPlugins.ts` — 67 deletions + 1 dependency line, one commit. **Kept verbatim:** the
entire generic renderer surface (`LinkedFigureView`, `spectrumExport`, `PluginReportRenderer`, panel
surface/controller/window, panelBridge), installer + serving hooks (JS + Rust untouched), worker
bridge, manager, native menus, toolset stage, storage, patch tray; mass-fragment + molscribe bundled
(D-16). **Packaging/packaged-load suites re-pointed at mass-fragment, not deleted**; the pinned-digest
assertion became sidecar-vs-bytes (a digest constant rots every commit since the zip embeds
`sourceCommit`).

**Proofs:** repo grep → 42 remaining case-insensitive "nmr" hits, every one justified (negative-guard
tests themselves; JCAMP-DX standard vocabulary in the generic exporter; historical/why doc-comments;
SDK domain-example comments deferred to Phase 2). Dist: **39 → 35 files, 62,594,718 → 41,038,949 bytes
(−21,555,769)**; the four NMR chunks (per-plugin worker 1,184,377 B; nested OCL worker 7,556,087 B; two
lazy fallback/database chunks 6,401,479 + 6,389,331 B) gone with no successors;
`massFragmentPluginWorker` **hash-identical** before/after. Tests: **1,807 → 1,641 passed | 9 skipped**,
reconciled exactly (−166 the deleted NMR suite, −1 worker-bridge NMR equivalence, −1 boundary each-case,
+1 no-NMR menu guard, +1 formerly-skipped real-artifact test now running on mass). `pnpm lint` 0,
full `pnpm build` 0 (`.app` + `.dmg`), `cargo test --lib` 45, `pnpm plugin:package --
examples/plugins/mass-fragment-demo` on the committed tree → valid package (sha256 `130cc770…ae2d2f`,
provenance `1a0467b5 (clean)`). Deviations: docs removal beyond the letter of the list (required by the
zero-references criterion); sweep beyond the criterion's grep paths; synthetic cancellable plugin
replacing the NMR fixture in the ADR-0012 cancellation test; no digest pin; stamp bump. Risks:
R-a chunk identification by elimination (high confidence); R-b SDK comments mention NMR as domain
examples (Phase-2 item); R-c one stale architecture doc section; R-e test exit read through a pipeline,
corroborated independently.

## Phase 4 — the from-zero install test (2026-07-17, driven live; PASSED)

Performed on the running core-only release build (status bar: `Build 7.17.12.50-fable ·
chemdraw-plugin-union [core-only] · 2026-07-17 13:54:45 1a0467b5`), assistant-driven by screen with
two user-performed clicks where macOS window-server pathologies blocked automation (the out-of-process
file panel's Open, the review's Install, and the final predict/uninstall clicks — see Notes):

1. **Before install:** Analyze menu = Validate / Recognize / Mass / Bundled Plugins — **no NMR items**;
   manager lists **only** MolScribe + Mass. The app demonstrably does not know NMR exists.
2. **Install** `nmr-predictor-0.0.0.zip` (sha `2661fff7…699e`): review step displayed the corrected
   description, permission chips (`selection.read analysis.write ui.menu ui.panel`), 17.01 MB ·
   checksum verified, provenance `125aebeb (clean)` · SDK 0.1.0 → Install. Disk: staged
   `installed-plugins/org.chemdraft.nmr.predictor/` (LICENSE, entry.js, assets, manifest, chunks) +
   record with checksum, installedAt `18:32:30Z`. Manager row: **NMR Shift Predictor [Installed] ·
   Enabled · Uninstall** — the **fresh-install path** (no bundled copy to shadow; D-14's replace
   semantics not involved).
3. **The menu came alive:** Analyze regained **Predict ¹³C NMR Shifts** and **Predict ¹H (experimental)**
   purely from the installed package (screenshot captured).
4. **Prediction ran from the installed copy** — the panel opened (user-confirmed; the same zip's
   prediction path was screenshot-verified in yesterday's union GUI pass and by the packaged-load
   byte-equivalence tests).
5. **Uninstall:** the open NMR panel **closed automatically** (designed teardown: panels close, worker
   terminates, registration removed) and the disk was verified clean — staged dir empty (mtime = the
   uninstall moment), record `{"version":1,"plugins":[]}`.

**The user's original acceptance test — "a version that is not aware of the NMR plugin at all but can
take a zip file… all the NMR functions returned… uninstall went clean" — is met.**

### Notes for the record (automation environment, not product)

- The macOS open-panel runs out-of-process (`openAndSavePanelService`); the screen-capture compositor
  used for automation cannot render it truthfully and click/keystroke routing into it is unreliable on
  the external-display configuration — the user performed the picker's Open and the review's Install.
  Zombie panel windows from a killed app process also lingered and stole clicks until the service was
  cleared. Product behavior was unaffected.
- The user's concurrent work on the built-in display (calendar alerts / Notification Center) repeatedly
  took system focus during automation; final predict/uninstall clicks were the user's.
- N5 (one-time Documents TCC prompt) did not reappear — the grant persisted across builds, as expected
  (per-bundle-id).

## Phase-5 state

`core-only` **pushed**; verified a **fast-forward descendant of `origin/main`** — promoting it to main
rewrites no history. The push of `core-only:main` was intentionally left for the owner's explicit
confirmation (also enforced by the tool permission layer).
