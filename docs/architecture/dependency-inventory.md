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
| `zod` | Runtime schema validation for the native ChemDraft document model and plugin manifests/result envelopes. | MIT | Core runtime dependency | Included with code that validates native documents and plugin API inputs. |
