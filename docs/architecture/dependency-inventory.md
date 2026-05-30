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
| `@tauri-apps/cli` | Tauri v2 CLI for launching and building the desktop shell. | Apache-2.0 OR MIT | Desktop app development dependency | Required for desktop dev/build commands; no direct frontend runtime payload. |
| `@tauri-apps/api` | Official frontend API for invoking Tauri commands and listening for palette command events. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the desktop frontend bundle for native window coordination only. |
| `tauri` | Rust runtime for the native desktop shell. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the native desktop app binary once Rust/Cargo is installed and the app is built. |
| `tauri-build` | Rust build helper for Tauri configuration/code generation. | Apache-2.0 OR MIT | Desktop app build dependency | Build-time only for the native desktop app. |
| `serde` | Rust serialization derives for narrow Tauri command/event payloads. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the native desktop app binary through Tauri command payload types. |
| `serde_json` | Parses the shared desktop toolset manifest for native menu/window generation. | Apache-2.0 OR MIT | Desktop app runtime dependency | Included in the native desktop app binary for startup menu and toolset window setup. |
