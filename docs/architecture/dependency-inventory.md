# Dependency Inventory

This file records dependencies added during the repository foundation and early implementation milestones.

| Package | Purpose | License | Core or optional | Distribution impact |
| --- | --- | --- | --- | --- |
| `typescript` | Type checking for all workspace TypeScript code. | Apache-2.0 | Core development dependency | No runtime distribution impact. |
| `vitest` | Unit test runner for package skeleton tests. | MIT | Core development dependency | No runtime distribution impact. |
| `vite` | Development server and production build for the desktop shell frontend. | MIT | Desktop app development dependency | Bundles frontend assets only. |
| `@vitejs/plugin-react` | React transform support for Vite. | MIT | Desktop app development dependency | Build-time only. |
| `react` | UI library for the desktop shell. | MIT | Desktop app runtime dependency | Included in the desktop frontend bundle. |
| `react-dom` | React DOM renderer for the desktop shell. | MIT | Desktop app runtime dependency | Included in the desktop frontend bundle. |
| `@types/react` | TypeScript types for React. | MIT | Desktop app development dependency | No runtime distribution impact. |
| `@types/react-dom` | TypeScript types for React DOM. | MIT | Desktop app development dependency | No runtime distribution impact. |
| `zod` | Runtime schema validation for the native ChemDraft document model, plugin manifests/result envelopes, and toolset manifests. | MIT | Core runtime dependency | Included with code that validates native documents, plugin API inputs, and toolbar/toolset definitions. |
| `@scena/react-ruler` | React wrapper for Daybrush/Scena ruler rendering in the desktop document viewport. ChemDraft keeps viewport state and measurement math in `@chemdraft/viewport-engine`; this dependency only paints ruler canvases. | MIT | Desktop app runtime dependency | Included in the desktop frontend bundle for optional View > Show Rulers rendering. No chemistry or document model impact. |
| `@tauri-apps/cli` | Tauri v2 CLI for launching and building the desktop shell. | Apache-2.0 OR MIT | Desktop app development dependency | Required for desktop dev/build commands; no direct frontend runtime payload. |
| `@tauri-apps/api` | Official frontend API for invoking Tauri commands and listening for palette command events. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the desktop frontend bundle for native window coordination only. |
| `ketcher-react` | React host component for the Ketcher molecule editor. Used only by the narrow active molecule editor host, not as the ChemDraft document/page model. | Apache-2.0 | Desktop app runtime dependency | Lazy-loaded into the desktop frontend bundle for selected molecule editing. Peer dependency warning observed through `miew-react` with React 19; keep under review. |
| `ketcher-standalone` | Standalone Indigo-backed structure service provider for Ketcher molecule editing without a remote service. | Apache-2.0 | Desktop app runtime dependency | Included for local Ketcher molecule editing. Brings Indigo/Ketcher runtime payload into the desktop frontend bundle; does not change `chem-core` document state ownership. |
| `raphael` | Explicit dependency used to satisfy Ketcher's browser-time dynamic Raphael request in the narrow desktop Ketcher host. | MIT | Desktop app runtime dependency | Included only for the selected-molecule Ketcher editor host; does not own ChemDraft document state or page rendering. |
| `tauri` | Rust runtime for the native desktop shell. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the native desktop app binary once Rust/Cargo is installed and the app is built. |
| `tauri-build` | Rust build helper for Tauri configuration/code generation. | Apache-2.0 OR MIT | Desktop app build dependency | Build-time only for the native desktop app. |
| `objc2-app-kit` | Narrow macOS AppKit bridge for utility-palette window behavior that Tauri does not expose directly. | Zlib OR Apache-2.0 OR MIT | Desktop app runtime dependency | macOS-only native binary dependency for floating toolset window level, deactivation hiding, and utility-window behavior. |
| `serde` | Rust serialization derives for narrow Tauri command/event payloads. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the native desktop app binary through Tauri command payload types. |
| `serde_json` | Parses the shared desktop toolset manifest for native menu/window generation. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the native desktop app binary for startup menu and toolset window setup. |
