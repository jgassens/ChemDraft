# Code signing policy: desktop network audit (draft)

Source review: 2026-11-02. Repository-relative file:line references describe the checkout reviewed.
This is a source audit, not a packet capture or certification of third-party services. No builds,
downloads, installations or deployments were run.

## Scope and limits

Reviewed `apps/desktop/src`, `apps/desktop/src-tauri/src`, every capability JSON, updater
configuration, bundled plugin registration and the host's official plugin catalog. Searches covered
fetch/HTTP clients, URLs, sockets and subprocess downloads, followed to their callers. Test-only
servers, fixture URLs and SVG namespace identifiers are not production network connections.

All external requests expose source IP, requested URL, timing and HTTP/TLS metadata to the contacted
service and any configured proxy. Download URLs often identify version and platform. Exact
library-generated headers, DNS/TLS exchanges, server logging and retention were not determined.
An allowlist permits traffic; it does not prove traffic occurs or constrain every native client,
subprocess or OS service. Unresolved behavior below must not become a blanket privacy guarantee.

## Automatic requests and app updates

| Recipient / request | What is sent | Trigger and evidence |
| --- | --- | --- |
| Windows feed `https://raw.githubusercontent.com/jgassens/ChemDraft/main/latest.json` | Feed request; no drawing/image/name/structure body supplied by ChemDraft. Configured URL has no version/platform query placeholders; updater-generated headers not determined. | Stable packaged Windows launch, after 15 seconds, when no successful check is recorded within 24 hours; also File → Check for Updates. A failed check can retry on a later launch. Branch/dev builds excluded. `apps/desktop/src-tauri/tauri.windows.conf.json:21`; `apps/desktop/src/appUpdates.ts:23`, `:40`, `:46`, `:227–229`; `apps/desktop/src/MainWindow.tsx:10138`, `:10167`. |
| Windows installer URL in feed, currently `https://github.com/jgassens/ChemDraft/releases/download/v1.0.0/ChemDraft_1.0.0_x64-setup.exe`, and download redirects | Artifact request, no document upload in app flow. Exact updater redirect destinations/headers not determined. | Only after acceptance of Install and Restart. `latest.json:8`; `apps/desktop/src/appUpdates.ts:148–180`. |
| macOS Sparkle feed `https://raw.githubusercontent.com/jgassens/ChemDraft/main/appcast.xml` | Feed request; no document supplied by app. Exact Sparkle headers, version/system metadata and profiling behavior not determined from app configuration. | Packaged macOS app: automatic checks enabled, interval 86,400 seconds; manual menu check too. Actual scheduling/preferences belong to Sparkle. Automatic installation disabled. `apps/desktop/src-tauri/Info.plist:5–14`; `apps/desktop/src-tauri/src/lib.rs:975`, `:1499`, `:7466`; Sparkle dependency `apps/desktop/src-tauri/Cargo.toml:92`. |
| macOS release notes on `raw.githubusercontent.com`, DMGs on `github.com/jgassens/ChemDraft/releases/download/…` and redirects | Release note / artifact requests; no drawing supplied by app. | Feed specifies URLs (`appcast.xml:16–17`). Sparkle can fetch notes when presenting updates; exact timing is library-controlled and not determined here. Update UI controls download/install, without configured silent installation. |
| Official plugin metadata on `https://api.github.com/repos/jgassens/{repository}/releases/latest` | GET, `Accept: application/vnd.github+json`; no body or authorization token supplied by this code. Repository disclosed; installed-version comparison is local. | Default-enabled automatic checks, after startup and daily while running, with installed official plugins and ready desktop catalog; can be disabled in Settings. Manual checks also exist. `apps/desktop/src/pluginUpdateSettings.ts:7`; `apps/desktop/src/plugins/usePluginRuntime.ts:395–445`; `apps/desktop/src/plugins/pluginUpdateAutoCheck.ts:72–79`, `:109–194`; `apps/desktop/src/plugins/pluginUpdates.ts:246–280`, `:342–355`. |
| `HEAD https://{host}/` for `api.github.com`, `github.com`, `release-assets.githubusercontent.com` | Host-root HEAD, no document or failed request body, redirects disabled. | Automatic diagnosis after a plugin request transport failure unless aborted, including failed automatic checks. `apps/desktop/src/plugins/pluginUpdates.ts:143–164`; `apps/desktop/src-tauri/src/download_diagnosis.rs:9–13`, `:24–42`; `apps/desktop/src-tauri/capabilities/download-diagnosis.json:6`. |

