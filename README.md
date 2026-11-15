# ChemDraft

ChemDraft 1.1.0 is a free, open-source chemical drawing application for macOS and Windows. It puts local files first and is licensed under Apache-2.0.

## Download

Get the latest release from [GitHub Releases](https://github.com/jgassens/ChemDraft/releases/latest) or visit [chemdraft.ai](https://chemdraft.ai).

## What it does

- Draw molecules, reactions and mechanisms with bonds, rings, arrows, atom labels and chemical abbreviations.
- Import and export CDXML, and export drawings as SVG, PDF or PNG.
- Copy structures and editable tables for use in Office applications.
- Add editable tables and pictures, and use structure templates.
- Inspect molecular properties and analysis results, and explore structures with Spin 3D.
- Convert chemical names to structures with OPSIN, or with an offline dictionary of common and trade names and CAS registry numbers.
- Search a selected structure in PubChem or Reaxys through your browser, with first-use consent per site; turn it off under Preferences ▸ Online structure search.
- Extend the app with plugins, including the optional official NMR predictor and MolScribe structure-recognition plugins.
- Use the headless CLI, MCP server and [agent skill](skills/chemdraft/SKILL.md) from scripts or coding assistants.

Spin 3D may not start on macOS 15 or earlier in version 1.1.0; a fix is planned for 1.1.1.

The Structure menu offers ChemDraft Synthetic, Document style, ACS 1996-style, RSC
journal-style and Sketch. Sketch uses uneven pen strokes and bundled Patrick Hand handwriting.
Apply a preset to selected molecules/text, or clear the selection to style the
whole document and its new-object defaults. See [native preset values and sources](packages/chem-core/README.md#native-drawing-presets).

## Plugins

Plugins add capabilities without putting them all in the core application. See the [plugin authoring guide](docs/plugin-architecture/AUTHORING.md) to build one. Plugins ▸ Vibe Code Your Own Plugin… arrives in 1.1.1 with a guide and starter file for working with a coding assistant.

## Roadmap

See the [roadmap](ROADMAP.md) for upcoming releases and ideas.

## Building from source

Install Node.js, pnpm and Rust, then run `pnpm install`. On macOS, use `./run-app` to build and launch the packaged app; on Windows, use `pnpm dev`. See [AGENTS.md](AGENTS.md) for platform prerequisites, development rules and verification guidance.

The verification gauntlet is:

```sh
pnpm lint
pnpm vitest run
pnpm build
git diff --check
cargo fmt --manifest-path apps/desktop/src-tauri/Cargo.toml --check
cargo clippy --all-targets --manifest-path apps/desktop/src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml
```

## Contributing and reporting bugs

Contributions and reports are welcome on [GitHub Issues](https://github.com/jgassens/ChemDraft/issues). You can also use Help ▸ Report a Bug… in the app.

## Support

ChemDraft is free and open source. If it helps your work, you can [support its development](https://buymeacoffee.com/gassensmith).

## License

ChemDraft is licensed under [Apache-2.0](LICENSE). See [NOTICE](NOTICE) for attribution and third-party notices.
