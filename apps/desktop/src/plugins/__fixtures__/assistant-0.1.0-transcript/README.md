# Real Assistant transcript regression fixture

`entry.js`, `manifest.json`, and `LICENSE` are unmodified copies of the owner's new
`chemdraft-assistant-0.1.0/` distribution, packaged 2026-10-24 from clean source commit
`3e06b5b7d7e85bea922be8ac0f2bc2b9ba89b974`, SDK/API 0.1.11.
The older `../assistant-0.1.0` fixture remains intact for its existing tests.

SHA-256:

- entry.js: `f1d3583114f57299673515656ffc4ecd728027700a7a7091dd95454407c1f859`
- manifest.json: `b7e96d8497c00c2c1202017e77f4002c2620a1c492c7b5d1a0c2fa145707f827`
- real-tool-reply.stdout.jsonl: `12b43936b4f7ffc916275bd4348db032ad1cd947c610b9546d5052b34fefc9b8`

The JSONL is the owner's captured real Codex output, copied verbatim from
`.agentctl/manifests/assistant/captures/real-tool-reply.stdout.jsonl`. Its MCP replies explicitly
say they are canned; it tests real provider-output parsing and transcript transport, not chemical
insertion. The entry's inherited LICENSE is preserved verbatim; no database is included.

`assistantOverlay.integration.dom.test.tsx` executes the bundle in an isolated VM with a
structured-cloning Worker transport, through `loadPackagedPlugin`, the real worker bridge,
plugin host, desktop stores and subscriptions, MainWindow dispatch, and the real overlay and panel
renderers. Native tool IPC returns the captured lines; no plugin handlers, transcripts, reports,
or host capability methods are replaced. Both macOS and Windows origins are exercised.

The same test was run with only the entry/manifest switched to `../assistant-0.1.0`: both cases
failed (`expected '' to contain 'Draw benzene'`). Restoring this new bundle made both pass without
a host transcript fix. The installed assistant-c package had the old entry's exact SHA-256 and
zero `setTranscript` references. See `docs/assistant-overlay-one-box.md` for the diagnosis and
plugin migration instructions. Native WebKit/WebView2 and packaged-app checks remain separate.
