import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildAboutProvenance, readAboutSource } from "./buildProvenance";
import contributors from "./contributors.json";
import { SEE_LICENSE, licenseFileStatements, noticeStatements } from "./holders";
import testers from "./testers.json";

describe("About provenance", () => {
  const provenance = buildAboutProvenance();
  const displayed = new Set(provenance.components.map(component => component.name));

  it("covers every row of the dependency inventory and every NOTICE component entry", () => {
    const source = readAboutSource("docs/architecture/dependency-inventory.md");
    const names = [...source.matchAll(/^\| ([^|]+?) \|/gm)].map(match => match[1]!.replace(/[\x60*]/g, ""))
      .filter(name => !["Component", "Package", "---"].includes(name));
    expect([...provenance.inventoryCoverage.keys()]).toEqual(names);

    const notice = readAboutSource("NOTICE");
    // Component paragraphs start with a heading, then indent the details.
    const paragraphs = notice.split(/\n{2,}/);
    const headings = paragraphs.flatMap(paragraph => {
      if (!/^\S/.test(paragraph) || /^(?:APPENDIX A\.|A\.\d )/.test(paragraph)) return [];
      const lines = paragraph.split("\n");
      const detailStart = lines.findIndex(line => line.startsWith("  "));
      return detailStart > 0 ? [lines.slice(0, detailStart).join(" ")] : [];
    });
    // The network list, shaded JAR table, and datasets have their own heading formats.
    const beforeAppendix = notice.split("\nAPPENDIX A.")[0]!;
    const network = paragraphs.find(paragraph => paragraph.startsWith("Network transport and diagnostics"))!;
    const networkHeadings = [...network.matchAll(/^ {2}(\S+ \d[^\s:]*)/gm)].map(match => match[1]!);
    const jarHeadings = [...beforeAppendix.matchAll(/^ {4}(\S[^\n]*?) {2,}\S/gm)].map(match => match[1]!);
    const dataSection = beforeAppendix.split("\nData under separate terms\n")[1]!;
    const dataHeadings = [...dataSection.matchAll(/\n\n {2}(\S[^\n]*)/g)].map(match => match[1]!);
    expect([...provenance.noticeCoverage.keys()]).toEqual([
      ...headings, ...networkHeadings, ...jarHeadings, ...dataHeadings
    ]);
    for (const disposition of provenance.inventoryCoverage.values()) {
      expect(displayed.has(disposition) ||
        ["Development or build tooling", "Distributed separately", "Linkage remains unconfirmed"].includes(disposition)).toBe(true);
    }
    for (const disposition of provenance.noticeCoverage.values()) {
      expect(displayed.has(disposition) ||
        ["Group heading", "Downloaded separately", "Unused by the shipped model"].includes(disposition)).toBe(true);
    }

    expect(provenance.noticeCoverage.get("Apache Commons CLI (1.11.0)")).toBe("Apache Commons CLI (1.11.0)");
    expect(provenance.npmCoverage.has("@tanstack/react-hotkeys")).toBe(true);
    expect(provenance.npmCoverage.has("svg2pdf.js")).toBe(true);
    expect(displayed.has("nmrshiftdb2-derived reference database")).toBe(false);
  });

  it("resolves build metadata, legal caveats, and local license texts", () => {
    expect(provenance.components).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "Octet Draw", license: expect.stringContaining("Sam Ellis") }),
      expect.objectContaining({ name: "RDKit MinimalLib WASM (vendored)", version: "Release_2026_03_3" }),
      expect.objectContaining({ name: "IsoSpec WASM (vendored)", version: "2.3.5" }),
      expect.objectContaining({ name: "indigo-ketcher", version: "1.40.0" }),
      expect.objectContaining({ name: "OPSIN (vendored JAR + bundled JRE)", version: "2.9.0" }),
      expect.objectContaining({ name: "InChI (inside the RDKit MinimalLib WASM)", version: "1.07.3", license: expect.stringContaining("unconfirmed") }),
      expect.objectContaining({ name: "avogadrolibs (Avogadro Core + Calc)", version: "416651ddaef33a4e20392392e7c0b505d446491b" })
    ]));
    for (const component of provenance.components) {
      expect(component.purpose).toBeTruthy();
      expect(new URL(component.sourceUrl).protocol).toBe("https:");
      if (component.licenseText) expect(provenance.licenseTexts[component.licenseText]).toBeTruthy();
    }
    expect(provenance.components.map(c => [c.name, c.purpose].join(" ")).join("\n"))
      .not.toMatch(/chemdraw|marvin(?:sketch)?|isischem|isis\/draw|chemsketch|chemwindow/i);
    expect(provenance.licenseTexts.LICENSE).toBe(readAboutSource("LICENSE"));
    expect(provenance.licenseTexts["packages/export-engine/src/fonts/LICENSE_PATRICK_HAND.txt"]).toBeTruthy();
  });

  it("gives every shipped package a holder from its own records, or says to see the license", () => {
    for (const component of provenance.components) {
      expect(component.holders.length, component.name).toBeGreaterThan(0);
      for (const holder of component.holders) expect(holder.trim(), component.name).not.toBe("");
      if (component.holders.includes(SEE_LICENSE)) expect(component.holders, component.name).toEqual([SEE_LICENSE]);
      else for (const holder of component.holders) expect(holder, component.name).not.toMatch(/[<>[\]{}]|yyyy/i);
    }
    const holders = (name: string) => provenance.components.find(component => component.name === name)?.holders.join(" ");
    expect(holders("Octet Draw")).toContain("Sam Ellis");
    expect(holders("RDKit MinimalLib WASM (vendored)")).toContain("Rational Discovery LLC");
    expect(holders("IsoSpec WASM (vendored)")).toContain("Michal Startek");
    expect(holders("OPSIN (vendored JAR + bundled JRE)")).toContain("Daniel Lowe");
    expect(holders("Woodstox (7.1.1)")).toContain("FasterXML");
    expect(holders("Apache Commons IO (2.21.0)")).toContain("The Apache Software Foundation");
    expect(holders("@tanstack/react-hotkeys")).toBe("Copyright (c) 2026 Tanner Linsley");
    // Never invented: a holder is absent where no record names one.
    expect(holders("Eigen 3.4.0")).toBe(SEE_LICENSE);
    if (existsSync(new URL("../../../../node_modules/.pnpm/", import.meta.url))) {
      expect(holders("react")).toMatch(/Meta Platforms/);
      expect(holders("zod")).toMatch(/Colin McDonnell/);
    }
  });

  it("reads holders only from copyright statements, never from license prose or templates", () => {
    expect(licenseFileStatements([
      "MIT License", "", "Copyright (c) 2019 Example Author <a@example.com>", "Copyright [yyyy] [name of copyright owner]",
      "(c) You must retain, in the Source form of any Derivative Works", "Copyright (c) <year> <copyright holders>",
      "The above copyright notice and this permission notice shall be included"
    ].join("\n"))).toEqual(["Copyright (c) 2019 Example Author"]);
    expect(licenseFileStatements("Copyright (c) Meta Platforms, Inc. and affiliates.\nPermission is hereby granted"))
      .toEqual(["Copyright (c) Meta Platforms, Inc. and affiliates"]);
    expect(noticeStatements("Copyright (c) 2003 Bitstream, Inc.; Copyright (c) 2006 Tavmjong Bah."))
      .toEqual(["Copyright (c) 2003 Bitstream, Inc.", "Copyright (c) 2006 Tavmjong Bah"]);
    expect(noticeStatements("Unmodified crates. Copyright notices, source repositories and licence texts: docs/x.txt")).toEqual([]);
    expect(noticeStatements("Apache-2.0, (c) 1999-2025 The Apache\n  Software Foundation (text: Appendix A.1)"))
      .toEqual(["(c) 1999-2025 The Apache Software Foundation"]);
  });

  it("credits each person and each tester once, and credits Clemens Kaussler", () => {
    const names = contributors.map(person => person.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
    const contributorHandles = contributors.flatMap(person => "handle" in person && person.handle ? [person.handle.toLowerCase()] : []);
    expect(new Set(contributorHandles).size).toBe(contributorHandles.length);
    const clemens = contributors.find(person => person.name === "Clemens Kaussler")!;
    expect(clemens.contribution).toBe("Detailed drawing and NMR bug reports and testing, and the Ilm-NMR-P31 phosphorus NMR data.");
    expect(clemens.sources).toEqual(["owner email, 2026-11-18"]);

    const handles = testers.handles.map(handle => handle.toLowerCase());
    expect(handles.length).toBeGreaterThan(0);
    expect(new Set(handles).size).toBe(handles.length);
    for (const handle of handles) {
      expect(handle).toMatch(/^[a-z\d](?:[a-z\d-]*[a-z\d])?$/);
      expect(handle).not.toMatch(/bot$/);
      expect(contributorHandles).not.toContain(handle);
      expect(handle).not.toBe("jgassens");
    }
    expect(testers.note).toBeTruthy();
    expect(testers.method).toBeTruthy();
  });
});
