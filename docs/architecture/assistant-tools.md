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
| `list_commands` | none | Allowlisted command IDs, titles, one-line usage guidance, selection/document/view target, chemistry and selection flags | No |
| `run_command` | `id`, optional empty `args` | Changed object IDs and summary, or `opened the 3D view` | Depends on command |
| `get_document` | `includeSmiles?`, `maxObjects?` (1–500) | Document/page/object summary, selection, counts and truncation state | No |
| `get_selection` | none | Summary of the selection captured at Send, or empty | No |
| `get_structure` | molecule `objectId`, `smiles` or `molfile` format | Serialized structure and warnings | No |
| `render` | document, selection, or up to 50 object IDs; page, size (256–2048 px), background | PNG image plus dimensions | No |
| `name_to_structure` | name | Parsed SMILES and engine, or an unavailable/declined result | No |
| `validate_smiles` | SMILES | Validity, canonical SMILES, formula, heavy-atom count and warnings | No |
| `structure_to_name` | molecule `objectId` | Naming-engine result; reports an absent Orthonym engine without opening installation UI | No |
| `insert_structures` | 1–24 molecule SMILES, group labels and/or text items; row/grid/auto; optional figure placement | Inserted object IDs, summary, warnings | Yes |
| `insert_reaction` | 1–6 reactants, 1–6 products, optional reagents/conditions, arrow kind, figure placement | Inserted object IDs, summary, warnings | Yes |
| `insert_text` | text, optional relation, style and figure placement | Inserted object IDs, summary, warnings | Yes |
| `edit_structure` | molecule `objectId`, SMILES, optional keep-position | Replacement object IDs, summary, warnings | Yes |
| `delete_objects` | 1–100 object IDs | Removed object IDs, summary, warnings | Yes |
| `style_objects` | 1–100 object IDs and object-style fields | Updated object IDs, summary, warnings | Yes |
| `move_objects` | 1–100 object IDs plus offset, relation, row/grid arrangement or figure placement | Moved object IDs, summary, warnings | Yes |

`get_document` labels each object `inScope`, so a model can see the fixed write boundary. The host,
not the model, chooses placement: it uses the pinned tab's visible free area or an unoccupied page
area. Rows and grids use actual item widths and wrap at the page's content edge, including margins
and captions; molecules are never rescaled. Explicit anchors permit intentional overlap; models
supply figure-anchor offsets in bond lengths. For a rigid offset move, use
`move_objects({objectIds: ["mol_1"], to: {by: {dx: 100, dy: 0}}})`. These offsets
are document points (positive x right, positive y down); each must be finite and within
±5000, and offsets with both magnitudes below 0.01 pt (including `(0, 0)`) are refused
as no-ops below the intentional minimum move size (not a storage precision limit). All moved IDs must be in the request write
scope. The usual anchored-object refusal and normalized-commit chemistry/charge-mark
guards apply; the host never shifts an offset move to another free position. Overflow past
any page content edge is refused for offset moves, naming the offending object and offset;
the whole call moves nothing and does not ask to enlarge the page.

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
It asks once per assistant request in a native message box owned by the document window on macOS and Windows, naming
the item (using its label when available) and the proposed size in points. Both platforms show
exactly two buttons: **Enlarge Page** in the library's ok/default slot and **Cancel** in its cancel
slot. Esc or Cancel declines; Enlarge Page (Return where the platform makes it the default)
enlarges, and one Undo reverses it. Closing the box, unknown results and native dialog errors
also decline; only the explicit Enlarge Page result approves enlargement. That answer applies to
the whole request: later writes needing more room grow silently after approval, or skip their
overflowing items after a decline, without asking again. A new request asks anew.
Internal CSS-pixel sizes are converted to physical points for this message.
Approval adds a host-issued `updatePageLayout` alongside the object patches inside the same
assistant request transaction. One Undo restores both page and objects; Redo restores both without
asking again. Plugins and the AI do not acquire a page-layout write capability.

