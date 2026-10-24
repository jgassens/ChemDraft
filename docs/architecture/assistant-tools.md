# Assistant tools and loopback MCP

The Assistant plugin is a harness for a user-installed Claude Code or Codex CLI. ChemDraft owns
the document-tool registry, write policy, external-process boundary, and local MCP transport; the
plugin owns provider choice, prompt, and transcript. It is not a general shell or filesystem interface.

## Document tools

All inputs are schema validated. SMILES are at most 5,000 characters and 500 heavy atoms; text is
at most 2,000 characters; structure inserts contain at most 24 items; a document patch contains
1–256 flat operations. Document summaries are capped at 256 KiB, and rendered PNGs at 4 MiB.

| Tool | Input | Result | May write |
| --- | --- | --- | --- |
| `get_document` | `includeSmiles?`, `maxObjects?` (1–500) | Document/page/object summary, selection, counts and truncation state | No |
| `get_selection` | none | Summary of the selection captured at Send, or empty | No |
| `get_structure` | molecule `objectId`, `smiles` or `molfile` format | Serialized structure and warnings | No |
| `render` | document, selection, or up to 50 object IDs; page, size (256–2048 px), background | PNG image plus dimensions | No |
| `name_to_structure` | name | Parsed SMILES and engine, or an unavailable/declined result | No |
| `validate_smiles` | SMILES | Validity, canonical SMILES, formula, heavy-atom count and warnings | No |
| `structure_to_name` | molecule `objectId` | Naming-engine result; reports an absent Orthonym engine without opening installation UI | No |
| `insert_structures` | 1–24 molecule SMILES, group labels and/or text items; row/grid/auto | Inserted object IDs, summary, warnings | Yes |
| `insert_reaction` | 1–6 reactants, 1–6 products, optional reagents/conditions, arrow kind | Inserted object IDs, summary, warnings | Yes |
| `insert_text` | text, optional relation and style | Inserted object IDs, summary, warnings | Yes |
| `edit_structure` | molecule `objectId`, SMILES, optional keep-position | Replacement object IDs, summary, warnings | Yes |
| `delete_objects` | 1–100 object IDs | Removed object IDs, summary, warnings | Yes |
| `style_objects` | 1–100 object IDs and object-style fields | Updated object IDs, summary, warnings | Yes |
| `move_objects` | 1–100 object IDs plus relation or row/grid arrangement | Moved object IDs, summary, warnings | Yes |

`get_document` labels each object `inScope`, so a model can see the fixed write boundary. The host,
not the model, chooses placement: it uses the pinned tab's visible free area or an unoccupied page
area. Rows and grids use actual item widths and wrap at the page's content edge, including margins
and captions; molecules are never rescaled. Models never supply page coordinates.

Use `{kind: "group", label: "CH3"}` for “draw a methyl group”. A group is one native molecule
atom with a literal abbreviation or condensed-formula label, drawn and interpreted exactly as a
typed canvas label. Examples include `CH3`, `Me`, `Et`, `Ph`, `Bn`, `Boc`, `OTs`, `OMe`, `NO2`,
`CF3`, and `CONH2`. Labels are trimmed, case-sensitive, and limited to 80 characters. No SMILES
depiction or separate caption is made. The shared label grammar and `atoms.ts` supply all chemistry,
including warnings about unfilled group valences and formulas without known connectivity; insertion
does not add bonds, radicals, implicit hydrogens, or invented chemistry to complete a group.
Unknown labels, placeholders (`R`, `*`), and bare elements are refused with accepted examples.
In particular, isolated `Ac` means actinium in the native grammar; it is refused as a group rather
than silently changed to acetyl. `get_document` includes literal `atomLabels` even when a label
cannot be serialized to SMILES. Groups share molecule placement, page enlargement and undo rules.

For `insert_structures`, `insert_reaction`, and `insert_text`, if an item is too wide/tall or the
wrapped set runs off the bottom, the host computes one enlarged page size for the entire call.
It asks once in a native message box owned by the document window on macOS and Windows, naming
the item (using its label when available) and the proposed size in points. Both platforms show
exactly two buttons: **Enlarge Page** in the library's ok/default slot and **Cancel** in its cancel
slot. Esc or Cancel declines; Enlarge Page (Return where the platform makes it the default)
enlarges, and one Undo reverses it. Closing the box, unknown results and native dialog errors
also decline; only the explicit Enlarge Page result approves enlargement.
Internal CSS-pixel sizes are converted to physical points for this message.
Approval adds a host-issued `updatePageLayout` alongside the object patches inside the same
assistant request transaction. One Undo restores both page and objects; Redo restores both without
asking again. Plugins and the AI do not acquire a page-layout write capability.

Declining omits the non-fitting cells (including their captions, or an entire reaction scheme),
retains the fitting items, and leaves the page size unchanged. The tool returns `declined` labels
or IDs and `reason: "declined: the user chose not to enlarge the page"`, also in its text result.
The host pauses its preparation deadlines while awaiting the answer, for at most 300 seconds.
No answer within that time declines enlargement with
`reason: "declined: no answer to the enlarge-page question within 5 minutes"`; fitting items are
still retained, and a later answer cannot insert the omitted items or enlarge the page.
Cancellation by the host ignores a late answer and draws none of that call's pending items. The
document-owned box is modal by design, so the overlay's Stop button cannot be pressed while it is
open. **Cancel** is the stop for that non-fitting item; the overlay's **Stop** works again immediately
after the answer to cancel the remaining request. Write calls have a
480-second MCP transport and client budget, covering preparation, the human decision and the write
gate. Transport expiry sends cancellation and likewise ignores the pending answer.
A document edit while confirmation is open invalidates the plan.
The native API cannot programmatically close an open message box, so an ignored box may remain
until dismissed; Esc or Cancel declines. Return may activate Enlarge Page where it is the default,
but an answer after cancellation cannot change the document.
This growth confirmation applies only to assistant insert tools, not paste, Insert Name, templates,
or import. It replaces the former off-page placement warning.