## Official plugin downloads and permissions

Catalog: `apps/desktop/src/plugins/pluginUpdates.ts:45–81`.

| Plugin | Repository under `jgassens/` | Release ZIP stem |
| --- | --- | --- |
| NMR Shift Predictor | ChemDraft-NMR-Plugin | `nmr-predictor` |
| Name to Structure (OPSIN) | ChemDraft-OPSIN-Plugin | `opsin-name-to-structure` |
| Structure from Image (MolScribe) | ChemDraft-MolScribe-Plugin | `molscribe-ocsr` |
| Name from Structure (Orthonym) | ChemDraft-Orthonym-Plugin | `orthonym-naming` |

For each repository the main-window HTTP capability allows the latest-release API above,
`https://github.com/jgassens/{repository}/releases/download/*/{stem}-*.zip` and
`{stem}-*.zip.sha256`, plus
`https://release-assets.githubusercontent.com/github-production-release-asset/*`
(`apps/desktop/src-tauri/capabilities/plugin-updates.json:10–50`). No other HTTP URL allowlist was
found in the capabilities. `app-updates.json:6–7` separately grants Windows `updater:default`;
`external-tools.json:9–22`, `naming-engine.json:7–12`, `ocsr-engine.json:7–12` grant narrow native
commands; they are not generic HTTP allowlists. All these filenames are under that same capabilities directory.

User-initiated install/update preparation fetches metadata, checksum and ZIP through GETs, sending
asset paths rather than documents. Package requests permit at most one validated GitHub asset
redirect (including its service-provided signed URL). The automatic checker does not install. The Plugin Manager Install click starts preparation before package review (apps/desktop/src/plugins/PluginManagerDialog.tsx:387–400, :756); accepting an engine-requiring package starts its engine install (:380–384).
Evidence: `apps/desktop/src/plugins/pluginUpdates.ts:297–330`, `:412`, `:487`, `:521–568`;
`apps/desktop/src/plugins/pluginUpdateAutoCheck.ts:109`.

The bundled mass-fragment plugin loads locally (`apps/desktop/src/plugins/registerBundledPlugins.ts:1`,
`:80–84`); no external network call was found in `examples/plugins/mass-fragment-demo/src`.
Installed plugin workers have `connect-src 'self'`
(`apps/desktop/src-tauri/src/installed_plugins.rs:65–71`); desktop `network.fetch` is unavailable
(`apps/desktop/src/plugins/createPluginRuntime.ts:166–170`). Plugin code/data/WASM load from local
app storage via `tauri://localhost` on macOS or `http://tauri.localhost` on Windows, not a remote
server (`installed_plugins.rs:49–55`, `:74–85`).

**Not determined:** released code/dependencies from the four external plugin repositories are not
in this checkout. Host restrictions and host-owned processing were reviewed, not the remote release
ZIPs. Confirm those exact package versions before publishing a broader guarantee. The assistant is
not in the current four-entry official catalog; its available host capability is covered below.

## Optional recognition and naming installation

An explicit Install action starts these downloads, including an approved plugin install with its
required engine; they are not background engine installs. Evidence:
`apps/desktop/src/plugins/StructureRecognitionInstallDialog.tsx:37–55`;
`apps/desktop/src/plugins/StructureNamingInstallDialog.tsx:100`;
`apps/desktop/src/plugins/StructureNamingController.ts:68–79`, `:104–110`.