Declining omits the non-fitting cells (including their captions, or an entire reaction scheme),
retains the fitting items, and leaves the page size unchanged. Each tool result names every omitted
item in `declined` using its label or ID, including every item in a declined anchored figure and
later writes skipped after a decline. It returns `reason: "declined: the user chose not to enlarge the page"`,
also in its text result, so the assistant can say what was never drawn.
The host pauses its preparation deadlines while awaiting the answer, for at most 300 seconds.
No answer within that time declines enlargement with
`reason: "declined: no answer to the enlarge-page question within 5 minutes"`; fitting items are
still retained, and a later answer cannot insert the omitted items or enlarge the page.
Cancelling one call stops its wait and draws none of its pending items; the shared question stays
open for other calls, which receive the user's real answer. Only ending the request or the
300-second cap stops the shared question and ignores a late answer. The
document-owned box is modal by design, so the overlay's Stop button cannot be pressed while it is
open. **Cancel** is the stop for that non-fitting item; the overlay's **Stop** works again immediately
after the answer to cancel the remaining request. Write calls have a
480-second MCP transport and client budget, covering preparation, the human decision and the write
gate. Transport expiry sends cancellation and likewise ignores the pending answer.
A document edit while confirmation is open invalidates the plan.
The native API cannot programmatically close an open message box, so an ignored box may remain
until dismissed; Esc or Cancel declines. Return may activate Enlarge Page where it is the default,
but an answer after cancellation cannot change the document.
This growth confirmation applies to assistant insert tools and anchored figure moves, not paste,
Insert Name, templates, or import. It replaces the former off-page placement warning.

### Figure placement and interlocks

`move_objects` and all three insert tools accept the same figure options:

```json
{
  "to": {
    "relativeTo": "ring_object_id",
    "anchor": { "ringKey": "ring_key_from_get_document" },
    "offset": { "dx": 0, "dy": 0 },
    "rotateDeg": 0
  },
  "crossings": "auto"
}
```

`anchor: "center"` uses the target's atom centroid (frame center for other objects).
`{ringKey}` uses that ring's rendered polygon centroid. `"axis"` uses the largest-area ring's
centroid and long axis, or the object's centroid/axis if it has no ring; it aligns the placed
figure's first molecule long axis before applying `rotateDeg`. Other anchors apply `rotateDeg`
as a relative clockwise rotation. The figure pivots about the mean of its molecule centroids;
attached inserted captions move with it. Offsets use the page x/y axes, measured in the target's
median bond length (22 native units for non-molecules). Offsets are bounded to ±100 bond lengths
and rotation to ±360°. Placement is rigid: no scaling, new bonds, or merging. Moving linked
mechanism geometry independently remains refused. Targets must be on the same page; inserts use
the target's page. Without `crossings`, an out-of-scope object may serve as a read-only anchor.

Explicit anchors preserve overlap and their exact relative placement. Right/bottom overflow uses
the same host-only native enlargement question as ordinary insertions, including anchored moves.
Accepting grows the page in the request transaction; declining skips the complete anchored figure
(geometry, stacking and crossings), with `declined: the user chose not to enlarge the page`.
A figure extending past the left/top margin is refused with an offset/anchor hint: the native page
has a fixed origin, so increasing its size cannot fit that placement. No anchor is moved implicitly.

`zOrder` accepts `"front"`, `"behind"`, `{ "above": "object_id" }`, or
`{ "below": "object_id" }`. It uses `setObjectOrder`, exactly as the layout commands do. Since
that patch lists the whole page, every listed object must be in scope. Whole-object stacking
alone does not depict an interlock.

`crossings: "auto"` uses the real layout-engine page render plan after placement. The target
must contain a ring (the named ring, or the largest by area). For an axle, the positive normal
of the ring's oriented long axis defines the front side: the axle is over at the front passage
and under at the back. If intersections lie along the long axis, that axis separates the sides.
For a partner macrocycle (a ring of at least 12 atoms), the line between the two aperture centers
separates its passages; orientation follows the target ring's frame. Each partner passes over
and under the other. Coincident centers use the target's long-axis normal. At least two distinct
intersections are required; missing or ambiguous intersections refuse the entire call with a
placement hint. This is a 2D depiction convention, not a claim about a molecular conformation.

