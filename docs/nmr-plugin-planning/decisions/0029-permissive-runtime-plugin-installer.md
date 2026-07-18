# ADR-0029: Permissive runtime plugin installer — per-plugin Web Worker, built package, auto-granted permissions

- **Status:** accepted (2026-07-15). **§6 amended 2026-07-16:** its web mechanism was disproven by report 0030 (M35), and **web install is now dropped outright** (D-13 resolved — the browser build is a dev preview, not a product). Delivered across **M34–M36** (M34 ✅ `6c4208df`, M35 ✅ `0fd3ecee`, M36 in progress). **M37 dropped.**
- **Source:** user-directed — "get this to the point where the plugin is a zip I can download, and the app can install and uninstall plugins from a simple interface"; and the scoping steer: "this is a niche package … the equilibrium needs to lean more toward permissive than secure"
- **Revises:** ADR-0028 §3 (source-distribution zip) and its "this is not a runtime installer" consequence — both are reversed for the installer path. ADR-0028's SDK-boundary (§1–§2, §4–§5) still stands.
- **Builds on:** ADR-0004 (declarative panel reports — the enabler), ADR-0027 (core-owned plugin manager), M32 (the manager UI with the deferred "Add plugin from package…" stub).

## Context

M32 shipped an "Add or Remove Plugins" manager that enables/disables plugins **compiled into the
build**, with an honestly-disabled "Add plugin from package…" button. ADR-0028 then made a plugin
*separable* as a **source-distribution** zip and explicitly deferred a runtime loader as "a large,
security-heavy lift … a separate, larger decision if ever wanted." The user now wants that loader:
a plugin you can **download as a zip** and **install/uninstall at runtime** from the manager.

The decisive input is audience. ChemDraft is a niche package with few users; the realistic installer
is **a developer running a plugin they wrote themselves**, not an attacker distributing a weaponized
zip to strangers. The user's explicit instruction is to **lean permissive, not secure**. That retires
the heavy machinery ADR-0028 was worried about — per-call consent gating, signature/trust
infrastructure, load-time permission adjudication — none of which is worth its friction for this
audience.

Two runtime-execution mechanisms were live:

- **In-process dynamic `import()`** — simplest to build, but an ES module can never be cleanly
  unloaded (any timers/listeners it registered persist), so "uninstall" would really mean "resident
  until you restart"; and a plugin bug (infinite loop, thrown error) freezes or corrupts the host it
  runs in.
- **Per-plugin Web Worker** — the plugin runs in its own thread with no DOM, no `window`, no direct
  host reference. `worker.terminate()` is a total teardown, and a runaway plugin freezes only its own
  thread.

