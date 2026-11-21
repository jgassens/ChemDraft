# Request Tools Legacy Fixture

This MIT-licensed test fixture is excluded from ChemDraft releases. It uses the workspace SDK
to exercise a worker that declares `^0.1.25` and advertises the three protocol opt-ins
introduced in 0.1.26. Its document and selection commands use the 0.1.25 API.

From the repo root, with the fixture source committed and workspace dependencies available, run
`pnpm plugin:package -- examples/plugins/request-tools-legacy-fixture`. Keep the
`.zip.sha256` sidecar next to the ZIP in `dist/plugin-packages/` and choose
**Plugins > Add or Remove Plugins… > Add plugin from package…** to install it.

The **Legacy Fixture** commands report the active document, the selection, the result of
starting a request, and any document-change events the worker received. The request should
return `unsupported`. Switch document tabs and rerun the event command to verify that
zero events arrived. The install test also checks the bridge's `unsupported` notification result.