For finer control, supply `crossings: [{ "over": { "objectId": "axle", "bondId": "b1" },
"under": { "objectId": "ring", "bondId": "b7" } }]`. `get_document` supplies bounded ring
frames, ring bond IDs, and molecule bond IDs. Explicit references must actually cross after
placement. Both referenced objects must be in the fixed write scope, including when only one
object moves. All geometry, order, and `setCrossingOverride` operations share one flat atomic
batch and the request's existing undo transaction. The plugin-host checks both bond owners for
`setCrossingOverride` and `clearCrossingOverride`, including batches, and refuses them outside
the trusted host's live assistant transaction even during an ordinary plugin command. The renderer
cuts the existing knockout gap in each back bond; no assistant-specific rendering math or overlay
is involved.

For a pseudorotaxane, validate and insert the host ring and axle as separate molecules, center
the axle on the ring, orient it through the aperture, and request auto crossings. For a
[2]catenane, offset one ring until the ring contours intersect and request auto crossings. Build
the Olympiadane five-component arrangement successively from three CBPQT4+ rings and two
crown-ether macrocycles, setting an auto interlock against each preceding component. Render the
result and refine its offset/orientation; a row of components is not a threaded drawing. If the
requested geometry has no intersections, explain the limitation and refine it rather than
claiming success. Recipe tests check the actual page render plan, visible gaps, separate native
objects, unchanged bond graphs and RDKit canonical SMILES. Their crown-ether depiction is an
explicit 30-crown-10 fixture for testing the five-ring topology, not a reconstruction of a
particular experimentally synthesized Olympiadane.

Every write is first applied to a cloned document and passed through the exact desktop commit
normalization, including charge/radical-mark attachment and native label bond sides. The host checks
all resulting object changes against the request's scope, including changes to neighbouring objects
and marks. Every changed molecule must retain its RDKit canonical isomeric SMILES, atom count and
atom charges. Inserts and `edit_structure` instead use the requested SMILES as their expected
identity, verified both after conversion and after normalization. Standalone literal groups, which
may not have a complete molecular SMILES, retain their exact native label and chemical fields.

For example, moving ethane near an unselected floating `+` can attach that mark even when their
visible rectangles do not overlap. This refuses the entire tool write with the molecule and mark
IDs and an instruction to choose another position. Selecting the mark does not authorize a move to
change the molecule's chemistry. Refusals leave the document, selection and undo history unchanged;
safe automatic placement and ordinary moves/inserts still work. Immediately inside the canvas write
gate, the host repeats normalization and scope checks against the current document and requires all
changed molecules to match those already verified. A newly placed mark during an asynchronous
inspection or canvas gesture cannot bypass the guard. `run_command` results, anchored figure
placements (`to` with `anchor`), z-order and crossing writes take the same path: an anchored move
onto an unselected floating `+` is refused whole, exactly like a side-relative move.

Call `list_commands` before concluding that ChemDraft cannot perform an operation. For example,
for “make this 3D”, discover `structure.spin3d`, then call
`run_command({"id":"structure.spin3d"})`. The allowlist contains the six align commands,
horizontal/vertical distribution and flip, rotate 90°, bring to front, send to back, send backward,
group/ungroup, `structure.cleanup2d`, `structure.cleanup3d`, `structure.spin3d`, and
`structure.openInteractive3d`. Cleanup 3D uses the existing menu command's geometry-engine
rebuild of a clean 2D layout; interactive manipulation and minimization belong to the 3D view.
File, open/save/export/print, preferences, plugins, network, clipboard, debug views, and commands
that ask for a dialog answer are excluded. No current command accepts arguments beyond its ID.

`run_command` invokes the same registry and handlers as menus with an isolated document target
and the selection captured at Send, never the current selection. Its entire result is converted
to one flat patch, checked against the fixed write scope, and applied through the normal assistant
patch/transaction funnel. Linked/grouped children outside that scope refuse the whole call.
Whole-page order patches require every referenced object to be in scope. Cleanup checks each
changed molecule before and after with canonical **isomeric** SMILES through the app's RDKit
inspection path (also used for inserts); an R/S or E/Z change returns
`refused: would change stereochemistry`, and an identity change returns
`refused: would change identity`. The guard also protects molecule changes from layout commands.
Nothing is applied on refusal, timeout, cancellation, or a stale source document.

The two 3D view commands create no document patch or undo entry. They open the captured molecule
for the user and return `opened the 3D view`; an unavailable engine reports failure. Opening a
view requires the pinned tab to be active. Later interactive edits are the user's own actions.

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