The Worker is **not** chosen here as a security sandbox (the policy is permissive). It is chosen for
three engineering properties that serve the plugin *author*: a real uninstall, crash isolation of the
author's own iterating code, and one mechanism that works in both the Tauri webview and the browser
build. And it is nearly free: the entire capability contract is already asynchronous and
structured-cloneable — every method on `PluginPanelAPI` / `PluginStorage` / `PluginSelectionAPI` /
`PluginAnalysisAPI` returns a `Promise` and every payload is plain data (a direct consequence of
ADR-0004's declarative-panel decision). Nothing in the contract is synchronous or hands back a live
object reference, so it survives a `postMessage` boundary without a redesign.

## Decision

1. **Runtime loading is a per-plugin Web Worker**, chosen for clean `terminate()`-based uninstall,
   crash isolation of the author's own code, and a single load path that works in both the Tauri
   webview and the browser build — explicitly **not** primarily a security boundary.
2. **The plugin↔host contract crosses the worker as a versioned async message protocol.**
   `@chemdraft/plugin-api` gains a worker-side runtime: inside the worker, capability calls
   (`selection.getSelection`, `storage.*`, `analysis.*`, `panels.showReport`, active-document access,
   `proposePatch`) become request/response messages that the main thread services against the
   **existing real host capabilities**. Reverse signals travel worker-ward (`onPanelClosed`, the
   abort used by ADR-0012 cancellation). This is viable precisely because no API is synchronous or
   returns a live object.
3. **Permissive capability policy.** A plugin receives exactly the capabilities its manifest declares,
   **auto-granted at install with no consent prompts**. The install UI *shows* declared permissions
   for transparency only; there is no per-call gate and no deny-by-default.
4. **No signing.** A SHA-256 checksum is retained solely for corruption/integrity detection, not as a
   trust or authenticity gate. Author authenticity (signatures + a trust store) is revisited only if
   untrusted third-party distribution at scale ever emerges — the worker boundary is already in place
   to hang it on.
5. **The installable artifact is a built package** (this reverses ADR-0028 §3 for the installer
   path): a zip of `manifest.json`, the plugin's **built** worker module, `LICENSE`, and the
   `.sha256` sidecar. It is both the file a user downloads and the file the app installs — one
   artifact for both, per the user's choice. ADR-0028's source-distribution extractor remains
   available as a developer/build-time artifact for hosts that compose plugins at build time.
6. **Both surfaces.** The desktop persists installs to a Tauri app-data plugins directory and reloads
   them at startup; the browser build installs from an in-memory / IndexedDB blob (no local
   filesystem). Enable/disable of bundled plugins (M32) is unchanged and coexists with installed
   plugins in the same manager.

   > **AMENDED 2026-07-16 — report 0030 (M35) disproves the web half of this clause by measurement.**
   > A **blob URL cannot host a multi-file package**: it has no sibling files, so the NMR plugin's
   > nested worker and 7.5 MB database never resolve. The failure is late and deep — the `ready`
   > handshake *succeeds* and only the prediction fails — so a startup-only check would have missed it.
   > Inlining a 7.5 MB DB into one script is not an acceptable escape. Loading a packaged plugin
   > requires a real, co-located, **same-origin** URL (cross-origin fails too: worker scripts are
   > same-origin-only and permissive CORS does not help).
   >
   > The **desktop** half stands — staging *location* is unconstrained — but with an added requirement
   > this clause did not know: the staged directory must be served **by the app's own origin**. Tauri's
   > `asset://` and any newly-registered scheme are ruled out as separate origins; one URI-scheme
   > handler must serve both the document and the package.
   >
   > **The web half of this clause is therefore withdrawn — D-13, resolved 2026-07-16: web install is
   > dropped, and M37 with it.** The deciding fact turned out not to be the mechanism but the *surface*:
   > the repo README calls `pnpm dev:web` "only a secondary browser preview while working on the React
   > surface" — a dev convenience with no deploy and no CI, not a shipped product. The only candidate
   > mechanism left (a Service Worker serving a virtual same-origin path from IndexedDB/Cache Storage) is
   > untested, may not intercept *nested*-worker script loads, and needs a secure context — real cost to
   > install plugins into a preview tool nobody ships. **ChemDraft installs plugins on the desktop only.**
   > Revisit only if a browser-hosted ChemDraft ever becomes a real product.

## Delivery (staged; canonical status in STATUS.md)

- **M34** — the isolation boundary: run a *bundled* plugin in a per-plugin worker over the protocol,
  capabilities auto-granted per manifest. De-risks the whole program before anything is built on it.
- **M35** — the built package + `plugin:package` pipeline; the worker loads the built artifact.
- **M36** — install/uninstall UX (desktop): wire the deferred button, checksum-verify, show declared
  permissions (no gate), stage → load → register; uninstall = terminate + remove + forget; persist.
- ~~**M37** — the web install surface (upload-into-memory / IndexedDB).~~ **Dropped (D-13, 2026-07-16):
  the browser build is a dev preview, not a product. M36 is the last slice of this program.**

## Consequences

- **Uninstall becomes real** — `terminate()` + remove the staged directory + unregister from the host
  + forget the install record — instead of "resident until restart." M36 depends on M34 delivering
  exactly this teardown.
- A plugin author ships **one zip**; the recipient installs it with a single file-picker action and no
  security ceremony.
- The app runs **third-party JS with broad, auto-granted capabilities**. This is the accepted trade
  for this audience; the manager surfaces an "install plugins you trust" notice, and the worker still
  contains crashes and blocks DOM/`window` access as a side benefit rather than a relied-upon wall.
- The protocol must **version-check** at load (plugin `apiVersion` vs host protocol version); a
  mismatch fails the install with a clear message rather than a silent partial load.
- **Nested workers must work**: the NMR plugin spawns its own OpenChemLib worker, so a plugin worker
  must be able to spawn a worker inside the Tauri webview. M34 verifies this **early** because a
  failure here would reshape M35–M37; it is the single largest unknown.
- **D-11 (unfinalized plugin license) still gates *public* redistribution** of the built zip, and a
  one-click downloadable installable makes redistribution more tempting — but the engineering does not
  depend on it. The choice remains the project owner's.
- **Supersession trigger:** if the audience ever broadens to untrusted third-party plugins at scale,
  revisit the permissive policy — add install-time consent gating and signature verification. The
  worker boundary and the declared-permission manifest are deliberately the seams that change would
  attach to, so that later shift is additive, not a rewrite.
