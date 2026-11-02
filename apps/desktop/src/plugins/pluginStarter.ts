import { dangerousPluginPermissions, PluginApiVersion } from "@chemdraft/plugin-api";

import authoring from "../../../../docs/plugin-architecture/AUTHORING.md?raw";
import manifest from "../../../../examples/plugins/mass-fragment-demo/src/manifest.ts?raw";
import registration from "../../../../examples/plugins/mass-fragment-demo/src/register.ts?raw";
import workerEntry from "../../../../examples/plugins/mass-fragment-demo/src/workerEntry.ts?raw";
import index from "../../../../examples/plugins/mass-fragment-demo/src/index.ts?raw";
import commandHandler from "../../../../examples/plugins/mass-fragment-demo/src/application/analyzeSelectedStructureMass.ts?raw";
import massAnalysis from "../../../../examples/plugins/mass-fragment-demo/src/massAnalysis.ts?raw";
import composeMassReport from "../../../../examples/plugins/mass-fragment-demo/src/composeMassReport.ts?raw";
import massAnalysisTest from "../../../../examples/plugins/mass-fragment-demo/src/tests/massAnalysis.test.ts?raw";
import packageJson from "../../../../examples/plugins/mass-fragment-demo/package.json?raw";
import license from "../../../../examples/plugins/mass-fragment-demo/LICENSE?raw";

export const pluginStarterAuthoringHeadings = [
  "The one rule", "Package shape", "Manifest + registration", "Command handler",
  "Direct document writes versus proposals", "Worker entry", "Distribute"
] as const;

/** Fail visibly if the source guide is reorganised; never silently omit an agent's instructions. */
export function pluginStarterAuthoringSection(heading: string, source = authoring): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex(line => line === `## ${heading}`);
  if (start < 0) throw new Error(`Plugin authoring section missing: ${heading}`);
  let end = lines.length;
  let inFence = false;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^```/.test(lines[i]!)) inFence = !inFence;
    else if (!inFence && /^#{1,6} /.test(lines[i]!)) { end = i; break; }
  }
  const body = lines.slice(start + 1, end).join("\n").trim();
  if (!body) throw new Error(`Plugin authoring section empty: ${heading}`);
  return body;
}

const exampleFiles: ReadonlyArray<readonly [string, string, string]> = [
  ["package.json", "json", packageJson],
  ["LICENSE", "text", license],
  ["src/manifest.ts", "ts", manifest],
  ["src/register.ts", "ts", registration],
  ["src/workerEntry.ts", "ts", workerEntry],
  ["src/index.ts", "ts", index],
  ["src/application/analyzeSelectedStructureMass.ts", "ts", commandHandler],
  ["src/massAnalysis.ts", "ts", massAnalysis],
  ["src/composeMassReport.ts", "ts", composeMassReport],
  ["src/tests/massAnalysis.test.ts", "ts", massAnalysisTest]
];

export function buildPluginStarterMarkdown({ appVersion }: { appVersion: string }): string {
  const rules = pluginStarterAuthoringHeadings
    .map(heading => `## ${heading}\n\n${pluginStarterAuthoringSection(heading)}`).join("\n\n");
  const example = exampleFiles.map(([path, language, source]) =>
    `## ${path}\n\n\`\`\`${language}\n${source.replace(/\r\n?/g, "\n").trimEnd()}\n\`\`\``).join("\n\n");

  return `# To you

This is a plugin-building brief for ChemDraft ${appVersion}. Hand this file to Codex, Claude Code or any coding agent. Replace the goal line below with what you want. When the agent is done, install the .zip it made using the steps at the end.

A plugin you build runs on your computer with the permissions it declares, so only install plugins that you or your agent wrote and that you trust.

# Brief for the agent

Describe your plugin here

Build a working plugin for the installed ChemDraft ${appVersion}, test it, and deliver its installable .zip and .zip.sha256. Keep the plugin small and use the fewest permissions. Preserve chemical meaning; warn or fail when an operation cannot preserve it. Do not modify ChemDraft's core to implement the plugin.

# Rules

The installed host's PluginApiVersion is ${PluginApiVersion}. Set your new manifest's apiVersion to "^${PluginApiVersion}". Required manifest fields: id, name, version, apiVersion, entry, permissions. The source excerpts and example below retain their original version declarations; use the current declaration above for your new plugin.

Declare the fewest permissions. The SDK's dangerous permissions are: ${dangerousPluginPermissions.map(permission => `\`${permission}\``).join(", ")}. A declared permission is not an unrestricted capability: use only the permission-gated host APIs available in the command context.

