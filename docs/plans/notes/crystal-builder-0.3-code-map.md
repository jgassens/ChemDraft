# Task 0.3 code map (Send to Crystal Builder)

Read-only worker: agentctl run `imac-smoke-0-3`, provider claude-sonnet, base origin/main 8125b66a, 2026-11-20, on the Intel iMac. Status `partial` (the worker listed unresolved items at the end). Unedited worker output below; not yet reviewed.

---

I mapped all three areas by reading and grep only; I changed no files and ran no builds or tests. I also called `ReportFindings` with an empty list by mistake, since you didn't ask for it. It reported nothing and changed nothing.

## 1. Telling user-invoked commands from assistant, MCP or agent calls

**There is no invocation-source flag for commands.** The distinction exists only as separate entry points.

- **User path (menu, toolbar, shortcut).** These all reach `invokePluginCommand(commandId, { selectionWarnings, input })`.
  - Call sites are `apps/desktop/src/MainWindow.tsx:13864` and the fallback at `:13905`.
  - That goes through `usePluginRuntime.ts:552` and `createPluginRuntime.ts:772-777` (`host.invokeCommand(commandId)`).
  - The host method is `invokeCommand` at `packages/plugin-host/src/index.ts:991`, which calls `CommandRegistry.invoke` (`:502`).
  - The handler receives `CommandInvocationContext` (`index.ts:429-435`): `{ input?, pluginId?, permissions?, writeSelection? }`. It has no source field.
  - Menu, toolbar and shortcut calls look identical to the host.
- **The only existing source-like field** is `PluginCommandInput.source`, an enum `"panel" | "overlay"` (`packages/plugin-api/src/index.ts:509-510`).
  - `parseCommandInput` checks it at `index.ts:1065+`.
  - It is set when a panel control or the canvas overlay re-invokes the plugin's own command.
  - It does not identify a menu or an agent.
- **Assistant and tool path.** This is a separate host entry point, not a flag on a command.
  - `invokeAssistantTool` (`index.ts:1120-1139`) and `invokeRequestTool` (`:1144-1174`) build an `ActiveCommandInvocation` with `tool: true` (`:1131`, `:1155`). The interface is at `:2796-2801`.
  - The flag is host-private. It is checked at `:1286` (refuses `applyPatch` on a tool invocation), `:1377` (stop signal) and `:1427` (`requestTool`).
  - Plugin code never sees it.
  - `invokeAssistantTool` calls `requirePermission` for each of `AssistantCapabilityPermissions` (`:1123`).
- **MCP and agent path.** I did not trace it end to end.
  - `apps/desktop/src/plugins/toolSessions/ToolSessionController.ts:37` and `assistant/compatibilityToolCatalog.ts:52` call `binding.invoke(...)`, which feeds the tool path above.
  - I did not open `agentBridge.ts` or `src-tauri/src/assistant_mcp/`. I can't say whether either can invoke a registered plugin command directly (e.g. `plugin.<name>.<action>`) or only tools.
- **Where a source flag would most naturally go.** Add `invocation?: "user" | "assistant" | ...` to the `options` of `host.invokeCommand` (`index.ts:991`) and to `CommandInvocationContext` (`:429`). `createPluginRuntime.invokeCommand` (`:772`) would pass it through and `MainWindow.tsx:13864` would set it. The `tool` and `requestId` fields on `ActiveCommandInvocation` could then become a single enum.

## 2. Selection snapshot (`selection.read`)

The capability is `PluginSelectionAPI.getSelection()` (`plugin-api/src/index.ts:1099-1101`), gated by the `selection.read` permission (`:64`, `:1811`). It returns `PluginSelectionSnapshot { objectIds, molecules[] }`, and each molecule is `PluginSelectedMolecule` (`:1079-1092`). Its fields are:

- `objectId`
- `documentId`
- `pageId`
- `structureFormat`
- `structure`
- `sourceFingerprint`

**There is no SMILES in the normal case, and no per-atom or per-bond fields.** The plugin gets one opaque string.

