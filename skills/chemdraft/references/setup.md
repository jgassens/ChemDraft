# Install and connect ChemDraft

Contents: prerequisites; checkout; NMR trust; MCP clients; skill installation;
verification. Replace `<checkout>` and `<plugin-checkout>` with absolute paths
of your choice. All setup commands here are for the human owner to run.
An assistant must not install dependencies or change client configuration
unless the user has requested that setup.

## Prerequisites and checkout

For headless use on macOS and Windows, install Git, Node 24 and pnpm 10.12.1.
Name conversion additionally needs a JDK (Java Development Kit) providing
`jlink`. Set `JAVA_HOME` if the runtime builder cannot find your JDK.
The WASM (WebAssembly) chemistry engines are vendored in the checkout.
The CLI does not require the desktop app or a running window.
Desktop builds have further Rust and platform prerequisites in the
[root README](../../../README.md).

macOS, POSIX shell:

```sh
git clone https://github.com/jgassens/ChemDraft.git "<checkout>"
cd "<checkout>"
pnpm install
node scripts/build-opsin-runtime.mjs
pnpm -s --config.shell-emulator=true --dir "<checkout>" chemdraft --help
pnpm -s --config.shell-emulator=true --dir "<checkout>" chemdraft name --name 'ethanol'
```

Windows, PowerShell (use a checkout outside a synced folder):

```powershell
git clone https://github.com/jgassens/ChemDraft.git "<checkout>"
Set-Location "<checkout>"
pnpm install
node scripts/build-opsin-runtime.mjs
pnpm -s --config.shell-emulator=true --dir "<checkout>" chemdraft --help
pnpm -s --config.shell-emulator=true --dir "<checkout>" chemdraft name --name 'ethanol'
```

The builder creates `apps/desktop/src-tauri/resources/opsin/jre` for the
current host. Build it on each host; do not reuse a macOS runtime on Windows.
The check should return `ok: true` with OPSIN's SMILES, not a missing-Java error.

## Optional NMR plugin and owner trust

The NMR predictor is a separate checkout. Clone it and follow its own README
for dependencies/data setup; ChemDraft does not bundle it. Both shells:

```sh
git clone https://github.com/jgassens/ChemDraft-NMR-Plugin.git "<plugin-checkout>"
```

Choose the directory explicitly rather than depending on a default location.
macOS:

```sh
export CHEMDRAFT_NMR_PLUGIN_DIR="<plugin-checkout>"
pnpm -s --config.shell-emulator=true --dir "<checkout>" chemdraft nmr --smiles 'CCO'
```

Windows PowerShell:

```powershell
$env:CHEMDRAFT_NMR_PLUGIN_DIR = '<plugin-checkout>'
pnpm -s --config.shell-emulator=true --dir "<checkout>" chemdraft nmr --smiles 'CCO'
```

The exact trust-file location comes from `os.userInfo().homedir`, the OS
account lookup, followed by `.config/chemdraft/trusted-plugins.json`:

- macOS: `~/.config/chemdraft/trusted-plugins.json`, under the account home.
- Windows: the account profile's `.config\chemdraft\trusted-plugins.json`
  (normally `%USERPROFILE%\.config\chemdraft\trusted-plugins.json`).

The lookup does **not** trust `HOME`, `USERPROFILE` or `XDG_CONFIG_HOME`
overrides. If it cannot determine the account home, loading is refused.
The environment variable chooses among already trusted directories; it
does not grant trust. The refusal prints the actual trust path and exact
entry the owner must add. **The agent must never create or edit this trust
file. Show the user the entry printed in the error and let them decide.**
The version-1 file has this shape (replace the directory before use):

```json
{"version":1,"trustedPlugins":[{"id":"org.chemdraft.nmr.predictor","dir":"<plugin-checkout>"}]}
```

