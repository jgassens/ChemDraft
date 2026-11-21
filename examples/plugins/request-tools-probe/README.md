# Request Tools Probe

An MIT-licensed test and demo plugin for the ChemDraft 0.1.26 request API. Its nine
**Probe** commands in the **Plugins** menu report pinned reads, writes, scope refusals,
page-space decisions, tool sessions, selection measurements, PNGs and document events.

From the repo root, with the plugin source committed and workspace dependencies available, run
`pnpm plugin:package -- examples/plugins/request-tools-probe`. Keep the resulting
`dist/plugin-packages/request-tools-probe-0.1.0.zip.sha256` beside the ZIP. In a packaged
ChemDraft build choose **Plugins > Add or Remove Plugins… > Add plugin from package…**,
select the ZIP, review the permissions and click **Install**.

Use disposable documents for the write checks. The two session tools are read-only.
The host owns client authorization for the loopback server.