| Recipient | What is sent / purpose | Evidence |
| --- | --- | --- |
| GitHub `astral-sh/uv/releases/download/{version}/{platform asset}` and redirects | GET for pinned uv installer tool; platform/version in path. | `apps/desktop/src-tauri/src/local_engine/pins.rs:22`; `local_engine/install.rs:591–620`. |
| Python distribution/package sources selected by uv | Python version (recognition 3.10, naming 3.12), package/version and platform-specific distribution requests. No document/image input passed to installation. **Exact resolved hosts/URLs and headers not determined**: uv performs Python install/pip resolution; invocation does not pin index URL. PyPI is identified as Orthonym's wheel source, not proof of all resolved destinations. | `apps/desktop/src-tauri/src/local_engine/install.rs:545–555`, `:606–645`, `:683–690`; environment scrubbing `:183–199`; `ocsr_engine/pins.rs:8`; `naming_engine/pins.rs:3`; `apps/desktop/src-tauri/resources/ocsr/requirements.in:10–13`, `resources/naming/requirements.in:10–12`. |
| GitHub `thomas0809/MolScribe/archive/7296a30413eb55436702011efdff78131f66d162.tar.gz` and redirects | GET for recognition source. | `apps/desktop/src-tauri/src/ocsr_engine/pins.rs:9–17`; `ocsr_engine/install.rs:159`. |
| Hugging Face `yujieq/MolScribe/resolve/a0189776b7415b82795c7ee81eed311bf5c8724b/swin_base_char_aux_1m.pth` and redirects | GET for model weights, not an image upload; final CDN hosts not determined. | `apps/desktop/src-tauri/src/ocsr_engine/pins.rs:29–34`; `ocsr_engine/install.rs:216`. |
| GitHub `SiMolecule/centres/releases/download/1.2.1/centres.jar` and redirects | GET for naming stereochemistry dependency. | `apps/desktop/src-tauri/src/naming_engine/pins.rs:13–17`; `naming_engine/install.rs:177`. |

Abbreviated Rust paths in this section share prefix `apps/desktop/src-tauri/src/`.
Shared downloader uses GET and user agent `ChemDraft-OCSR-Installer/1` or
`ChemDraft-Naming-Installer/1`; engine downloads retain reqwest's default redirect policy, not the
narrower external-tool allowlist. Evidence: `local_engine/download.rs:1–2`, `:49–81`, `:121`;
`ocsr_engine/install.rs:84`; `naming_engine/install.rs:112`.

Images and structure-naming SMILES go to local subprocesses, not the download servers
(`apps/desktop/src-tauri/src/ocsr_engine/process.rs:166–180`, `naming_engine/process.rs:105–118`;
input validation/invocation `naming_engine/mod.rs:478–516`). OPSIN uses local Java
(`apps/desktop/src-tauri/src/opsin.rs:356–409`); 3D uses a local sidecar. No remote inference/naming request
was found in those host paths. Third-party Python/package internals were not independently audited;
recognition sets HF_HUB_OFFLINE and TRANSFORMERS_OFFLINE (ocsr_engine/process.rs:174–177), and naming sets ORTHONYM_NO_DOWNLOAD (naming_engine/process.rs:116). These settings do not constitute an OS network sandbox.

## Optional assistant / external tools