- The serializer is `buildPluginSelectionSnapshot` (`apps/desktop/src/plugins/selectionSnapshot.ts:196+`), which calls `pluginFacingStructure` (`:24-57`).
- If the molecule has an atom graph, `structureFormat` is `"molfile-v2000"` and `structure` is a V2000 molfile from `moleculeToMolfileV2000(expanded, { fromDocFrame: true, abbreviations: "rgroup", kekuleBondOrders, spellLabel: nativeSingleHeavyElementLabelValence, placeholderAtoms })`. The first line of the doc comment says why: `molecule.structure` is a lossy hand-rolled SMILES.
- The molfile has atom symbols, coordinates (y flipped to molfile y-up), bond orders and charges.
- Aromatic bond orders are resolved to Kekulé (`nativeBondOrderResolution`). Isotope and radical lines are not covered by the cited code, so I can't confirm them.
- Only when there are no atoms, or the writer throws (e.g. over 999 atoms), does it fall back to the stored `molecule.structure` and `molecule.structureFormat` (`:50-56`), with a warning pushed in the throw case.
- The stored SMILES-writer behaviour (`document-workflow-core/src/smiles.ts:496-505`) emits `[*]` for multi-heavy or abbreviation labels, but the snapshot does not use it for graph molecules.

What each case produces in the molfile (`chem-core/src/molfile.ts:372-483`):

- **(a) `CO2H` or `Ph`.** `expandNativeMoleculeLabelGroups` (`document-workflow-core/src/atoms.ts:919`) first expands any valid, correctly bonded group label into real atoms appended after the drawn ones. The snapshot comment says this is the intent (`selectionSnapshot.ts:30-32`).
  - If the group is invalid (wrong valence) or not expandable, the atom is not an element, so it becomes a placeholder `R#` with an `M  RGP` line (`molfile.ts:464-476`) and a pushed warning.
  - A bonded `Ar`, or an `Ac`/`Pr`/`Ts` that doesn't fit its group, goes through `placeholderAtoms` and also becomes `R#` (`atoms.ts:950-970`).
  - I did not run an example to confirm that `Ph` and `CO2H` expand in practice. I'm inferring it from the abbreviation table (`template-library/src/abbreviations.ts:125,215`) and the `atoms.ts:392` comment.
- **(b) An R-group (`R1`–`R99`).** Written as `R#` with the drawn number kept in `M  RGP` (`molfile.ts:421-424`, `:465`). `rGroupNumberFromLabel` is the regex `^R([1-9]\d?)$` (`chem-core/src/rGroups.ts:6-8`).
- **(c) An atom labelled `X`.** `X` is not in `MOLFILE_ATOM_SYMBOLS` (`:263` is elements plus `D`, `T`, `*`), and `spellLabel` returns nothing for it. It therefore becomes `R#` with the next unused R-group number and a warning saying the label is not an element symbol (`:456-476`). It is not written as `*`. I did not run it, so this is from reading the code.
- **`*` in rgroup mode.** A literal `*` label is also forced to `R#` (`:425-431`), not kept as `*`.

## 3. Consent store (`apps/desktop/src-tauri/src/external_tools/consent.rs`)

- **On-disk shape.** A JSON array in `consents.json`, written with `serde_json::to_writer`, plus a trailing newline.
  - Each entry is `Consent { tool: ToolId, pluginId: string, granted: bool, at: RFC3339 }` (`consent.rs:11-17`).
  - The struct is `camelCase` with `deny_unknown_fields`. An older build reading a file with extra fields would fail.
  - The read cap is 1 MiB (`:34-45`).
- **Key.** The pair `(tool, pluginId)`. It is per plugin and per tool, not global.
  - `ToolId` is a closed enum `Claude | Codex` (`catalog.rs:91-94`), so it cannot name an app.
  - `set` replaces the matching row (`retain` then `push`, `:63-72`).
  - `revoke` is `set(..., false)`, so it keeps a `granted:false` row (`:77`).
  - `get` checks `granted` (`:52-58`).
- **Location.** `app_local_data_dir()/external-tools/consents.json` (`mod.rs:424-428`).
  - Writes are atomic: a temp file, `sync_all`, then rename, with mode `0o600` on unix (`consent.rs:88-108`).
  - Windows gets no explicit ACL in this code. `private_dir` is at `mod.rs:387`, and I did not read it.
  - A process-wide `STORE_LOCK` serializes access, and a separate `consent_lock` sits in `ExternalToolsState` (`mod.rs:216`).
  - Plugin ids are validated by `valid_plugin_id` (`mod.rs:363`).
- **Tauri commands.** `external_tool_consent_set`, `_revoke`, `_list` and `_clear_plugin` (`mod.rs:773`, `:807`, `:856`, `:840`; registered at `lib.rs:1706-1708`). TypeScript wraps them in `externalToolsEngine.ts:49-52`.
- **UI listing and revoking.** The plugin manager is the only UI.
  - `PluginManagerDialog.tsx:224` loads `consentList()`.
  - `:443-451` revokes, then re-lists.
  - `ExternalToolConsentRows` (`:1384-1420`) shows only `granted` rows for that plugin, as "AI tool access: Claude Code (Anthropic): allowed", with a Revoke button. The labels are hard-coded to claude/codex.
  - The first grant happens through `ExternalToolsController.ensureConsent` (`ExternalToolsController.ts:119-133`), via a presenter prompt and then `consentSet`.
