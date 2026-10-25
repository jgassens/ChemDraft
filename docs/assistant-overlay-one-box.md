# Assistant overlay: diagnosis and API 0.1.12 handoff

The observed installed package is stale. The assistant-c app-data copy at
`~/Library/Application Support/org.chemdraft.desktop.dev.assistant-c/installed-plugins/org.chemdraft.assistant/`
declares `^0.1.10`, records source commit `247ec7297218d4781032a670ac4b48b58ef5dbb2`, and contains
**zero** `setTranscript` references. It can update the status to Done without ever supplying a transcript.

The supplied new package, commit `3e06b5b7d7e85bea922be8ac0f2bc2b9ba89b974`, declares `^0.1.11`
and contains both the worker stub and application calls. Its real-bundle test passes on the
existing host transcript path. Specifically: the worker requests `overlays.setTranscript`;
the bridge allowlist and `resolveCapability("overlays")` accept it; the host validates permission,
ownership, id and limits; the desktop sink updates `canvasOverlayTranscripts` and notifies its
dedicated subscribers; MainWindow passes that same runtime to PluginCanvasOverlay's transcript
subscriber. Neither content nor status changes need a toolset refresh.

The test submits through MainWindow's overlay and replays the owner's real Codex JSONL capture
through native tool IPC. Both the actual overlay and actual detached panel render the user's
message and complete final reply. Switching **only** entry/manifest to the old installed bundle
made both origin cases fail with an empty transcript; restoring the supplied bundle made them
pass. The new bundle already passed before the 0.1.12 host work. This is evidence for upgrading the
installed plugin, not for a missing host capability. No speculative host transcript fix was added.
The installed package and external plugin repository were not modified.

## Plugin changes needed for the owner's single-box decision

Build against SDK 0.1.12 and declare `apiVersion: "^0.1.12"`. Remove the Assistant's panel
contribution and `ui.panel` permission, and replace `panels.showReport` in `runAssistantTurn.ts`:

- Publish setup/readiness/provider actions through `overlays.setContent`. Use only text,
  keyValue, actions, and image sections; omit the panel prompt and transcript from these sections.
  The permanent overlay prompt and `setTranscript` supply those. Control ids must not collide
  with its `message`/`provider` ids. Bound sections to 20 and 64 KiB UTF-8 JSON.
- Keep `setTranscript` on every transcript change, independently of content/status publishing.
  Update the setup notice that currently directs the user to the detached panel.
- Have the menu/open/setup command call `overlays.open({ overlayId, focus: true })`.
  Background content/transcript changes must not call focus:true.
- Clear temporary setup with `setContent({ overlayId, sections: [] })`; keep any desired Stop,
  New conversation, and Setup actions in a bounded actions section. Treat source:"overlay"
  button input exactly as the corresponding panel action input.
- Remove panel-close-dependent cancellation/dismissal behavior. Collapsing the overlay does
  not close the plugin conversation. Ship a newly versioned package so the installed old 0.1.0
  bundle is actually replaced through the normal install/update path.

The host keeps native panels for other plugins. Plugins with panels can opt out of the overlay
shortcut using `showPanelLink: false`; plugins without panels get no shortcut or panel-opening
path. Content uses the existing PluginReportRenderer and the live panel action resolver. `open`
requires an owned running command and never focuses by default. API package versions, worker
stubs/map and compatibility ladder are 0.1.12; the extraction gate already reads the version
dynamically and needs no pinned-regex change.

## Verification boundaries

The old-bundle failure and new-bundle pass are automated VM/DOM evidence, not a claim of native
WebKit or WebView2 verification. The sandbox's linked node_modules prevent `./run-app`'s default
Vite config bundler from writing its temporary config; the standalone Vite build with
`--configLoader runner` succeeds. No packaged app was launched and no running build label was seen.
Windows native verification is also pending: repeat focus, resizing, setup actions, transcript
updates, and the absence of panel windows using the updated plugin and this host build.

The stock Vitest config loads RDKit identifiers from this worktree but its bare/testing imports
from the linked assistant-c checkout. Ten existing structure-naming tests fail because these are
different loader singletons. A temporary config in the task tmp directory adds exact RDKit
bare/testing/adapter/constants aliases to this worktree; the naming suite then passes. No chemistry
implementation, naming test, dependency installation, or repo-wide config was changed for this.

Validation on this macOS host:

- The exact requested command using the stock config: **1,699 passed, 10 failed, 2 skipped**;
  all ten failures are the RDKit singleton split described above.
- Requested plugin API/host, desktop plugins, MainWindow and App suites with the temporary exact
  RDKit aliases and `--maxWorkers 2`: **92 files passed; 1,709 tests passed, 2 skipped**.
  An earlier run overlapped native compilation and had two transient tab/quit timing failures;
  the bounded-worker run passed all of them without changing those tests.
- `pnpm lint`, `pnpm build:sdk`, Vite production web build with `--configLoader runner`,
  `git diff --check`, Rust fmt, and macOS clippy `--all-targets -- -D warnings`: passed.
- Full Vitest gauntlet with the same RDKit aliases: **8,729 passed, 11 failed, 14 skipped**.
  Failures were outside this slice: seven ring-style CLI checks (including sandbox-denied tsx
  IPC sockets and a charged-carbon setup failure), and four PowerShell release checks timing out.
- Rust tests: **513 passed, 23 failed, 8 ignored**. All failures attempted loopback socket binds
  denied by the sandbox (`Operation not permitted`); no native implementation files were changed.

The temporary config and test logs live in the task's `tmp` directory, outside tracked source.
No commit was made. Recommended next task: migrate and version the Assistant plugin for 0.1.12,
replace the installed old bundle, and run the standing manual checklist in packaged builds on
both macOS and Windows. The active multi-PR Assistant plan remains in flight.