Documents change only through patches during your plugin's own command. Each applyPatch call (including a batch) is one labelled undo entry. Change or remove only objects selected when the command started, plus objects that command inserted; leave changed objects selected. Assistant requests group writes into one undo entry. The authoring contract follows.

${rules}

# Minimal working example

These are the actual mass-fragment-demo sources shipped with this build, including every runtime module, a test and the MIT license. Model your plugin on them; choose a new package name, manifest id and contribution ids. Runtime imports must obey the SDK-only rule. Test-only host helpers are not runtime imports. For additional API signatures consult packages/plugin-api/src/index.ts in the checkout.

${example}

# Build, test, package and install

Use Git, Node 24, and pnpm (the repository's packageManager field pins the version). Install these tools first on either platform. The SDK packages are not published to npm; the repository clone supplies the workspace packages. Do not try to fetch @chemdraft/* from npm.

The following commands run in Terminal on macOS and PowerShell on Windows. Substitute your plugin's directory name for <your-plugin> before running them.

| Step | macOS (Terminal) | Windows (PowerShell) |
| --- | --- | --- |
| Clone | \`git clone https://github.com/jgassens/ChemDraft.git\` | \`git clone https://github.com/jgassens/ChemDraft.git\` |
| Enter checkout | \`cd ChemDraft\` | \`Set-Location ChemDraft\` |
| Match installed app | \`git checkout v${appVersion}\` | \`git checkout v${appVersion}\` |
| If that checkout fails | \`git checkout main\` | \`git checkout main\` |
| Create plugin and tests | Create examples/plugins/<your-plugin> from the example, with package.json, a LICENSE file and Vitest tests | Create examples/plugins/<your-plugin> from the example, with package.json, a LICENSE file and Vitest tests |
| Install workspace dependencies from the repo root | \`pnpm install\` | \`pnpm install\` |
| Test your plugin | \`pnpm vitest run --configLoader runner examples/plugins/<your-plugin>\` | \`pnpm vitest run --configLoader runner examples/plugins/<your-plugin>\` |
| Stage plugin and lockfile | \`git add -- examples/plugins/<your-plugin> pnpm-lock.yaml\` | \`git add -- examples/plugins/<your-plugin> pnpm-lock.yaml\` |
| Commit plugin and lockfile | \`git commit -m "Add my ChemDraft plugin"\` | \`git commit -m "Add my ChemDraft plugin"\` |
| Build package | \`pnpm plugin:package -- examples/plugins/<your-plugin>\` | \`pnpm plugin:package -- examples/plugins/<your-plugin>\` |

If \`git checkout v${appVersion}\` fails (for example in a dev build or before a version is tagged), use \`git checkout main\`. Main may be newer than the installed app. Target the installed API version above and avoid capabilities that require a newer host. This file is generated offline; the app does not check whether the tag exists.

Before pnpm install, create examples/plugins/<your-plugin> modelled on examples/plugins/mass-fragment-demo, including package.json, a LICENSE file, src/index.ts, src/manifest.ts, src/register.ts, src/workerEntry.ts and the modules your worker imports. Use the workspace SDK dependency supplied by the clone. Add meaningful Vitest tests for your plugin's behavior and permission/error paths, then run the test step in the table. Test on both macOS and Windows, or report which platform remains unverified. If tests need changes, finish them before staging and committing. Stage the plugin folder and any pnpm-lock.yaml change together; commit them before packaging. plugin:package refuses uncommitted or untracked plugin files. Packaging builds the worker entry and checks the license and import boundary.

The .zip and .zip.sha256 appear in dist/plugin-packages/. Deliver both files together. Packages over 32 MB are refused by ChemDraft.

In ChemDraft choose **Plugins ▸ Add or Remove Plugins…**, then **Add plugin from package…**, and pick the .zip with its .zip.sha256 beside it. Review the declared permissions and approve installation only if you trust the plugin. Select a molecule if the plugin needs one, invoke its contributed command, and verify its output and undo behavior in the installed app on macOS and Windows.
`;
}