Use an absolute real directory; Windows JSON backslashes must be escaped
or use forward slashes. Real-path checks allow a symlink to a trusted
directory but refuse manifest/entry files that escape it. The CLI checks the
trust-file allow-list, imports and validates `src/manifest.ts`, then imports
`src/index.ts` and checks its exports, including required capabilities.
Old checkouts without the grouping/disclosure capabilities are refused, but
the entry has already executed by then. The allow-list bounds which code
can run; this plugin runs with the CLI process's privileges, not in a sandbox.
See [NMR](nmr.md) for scientific and licence constraints.

## Register MCP

Run the server on the same computer as the assistant client. These commands
work in a POSIX shell or PowerShell after replacing `<checkout>`:

```sh
claude mcp add --scope user chemdraft -- pnpm -s --dir "<checkout>" chemdraft-mcp
codex mcp add chemdraft -- pnpm -s --dir "<checkout>" chemdraft-mcp
```

User scope makes the Claude Code tools available in every folder.
The MCP launch needs no shell-emulator flag because tool arguments arrive as JSON, not command-line arguments.

Alternatively, add this to `~/.codex/config.toml`:

```toml
[mcp_servers.chemdraft]
command = "pnpm"
args = ["-s", "--dir", "<checkout>", "chemdraft-mcp"]
```

For Windows TOML paths, use forward slashes or a literal single-quoted
string. Codex's [MCP documentation](https://developers.openai.com/codex/mcp/)
describes the command/args contract. If NMR needs an explicit directory,
add `CHEMDRAFT_NMR_PLUGIN_DIR` to the server's environment too; the trust
requirement remains unchanged.

Claude Desktop: edit its `claude_desktop_config.json`, preserving other
servers. Typical locations are `~/Library/Application Support/Claude/` on
macOS and `%APPDATA%\Claude\` on Windows. Restart the client after editing.

```json
{"mcpServers":{"chemdraft":{"command":"pnpm","args":["-s","--dir","<checkout>","chemdraft-mcp"]}}}
```

GUI clients may have a different PATH from your terminal. If `pnpm` is not
found, set `command` to its full executable path. On Windows, if the client
cannot launch a `pnpm.cmd` shim, use `command: "cmd.exe"` and arguments
`["/d", "/c", "pnpm", "-s", "--dir", "<checkout>", "chemdraft-mcp"]`.
Do not remove `-s`: stdout must contain only MCP protocol messages.

ChatGPT on the web cannot use ChemDraft: it cannot reach a program on the
user's computer, and ChemDraft's MCP server is local stdio only. Use a
local client such as Claude Code, Claude Desktop with MCP, or Codex.

## Install the skill

macOS (choose one or both clients; do not overwrite an existing skill):

```sh
mkdir -p "$HOME/.claude/skills" "$HOME/.codex/skills"
ln -s "<checkout>/skills/chemdraft" "$HOME/.claude/skills/chemdraft"
ln -s "<checkout>/skills/chemdraft" "$HOME/.codex/skills/chemdraft"
```

Windows PowerShell, directory junctions (no administrator rights needed):

```powershell
New-Item -ItemType Directory -Force "$HOME\.claude\skills", "$HOME\.codex\skills"
New-Item -ItemType Junction -Path "$HOME\.claude\skills\chemdraft" -Target "<checkout>\skills\chemdraft"
New-Item -ItemType Junction -Path "$HOME\.codex\skills\chemdraft" -Target "<checkout>\skills\chemdraft"
```

Or copy the entire `skills/chemdraft` folder, including references. A copy
needs an explicit checkout path for CLI discovery and manual updates when
ChemDraft changes. Claude Desktop: upload the folder as a skill (archive
it if the client's upload dialog requires an archive), and pair it with
the MCP server above. A skill upload alone does not run local chemistry.

## Verification checklist

- CLI help lists 10 commands; name conversion returns `ok: true`.
- The client discovers all 10 tools listed in [SKILL.md](../SKILL.md).
- Render ethanol once using [recipes](recipes.md); view the image.
- Analysis returns status-bearing values with full method contracts.
- Optional NMR works only after the owner reviews the trust entry.
- Repeat verification on macOS and Windows; a host-specific Java runtime
  and Windows launcher/configuration need checks on their own host.
