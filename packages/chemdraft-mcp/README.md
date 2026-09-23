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
- `render_grid` — render named SMILES structures in a PNG or SVG grid.
- `render_reaction` — render reaction SMILES, or role arrays that keep dot-joined salts together, as a PNG or SVG scheme; agent display text is recorded.
- `analyze_structure` — run the property and prediction suite with status-bearing summary values.
- `name_to_structure` — convert a chemical name with OPSIN, optionally rendering it.
- `check_stereo` — inspect tetrahedral R/S centres and E/Z double bonds with 0-based indices.
- `predict_nmr` — predict 1H/13C shifts and optional spectra.
- `export_structure` — write CDXML, PDF, SDF, MOL, or SMILES.

Radicals and isotopes that ChemDraft cannot preserve are refused rather than silently changed. Analysis values retain their method contracts and reported pKa intervals; NMR J values and multiplicities are estimates.

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