Every write is first applied to a cloned document. Molecules built from SMILES are checked again
against RDKit canonical SMILES after conversion. A mismatch, including isotope or radical loss,
refuses the write; styling is revalidated and may not silently alter chemistry.

## Write scope and history

Pressing Send snapshots the selected object IDs. During that request the assistant may add objects,
and may edit, move, restyle, reorder, or delete only those selected objects plus objects it inserted
earlier in the same request. With no selection it can insert only. A patch with an out-of-scope
operation is refused as a whole and identifies the first offending object.

There is no approval window for ordinary assistant writes. The request is one history entry labelled
`ChemDraft Assistant: <request>`, and its final created/changed objects are selected. Undo restores
the recorded before-state; Redo restores the recorded after-state. Neither re-runs the plugin, a
provider, nor any tool. A user edit while a request is still running closes its open history entry,
so later assistant writes become a separate entry and the transcript can report that split.

## Loopback MCP server

When a plugin creates a tool session, Rust lazily binds one server to literal `127.0.0.1:0`; it is
not exposed on LAN interfaces. Sessions are limited to two per plugin and eight total. Each has a
random route ID and bearer token, and the listener stops after the sessions close, plugin unload, or
app shutdown. A session is exclusively bound to its external-tool run and is released when that run
ends.

The endpoint is `POST /mcp/<route-id>`. It accepts one JSON-RPC request, not batches. It requires
`Host: 127.0.0.1:<port>`, `Content-Type: application/json`, and `Authorization: Bearer <token>`;
after `initialize`, it also requires `Mcp-Session-Id` equal to the route ID. An optional Origin must
be loopback or `null`; no CORS headers are emitted. Supported protocol versions are 2025-06-18,
2025-03-26, and 2024-11-05. `initialize`, `ping`, `tools/list`, `tools/call`, and notifications are
handled; cancellation notifications are forwarded to the host.

The server returns 401 with `WWW-Authenticate: Bearer` for a bad token, 403 for Host/Origin failure,
404 for an unknown route/session, 405 (with `Allow: POST`) for another method, 413 above the 1 MiB
body limit, 431 for headers above 16 KiB, 415 for a non-JSON content type, 400 for an unsupported
MCP protocol version, and JSON-RPC parse/invalid-request errors where applicable. Unknown methods
are `-32601`; an over-limit fifth call is `-32000 busy`. There are at most four in-flight calls per
session, 16 connections, a 10-second header timeout, 60-second connection idle bound, and an 8 MiB
result limit. Deadlines are 10 seconds for `tools/list`, 45 seconds for naming, 60 seconds for
rendering, 120 seconds for other read calls, and 480 seconds for the seven write tools; timeout is
`-32000`. Codex's server-wide tool timeout and Claude's `MCP_TOOL_TIMEOUT` and
`CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT` allow 480 seconds;
the host continues to enforce the shorter read deadlines.

The credential never crosses the Rust-to-webview bridge or command line. Rust writes the Claude
configuration with its bearer credential into the private run directory; Codex receives it only as
the Rust-injected `CHEMDRAFT_MCP_TOKEN` environment variable and is configured to use that variable.

## Web access and its risk

By owner decision, web access is enabled for the provider CLI: Claude receives `WebSearch` and
`WebFetch`, while Codex is configured for live web search. This is intentionally separate from
ChemDraft's document tools. Web pages and document text are untrusted data: prompt injection can
try to redirect the model, and a web-capable model can exfiltrate information it was given to a
third party.

Mitigations are scope rather than a promise that web content is safe: only the selected-at-Send
objects and request insertions can be changed, one Undo reverses the request, tool calls are bounded
and transcript-visible, and the supplied system prompt tells the model to treat document/tool text
as data rather than instructions. The host still supplies only its fixed command templates, confines
MCP to its own server, and disables user/project CLI extensions. Users should not send confidential
drawings or prompts to a provider unless they accept that the provider and requested web services
may receive that material.

## Plugin API 0.1.9 lifecycle

`PluginApiVersion` 0.1.9 adds `context.assistant`; a plugin declares `apiVersion: "^0.1.9"` and the
assistant permissions (`document.read`, `document.write`, `selection.read`, `chemistry.compute`,
`native.execute`, and `assistant.run`). The capability
offers `listTools`, request-scoped `callTool`, `beginRequest`, `endRequest`, `createToolSession`, and
`closeToolSession`.

A plugin begins a request before invoking tools, which pins the active tab and selection at Send.
It can call tools in process or create an MCP session for a CLI run; it must end the request and
close the session when the run ends. The host closes outstanding sessions and requests on plugin
unregister or tab close. Every method is permission-checked by the worker bridge and again by the
host; individual tools check their own permissions before work starts.
