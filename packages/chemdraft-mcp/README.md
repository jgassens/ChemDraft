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

## Tools

- `render_structure` — render a SMILES structure as PNG, SVG, or both.
- `build_document` — build editable native JSON from `smiles`, returning it inline and as a host
  file with atom/bond ids, input atom indices, ring keys and ring centers. Optional `bondLength`
  and `outDir` match the CLI document builder.
- `render_document` — render a native JSON document or `.chemdraft` envelope supplied through
  exactly one of `documentPath` (host file) or `documentJson` (inline JSON text). Optional `format`
  is `svg|png|pdf|chemdraft|both` (default PNG); `width`, `background`, `padding` and `outDir`
  follow the CLI. The first result block includes canonical SMILES and stereo counts from each
  current molecule graph, plus structured export warnings; PNGs are images, SVG/native files
  are inline text, and PDFs are embedded resources. Inline input and files have a 5 MB input
  limit; the CLI's object/atom limits also apply.
- `render_grid` — render named SMILES structures in a PNG or SVG grid.
- `render_reaction` — render reaction SMILES, or role arrays that keep dot-joined salts together, as a PNG or SVG scheme; agent display text is recorded.
- `analyze_structure` — run the property and prediction suite with status-bearing summary values.
- `name_to_structure` — convert a chemical name with OPSIN, optionally rendering it.
- `check_stereo` — inspect tetrahedral R/S centres and E/Z double bonds with 0-based indices.
- `predict_nmr` — predict 1H/13C shifts and optional spectra. It loads the separately checked-out NMR predictor plugin, which must be listed in `~/.config/chemdraft/trusted-plugins.json`; `CHEMDRAFT_NMR_PLUGIN_DIR` alone never makes an unlisted directory load (see the CLI README, "Plugin trust file").
- `export_structure` — write CDXML, PDF, SDF, MOL, or SMILES.

Radicals and isotopes that ChemDraft cannot preserve are refused rather than silently changed. Analysis values retain their method contracts and reported pKa intervals; NMR J values and multiplicities are estimates.

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