- **Cleared on uninstall?** Yes.
  - `installPluginPackage.ts:838-845` calls `runtime.externalTools.consentClearPlugin(pluginId)` after the host and catalog drop the plugin.
  - The failure path only warns.
  - Rust `consent_clear_plugin_impl` (`mod.rs:815-838`) deletes all of that plugin's rows and cancels its running processes.
  - I did not check whether disable or update clears consent. Also, `unregisterPlugin` calls `externalTools.cancelAllForPlugin` (`index.ts:977`), which stops runs but is not a clear.

## Surprises for `apps.handoff` and `runCompanion`

1. **No source flag exists.** Any "only on explicit user action" rule for `apps.handoff` has to be enforced by adding one (see §1). The `tool: true` flag on an invocation is host-private and an assistant tool call never goes through `invokeCommand`, so a handoff gate can't just check "not a tool". It should be a positive "user-initiated command" marker.
2. **The consent store is not reusable as is.** `ToolId` is a closed Rust enum, `Consent` has `deny_unknown_fields`, and the UI strings are hard-coded to claude/codex. App handoff needs a new tool or app key and a schema change. That is a downgrade risk for older builds reading the file, and a possible new file would need its own uninstall clearing.
3. **The snapshot is a molfile, not SMILES or a graph.** A Crystal Builder plugin has to parse V2000. Abbreviations, R-groups and `X` all arrive as `R#` plus `M  RGP` (SMILES `[*]` does not apply). Expanded group atoms are appended after the drawn atoms, and coordinates are 2D.
4. **Permissions.** `native.execute` is already the process-spawning gate, and `assistant.run` requires it (`plugin-api/src/index.ts:384-388`). `apps.handoff` and `runCompanion` would need new permission names added in `plugin-api` and enforced in the host. AGENTS.md §4.1 treats anything that spawns a process as needing `native.execute`, and §3.7 requires the gate, tests, `AUTHORING.md` and the API patch-version bump to ship together.
5. **Platform constraints.** AGENTS.md §1 requires both macOS and Windows sides in the same change. I did not read `run.rs` or `terminal.rs`, so I don't know how spawning and path handling already work there.
6. **Not examined.** `agentBridge.ts`, `assistant_mcp` and `run.rs`. Anything about how an agent or MCP call can reach plugin commands, or how templates are rendered and run, is unverified.

{"status":"partial","summary":"Read-only map of the three areas with file:line citations. Q1: no invocation-source flag on commands. User paths all go MainWindow invokePluginCommand to createPluginRuntime.invokeCommand to host.invokeCommand to CommandRegistry.invoke with a context of {input,pluginId,permissions,writeSelection}. Only PluginCommandInput.source (panel|overlay) exists. Assistant and tool calls use separate host entry points (invokeAssistantTool, invokeRequestTool) that set a host-private tool:true on ActiveCommandInvocation. Q2: the snapshot holds a V2000 molfile string (SMILES only as a fallback when there is no atom graph), no per-atom or per-bond fields. Valid group labels are expanded to atoms; invalid or unexpandable labels, R-groups and X become R# plus M RGP with warnings. Q3: consents.json under app_local_data_dir/external-tools, an array of {tool,pluginId,granted,at}, keyed per (tool,plugin), listed and revoked only in PluginManagerDialog, cleared on uninstall via consentClearPlugin. Partial because the MCP and agent bridge path, run.rs and X/Ph/CO2H behaviour were not traced or run.","changed_files":[],"tests":[],"risks":["I did not trace how MCP, agentBridge or assistant_mcp reach plugin commands, so whether an agent can invoke a registered plugin command directly is unverified","Ph, CO2H and X snapshot behaviour is inferred from reading code, not from running an example","Consent store is a closed ToolId enum with deny_unknown_fields, so reuse for app handoff needs a schema change with downgrade risk","Whether disable or update (as opposed to uninstall) clears consent was not checked","Windows file protection for consents.json was not checked beyond the unix 0o600 mode"],"unresolved_items":["Read agentBridge.ts and src-tauri/src/assistant_mcp to see whether agents can call plugin commands","Read external_tools/run.rs and terminal.rs for spawning and platform handling","Confirm Ph, CO2H and X output by reading selectionSnapshot tests or running one example","Confirm private_dir behaviour on Windows"]}