| Recipient / connection | What is sent | Trigger and evidence |
| --- | --- | --- |
| `downloads.claude.ai/claude-code-releases/2.1.308/{darwin-arm64,darwin-x64,win32-x64}/{claude,claude.exe}` | GET for platform executable, user agent `ChemDraft external-tools`; no prompt/document in download. | User-approved install/update. `apps/desktop/src-tauri/src/external_tools/pins.rs:39–61`; `external_tools/install.rs:193–226`. No redirects permitted. |
| GitHub `openai/codex/releases/download/rust-v0.163.0/codex-package-{target}.tar.gz`; targets aarch64-apple-darwin, x86_64-apple-darwin, x86_64-pc-windows-msvc; one-hop `release-assets.githubusercontent.com` redirect | GET for CLI archive and signed redirect URL, same user agent; no document body. | Explicit install/update. `apps/desktop/src-tauri/src/external_tools/pins.rs:72–94`; `external_tools/install.rs:193–226`; shared GET `local_engine/download.rs:121`. |
| Anthropic or OpenAI account/provider services through selected CLI | Sign-in/account traffic; requests can send prompts, system prompt, conversation and document/page content obtained through tools, potentially unpublished structures. | Explicit sign-in (`apps/desktop/src-tauri/src/external_tools/mod.rs:739–765`); runs require stored per-plugin/tool consent (`:919–948`), also enforced in `apps/desktop/src/externalTools/ExternalToolsController.ts:62–71`. Disclosure `apps/desktop/src/externalTools/toolInstallSnapshot.ts:10–22`; CLI input `external_tools/catalog.rs:278–325`, `:355–406`; prompt staging `external_tools/mod.rs:990–1031`. **Exact vendor endpoints, auth payloads, headers and retention not determined** from third-party executables. |
| Assistant web search / web pages | Search terms, URLs and request-selected content can reach provider services and external websites. | Can happen during a consented request without per-site confirmation. CLI templates allow web access without a finite domain allowlist: `apps/desktop/src-tauri/src/external_tools/catalog.rs:292–300`, `:355`. Exact destinations depend on the request and are not determined in advance. |
| Local HTTP `127.0.0.1:{ephemeral port}/mcp/{session id}` | Tool calls/results including document summaries, text, structures and page renders; results can enter the provider conversation. Bearer token protects session. | Assistant-session loopback server, not an internet listener. `apps/desktop/src-tauri/src/assistant_mcp/session.rs:147–152`, `:232`; request handling `assistant_mcp/server.rs:316–399`; summary contents `apps/desktop/src/assistant/documentSummary.ts:23–74`. |

Abbreviated Rust paths again share prefix `apps/desktop/src-tauri/src/`.
Host sets `DISABLE_AUTOUPDATER`, `DISABLE_ERROR_REPORTING`, `DISABLE_TELEMETRY` and, for managed
copies, `DISABLE_UPDATES` (`external_tools/env.rs:65–78`). This is configuration intent, not proof
every vendor honors it. Status probes invoke vendor version/auth-status commands
(`external_tools/catalog.rs:118–130`); whether these themselves contact a server or cause background
traffic was not determined. Do not promise all tool traffic requires a fresh Send/consent dialog.
Stored consent is reused and revocable. Proxy/certificate settings can be inherited
(`external_tools/env.rs:89–105`).

## Other traffic and exclusions

- Bug/crash reports open an email draft to `jgassens@gmail.com`; users review/send through their
  own mail client/provider. Draft includes version, build, platform, optional browser engine/error
  details; users can attach files. Panic notes remain local until chosen for a report. No separate
  analytics/crash-upload client was found in inspected app source.
  `apps/desktop/src/problemReports.ts:13`, `:70–109`;
  `apps/desktop/src-tauri/src/problem_reports.rs:1–5`, `:37–78`.
- RDKit and IsoSpec fetch bundled WASM using the local asset protocol, not a CDN:
  `apps/desktop/src/rdkitWasmLoader.ts:13–14`, `:33–49`;
  `apps/desktop/src/isospecWasmLoader.ts:15–16`, `:28–40`.
- Development uses local Vite `http://127.0.0.1:5173`
  (`apps/desktop/src-tauri/tauri.conf.json:9`), outside the packaged-app policy.
- Website traffic is separate: home page font preconnections/stylesheets contact `use.typekit.net`
  and `p.typekit.net` (`site/index.html:40–42`). Draft pages copy these resources for the same look,
  but omit the home page's `app.js` (`:44`). Site-host/font-service logging, cookies and retention
  are not established by this desktop audit.
- OS services (such as certificate validation), updater/CLI/package internals and external plugin
  release contents were not exhaustively traced. Neither macOS nor Windows runtime traffic was
  verified. Owner review should resolve or retain these qualifications before publication and
  repeat the audit as dependencies change. A “never transfers information” claim is unsupported.
