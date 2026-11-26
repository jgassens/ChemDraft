/**
 * Bug cdxml-export-quadratic-lone-pairs, seen from the app: session autosave calls
 * createNativeSavePayload right after a file opens, and that wrote one fragment of N lone-pair
 * atoms in O(N^2) (about 30 s at 10,000), so a huge or crafted CDXML hung the app with no click.
 * The bound is generous (the fixed save takes about a second); it catches a return to quadratic cost.
 */
import { describe, expect, it } from "vitest";
import type { ElectronMarkObject, MoleculeObject } from "@chemdraft/chem-core";
import { createNativeSavePayload, openNativeDocument } from "../documentWorkflow";

function oxygenGrid(count: number): string {
  const atoms: string[] = [], pairs: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = (i % 100) * 30, y = Math.floor(i / 100) * 30;
    atoms.push(`<n id="${1000 + i}" p="${x} ${y}" Element="8"/>`);
    pairs.push(`<graphic id="${100000 + i}" GraphicType="Symbol" SymbolType="LonePair" BoundingBox="${x + 10} ${y} ${x + 13} ${y}">` +
      `<represent object="${1000 + i}" attribute="Radical"/></graphic>`);
  }
  return `<CDXML><page><fragment id="5">${atoms.join("")}</fragment>${pairs.join("")}</page></CDXML>`;
}

describe("autosave payload of a file with many lone pairs", () => {
  it("opens and builds the save payload of 10,000 lone-pair atoms in linear time, losing none", () => {
    const openStarted = performance.now();
    const opened = openNativeDocument(oxygenGrid(10000));
    const openMs = performance.now() - openStarted;
    expect(opened.document).toBeDefined();
    expect(openMs).toBeLessThan(10000);

    const started = performance.now();
    const payload = createNativeSavePayload(opened.document!);
    const saveMs = performance.now() - started;
    expect(saveMs).toBeLessThan(10000);
    expect(payload.contents.match(/SymbolType="LonePair"/g)).toHaveLength(10000);
    expect(payload.warnings.map(w => w.code)).not.toContain("cdxml.electron_mark_appearance_payload_only");

    // What autosave wrote reads back with every pair still on its own atom.
    const reopened = openNativeDocument(payload.contents).document!;
    const marks = reopened.pages[0]!.objects.filter((o): o is ElectronMarkObject => o.type === "electron-mark");
    expect(marks).toHaveLength(10000);
    expect(marks.every(m => m.markKind === "lone-pair" && m.anchor.kind === "atom")).toBe(true);
    const molecule = reopened.pages[0]!.objects.find((o): o is MoleculeObject => o.type === "molecule")!;
    expect(molecule.atoms).toHaveLength(10000);
  }, 120000);
});
