# @chemdraft/chemdraft-mcp

`@chemdraft/chemdraft-mcp` exposes ChemDraft's headless CLI operations as a local stdio MCP server. It invokes the CLI command modules in-process, so the RDKit WASM stays warm between tool calls.

## Register with Claude Code

```bash
claude mcp add chemdraft -- pnpm --dir /Users/jeremiahgassensmith/programming/chemdraw chemdraft-mcp
```

For Claude Desktop, add this stanza to `claude_desktop_config.json`:

```json
{"mcpServers":{"chemdraft":{"command":"pnpm","args":["--dir","/Users/jeremiahgassensmith/programming/chemdraw","chemdraft-mcp"]}}}
```

## Tools

- `render_structure` — render a SMILES structure as PNG, SVG, or both.
- `render_grid` — render named SMILES structures in a PNG grid.
- `render_reaction` — render reaction SMILES as a PNG scheme.
- `analyze_structure` — run the property and prediction suite.
- `name_to_structure` — convert a chemical name with OPSIN, optionally rendering it.
- `check_stereo` — inspect specified and unspecified stereocentres.
- `predict_nmr` — predict 1H/13C shifts and optional spectra.
- `export_structure` — write CDXML, PDF, SDF, MOL, or SMILES.

Radicals and isotopes that ChemDraft cannot preserve are refused rather than silently changed. Analysis values retain their method contracts and reported pKa intervals; NMR J values and multiplicities are estimates.
