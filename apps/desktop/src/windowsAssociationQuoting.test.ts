import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = JSON.parse(readFileSync(
  new URL("../src-tauri/tauri.windows.conf.json", import.meta.url),
  "utf8",
)) as {
  bundle: {
    fileAssociations: Array<{ name: string }>;
    windows: { nsis: { installerHooks: string } };
  };
};
const hook = readFileSync(
  new URL("../src-tauri/windows/installer-hooks.nsh", import.meta.url),
  "utf8",
);

describe("Windows file association quoting", () => {
  it("wires an existing installer hook", () => {
    const hookPath = config.bundle.windows.nsis.installerHooks;
    expect(hookPath).toBe("./windows/installer-hooks.nsh");
    expect(existsSync(new URL(`../src-tauri/${hookPath.slice(2)}`, import.meta.url))).toBe(true);
  });

  it("quotes the executable and document paths for the registered class", () => {
    const className = config.bundle.fileAssociations[0]?.name;

    expect(className).toBe("ChemDraft Document");
    expect(hook).toContain(`Software\\Classes\\${className}\\shell\\open\\command`);
    expect(hook).toMatch(/\$\\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$\\" \$\\"%1\$\\"/);
  });
});

describe("Windows file association uninstall cleanup", () => {
  const pre = hook.match(/!macro NSIS_HOOK_PREUNINSTALL\s+([\s\S]*?)!macroend/)?.[1] ?? "";
  const post = hook.match(/!macro NSIS_HOOK_POSTUNINSTALL\s+([\s\S]*?)!macroend/)?.[1] ?? "";

  it("preserves the current owner and missing defaults across Tauri's backup restoration", () => {
    expect(pre).toMatch(/StrCpy \$ChemDraftAssociationHadDefault 0\s+ClearErrors\s+ReadRegStr \$ChemDraftAssociationProgId SHCTX "Software\\Classes\\\.chemdraft" ""\s+\$\{IfNot\} \$\{Errors\}\s+StrCpy \$ChemDraftAssociationHadDefault 1\s+\$\{EndIf\}/);
    expect(post).toMatch(/\$\{If\} \$ChemDraftAssociationHadDefault = 1\s+WriteRegStr SHCTX "Software\\Classes\\\.chemdraft" "" "\$ChemDraftAssociationProgId"\s+\$\{Else\}\s+DeleteRegValue SHCTX "Software\\Classes\\\.chemdraft" ""\s+\$\{EndIf\}/);
    expect(post.indexOf("WriteRegStr SHCTX")).toBeLessThan(post.indexOf("StrCmpS"));
  });

  it("restores the install scope and removes its ProgID and OpenWith value through SHCTX", () => {
    expect(post).toContain("!insertmacro SetContext");
    expect(post.indexOf("!insertmacro SetContext")).toBeLessThan(post.indexOf("SHCTX \"Software"));
    expect(post).toContain('DeleteRegKey SHCTX "Software\\Classes\\ChemDraft Document"');
    expect(post).toContain('DeleteRegValue SHCTX "Software\\Classes\\.chemdraft" "ChemDraft Document_backup"');
    expect(post).toContain('DeleteRegValue SHCTX "Software\\Classes\\.chemdraft\\OpenWithProgids" "ChemDraft Document"');
    expect(hook).not.toMatch(/^\s*(?:ReadRegStr|WriteRegStr|DeleteRegKey|DeleteRegValue)\s+.*\b(?:HKCU|HKLM|HKCR)\b/m);
    expect(post).not.toMatch(/DeleteRegKey[^\n]*OpenWithProgids/);
  });

  it("deletes the extension key only after an exact case-sensitive ProgID match", () => {
    expect(post).toMatch(/ReadRegStr \$0 SHCTX "Software\\Classes\\\.chemdraft" ""\s+(?:;[^\n]*\n\s*)?StrCmpS \$0 "ChemDraft Document" 0 \+2\s+DeleteRegKey SHCTX "Software\\Classes\\\.chemdraft"/);
    expect(post.match(/DeleteRegKey SHCTX "Software\\Classes\\\.chemdraft"/g)).toHaveLength(1);
  });

  it("notifies the shell after cleanup and never mentions other extensions", () => {
    // Tauri's FileAssociation.nsh implements UPDATEFILEASSOC with
    // SHChangeNotify(SHCNE_ASSOCCHANGED, SHCNF_FLUSH, 0, 0).
    expect(post).toMatch(/Pop \$0\s+!insertmacro UPDATEFILEASSOC\s*$/);
    expect(hook).not.toMatch(/\.cdxml/i);
    const extensions = [...hook.matchAll(/Software\\Classes\\(\.[^"\\]+)/g)].map((match) => match[1]);
    expect(new Set(extensions)).toEqual(new Set([".chemdraft"]));
  });
});
