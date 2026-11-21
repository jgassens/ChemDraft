// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AboutWindow } from "./AboutWindow";
import { readFileSync } from "node:fs";
import contributors from "./contributors.json";
import testers from "./testers.json";

it("renders release metadata, sourced credits and licenses and copies the version on request", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("__ABOUT_PROVENANCE__", {
    components: [
      { name: "RDKit MinimalLib WASM", version: "Release_2026_03_3", license: "BSD-3-Clause",
        holders: ["Copyright (c) 2006-2026 Rational Discovery LLC"], purpose: "Chemistry engine", sourceUrl: "https://github.com/rdkit/rdkit" },
      { name: "example-package", version: "1.0.0", license: "MIT", holders: ["see license"],
        purpose: "Test package", sourceUrl: "https://example.com/package" }
    ],
    licenseTexts: { LICENSE: readFileSync("LICENSE", "utf8") }
  });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onCopy = vi.fn(async () => {});
  const onReady = vi.fn();
  const button = (text: string) => [...container.querySelectorAll("button")].find(element => element.textContent === text)!;
  try {
    await act(async () => root.render(<AboutWindow version="1.2.2" buildStamp="11.19.18.03-codex" onCopy={onCopy} onReady={onReady} />));
    expect(onReady).toHaveBeenCalledOnce();
    expect(container.textContent).toContain("Version 1.2.2");
    expect(container.textContent).toContain("Build 11.19.18.03-codex");
    expect(container.textContent).toContain("Free and open source under the Apache License 2.0.");
    expect(container.textContent).toContain("ChemDraft was developed with AI coding assistants.");
    for (const { name, handle, contribution, sources } of contributors) {
      expect(container.textContent).toContain(name);
      expect(container.textContent).toContain(contribution);
      if (handle) expect(container.querySelector('a[href="https://github.com/' + handle + '"]')?.textContent).toBe("@" + handle);
      expect(sources.length).toBeGreaterThan(0);
    }
    expect(container.textContent).toContain("Clemens Kaussler");
    expect(container.textContent).toContain("Ilm-NMR-P31 phosphorus NMR data");
    const tested = [...container.querySelectorAll("details")].find(element => element.textContent?.includes("Bug reports and testing"))!;
    expect(tested.querySelector("summary")?.textContent).toBe("Bug reports and testing (" + testers.handles.length + ")");
    for (const handle of testers.handles) expect(tested.querySelector('a[href="https://github.com/' + handle + '"]')?.textContent).toBe("@" + handle);
    expect(tested.querySelectorAll("li").length).toBe(testers.handles.length);
    expect(container.textContent).toContain("Open-source components and provenance");
    expect(container.textContent).toContain("RDKit MinimalLib WASM");
    expect(container.textContent).toContain("Authors and copyright holders: Copyright (c) 2006-2026 Rational Discovery LLC");
    expect(container.textContent).toContain("Authors and copyright holders: see license");
    expect(container.textContent).not.toMatch(/chemdraw|marvin(?:sketch)?|isischem|isis\/draw|chemsketch|chemwindow/i);
    await act(async () => { button("Copy Version").click(); });
    expect(onCopy).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Version copied.");
    await act(async () => { button("Read the license").click(); });
    expect(container.querySelector("pre")?.textContent).toContain("Apache License");
    await act(async () => { button("Back to About ChemDraft").click(); });
    expect(container.textContent).toContain("Version 1.2.2");
  } finally {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
