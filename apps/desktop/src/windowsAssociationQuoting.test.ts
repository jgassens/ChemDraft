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

describe("Windows file association quoting", () => {
  it("wires an existing installer hook", () => {
    const hookPath = config.bundle.windows.nsis.installerHooks;
    expect(hookPath).toBe("./windows/installer-hooks.nsh");
    expect(existsSync(new URL(`../src-tauri/${hookPath.slice(2)}`, import.meta.url))).toBe(true);
  });

  it("quotes the executable and document paths for the registered class", () => {
    const hook = readFileSync(
      new URL("../src-tauri/windows/installer-hooks.nsh", import.meta.url),
      "utf8",
    );
    const className = config.bundle.fileAssociations[0]?.name;

    expect(className).toBe("ChemDraft Document");
    expect(hook).toContain(`Software\\Classes\\${className}\\shell\\open\\command`);
    expect(hook).toMatch(/\$\\"\$INSTDIR\\\$\{MAINBINARYNAME\}\.exe\$\\" \$\\"%1\$\\"/);
  });
});
