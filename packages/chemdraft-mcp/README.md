# @chemdraft/chemdraft-mcp

`@chemdraft/chemdraft-mcp` exposes ChemDraft's headless CLI operations as a local stdio MCP server. It invokes the CLI command modules in-process, so the RDKit WASM stays warm between tool calls.

## Register with Claude Code

```bash
claude mcp add chemdraft -- pnpm -s --dir <path-to-chemdraw-checkout> chemdraft-mcp
```

For Claude Desktop, add this stanza to `claude_desktop_config.json`:

```json
{"mcpServers":{"chemdraft":{"command":"pnpm","args":["-s","--dir","<path-to-chemdraw-checkout>","chemdraft-mcp"]}}}
```

## Document style

`render_structure`, `render_grid`, `render_reaction`, and `render_document` accept optional
`style: "fit" | "document"` (default `fit`) and `dpi` (document PNG, default 300,
range 72–1200). `dpi` is rejected when no PNG is written, including `build_document`.
`build_document` also accepts `style`, so building and rendering native JSON
can use the same geometry. Document style rejects `width`, `bondLength`, and `padding` where
those parameters exist; conflicts are returned as tool errors.

The fixed document style uses 14.4 pt bonds, 1.134 pt lines, 2.268 pt bold bonds/wedges,
18% double-bond spacing, 2.5 pt hash spacing, 1.6 pt bond margins, 120° chains, Arial 10 pt
formula labels with subscripted counts, Arial 10 pt captions/conditions, and a fixed 4 pt
outer margin. Grid cells grow rather than shrinking molecules. SVG dimensions and viewBox
are in points: **insert SVG at natural size (100%) and never resize it**. For PNG, use the
reported `widthPt`/`heightPt` as the insertion size (72 pt = 1 inch); its pixel scale comes
from `dpi` (60 pixels per bond at 300 dpi). JSON results record `style`, figure physical size,
and PNG `dpi`. `render_document` document style supports SVG/PNG/both; PDF/ChemDraft retain
native page size. Document style scales the whole first page uniformly, including molecules, object
frames, arrow endpoints/control points, graphics, captions and page size. It uses each molecule’s
median bond length; if those lengths differ by more than 2%, it uses the median across molecules and
emits a warning naming that value. Colours, appearance toggles and all per-atom/per-bond style maps
are preserved. Arrows and plain graphic strokes use 1.134 pt; text uses Arial, Helvetica, sans-serif
at 10 pt unless an explicit object/span size is present, which scales with the page. See the [CLI
details](../chemdraft-cli/README.md#fixed-scale-document-figures).

## Tools

- `render_structure` — render a SMILES structure as PNG, SVG, or both.
- `build_document` — build editable native JSON from `smiles`, returning it inline and as a host
  file with atom/bond ids, input atom indices, ring keys and ring centers. Optional `bondLength`
  and `outDir` match the CLI document builder.
  Unspecified stereogenic double bonds stay open by default, with native `stereo: "either"`
  and matching stored MOL markers. `CC=CC` remains `CC=CC` through `render_document` and
  SMILES export; specified `C/C=C/C` stays E. The E/Z warning counts only open bonds.
- `render_document` — render a native JSON document or `.chemdraft` envelope supplied through
  exactly one of `documentPath` (host file) or `documentJson` (inline JSON text). Optional `format`
  is `svg|png|pdf|chemdraft|both` (default PNG); `width`, `background`, `padding` and `outDir`
  follow the CLI. The first result block includes canonical SMILES and stereo counts from each
  current molecule graph, plus structured export warnings; PNGs are images, SVG/native files
  are inline text, and PDFs are embedded resources. Inline input and files have a 5 MB input
  limit; the CLI's object/atom limits also apply.
- `render_grid` — render named SMILES structures in a PNG or SVG grid.
- `render_reaction` — render reaction SMILES, or role arrays that keep dot-joined salts together, as a PNG or SVG scheme; agent display text is recorded. Optional `above` and `below` string arrays place lines around the arrow, and `caption` adds a note under the scheme. `conditions` remains supported.
- `analyze_structure` — run the property and prediction suite with status-bearing summary values.
- `name_to_structure` — check ChemDraft built-in structure templates before OPSIN, optionally rendering it (no Java needed for template names).
- `check_stereo` — inspect tetrahedral R/S centres and E/Z double bonds with 0-based indices.
- `predict_nmr` — predict 1H/13C shifts and optional spectra. It loads the separately checked-out NMR predictor plugin, which must be listed in `~/.config/chemdraft/trusted-plugins.json`; `CHEMDRAFT_NMR_PLUGIN_DIR` alone never makes an unlisted directory load (see the CLI README, "Plugin trust file").
- `export_structure` — write CDXML, PDF, SDF, MOL, or SMILES.

Reaction labels allow at most 6 `above` and 6 `below` entries, a non-empty `caption` of at most 300 characters, and 2000 characters combined across above, below, caption and legacy `conditions`.

Radicals are refused rather than silently changed. Isotope labels and their positions are preserved.
Analysis values retain their method contracts and reported pKa intervals; NMR J values and
multiplicities are estimates.

For styled figures, call `build_document`, edit its returned JSON using the reported ids and ring
centers, then call `render_document` with `documentJson`. Ring fills, bold/hashed bonds, sketch
effects, text and art use the existing native renderer; compare the returned canonical SMILES
with the build result to confirm chemistry after styling. Ordinary separately written `[H]`
atoms are removed by existing depiction. SVG/PNG/PDF render the first page (PDF keeps native
page size); ChemDraft saves retain all pages. Unknown art and omitted reflection effects carry
export warnings. See the [CLI README](../chemdraft-cli/README.md#render-document) for the native
style example and limits.

Each tool invocation writes into a fresh per-call directory beneath the server's temporary root, so
simultaneous or repeated structures with the same readable filename cannot overwrite one another.
The server removes per-call directories older than 24 hours when its temporary root starts and then
checks at most once per minute. A caller-supplied `outDir` is also treated as a root and receives a
fresh `call-*` child directory for each invocation.

PNG files are returned as MCP image content, SVG and text exports are returned inline as text, and
PDF exports are returned as embedded `application/pdf` resources. The JSON result remains the first
text block and records the retained host path. Any individual returned payload is limited to 5 MB.

Use `pnpm -s` when launching either CLI or MCP scripts: bare `pnpm <script>` prints a script banner
to stdout, which corrupts JSON Lines and stdio MCP framing.

Use template names such as `beta-cyclodextrin`, `β-CD`, `cucurbit[7]uril` or
`18-crown-6` with `name_to_structure` rather than writing SMILES for these hosts.
Name results report `source` and, for templates, `templateId` and `templateName`.
SMILES drawing tools inherit exact canonical isomeric template matching from the CLI
and report `layout: "template:<id>"` (per cell/component for grids/reactions).
Stereo and charge must match; template drawings use the default document bond length.
`render_document` preserves the coordinates in its native JSON input.
