import {
  applyPatch,
  createEmptyDocument,
  type MoleculeObject,
  type TextObject,
  type UnknownCompatibilityObject
} from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { exportDocumentToSvg } from "./svg";

const timestamp = "2026-05-29T00:00:00.000Z";

function nativeBondMolecule(): MoleculeObject {
  return {
    id: "mol_svg_hardened",
    type: "molecule",
    x: 100,
    y: 120,
    width: 90,
    height: 40,
    rotation: 0,
    style: { source: "chemdraft-native-drawing" },
    structureFormat: "smiles",
    structure: "CO",
    atoms: [
      { id: "atom_001", element: "C", x: 120, y: 140, formalCharge: 0 },
      { id: "atom_002", element: "O", x: 160, y: 140, formalCharge: 0 }
    ],
    bonds: [{ id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" }],
    chemistry: {
      atomCount: 2,
      bondCount: 1,
      totalCharge: 0,
      radicalCount: 0,
      isotopeLabels: [],
      stereochemistry: [],
      warnings: []
    },
    superatoms: [],
    rGroups: []
  };
}

describe("SVG export serialization", () => {
  it("exports a blank page as a stable white page without workspace guides", () => {
    const document = createEmptyDocument({ title: "Blank SVG", now: timestamp });
    const result = exportDocumentToSvg(document);

    expect(result.format).toBe("svg");
    expect(result.warnings).toEqual([]);
    expect(result.contents).toContain('<svg xmlns="http://www.w3.org/2000/svg"');
    expect(result.contents).toContain('width="8.5in" height="11in"');
    expect(result.contents).toContain('viewBox="0 0 816 1056"');
    expect(result.contents).toContain('<rect width="816" height="1056" fill="#ffffff" />');
    expect(result.contents).not.toContain('data-chemdraft-page-guide="margin"');
    expect(result.contents).not.toContain('stroke="#9fc9bd"');
    expect(result.contents).not.toContain("data-object-id=");
  });

  it("can include page guide geometry when explicitly requested", () => {
    const document = createEmptyDocument({ title: "Guide SVG", now: timestamp });
    const result = exportDocumentToSvg(document, { includePageGuides: true });

    expect(result.contents).toContain('data-chemdraft-page-guide="margin"');
    expect(result.contents).toContain('x="72" y="72" width="672" height="912"');
    expect(result.contents).toContain('stroke="#9fc9bd"');
  });

  it("escapes document titles, text content, and object metadata for XML safety", () => {
    const textObject = {
      id: "text_escape_001",
      type: "text",
      x: 100,
      y: 120,
      width: 260,
      height: 40,
      rotation: 0,
      style: {},
      text: "MeOH & <base> \"quote\" 'prime'",
      spans: []
    } satisfies TextObject;
    const document = applyPatch(
      createEmptyDocument({ title: "A&B <svg> \"quote\" 'prime'", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: textObject },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('aria-label="A&amp;B &lt;svg&gt; &quot;quote&quot; &apos;prime&apos;"');
    expect(result.contents).toContain('data-object-id="text_escape_001"');
    expect(result.contents).toContain("MeOH &amp; &lt;base&gt; &quot;quote&quot; &apos;prime&apos;");
    expect(result.contents).not.toContain("MeOH & <base>");
  });

  it("omits interactive hit-target fragments while keeping visible molecule geometry", () => {
    const document = applyPatch(
      createEmptyDocument({ title: "No Hit Targets", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: nativeBondMolecule() },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document);

    expect(result.contents).toContain('data-object-id="mol_svg_hardened"');
    expect(result.contents.match(/data-bond-id="bond_001"/g) ?? []).toHaveLength(1);
    expect(result.contents).toContain('data-atom-label="OH"');
    expect(result.contents).not.toContain("native-bond-hit-target");
    expect(result.contents).not.toContain("native-bond-hover-decorator");
    expect(result.contents).not.toContain("native-atom-hit-target");
    expect(result.contents).not.toContain("native-crossing-hit-target");
  });

  it("returns fallback warnings and can embed warning metadata on request", () => {
    const unknownObject = {
      id: "unknown_svg_001",
      type: "unknown-compatibility-object",
      x: 96,
      y: 144,
      width: 128,
      height: 48,
      rotation: 0,
      style: {},
      sourceFormat: "synthetic",
      sourceObjectType: "unsupported-shape",
      warning: "Synthetic unsupported object for SVG warning coverage."
    } satisfies UnknownCompatibilityObject;
    const document = applyPatch(
      createEmptyDocument({ title: "SVG Warning Metadata", now: timestamp }),
      { op: "addObject", pageId: "page_001", object: unknownObject },
      { now: timestamp }
    );
    const result = exportDocumentToSvg(document, { includeWarnings: true });

    expect(result.warnings).toEqual([
      {
        code: "export.svg.object_fallback",
        message: 'SVG export used a labeled fallback for object type "unknown-compatibility-object".',
        severity: "warning",
        objectId: "unknown_svg_001"
      }
    ]);
    expect(result.contents).toContain('data-object-id="unknown_svg_001"');
    expect(result.contents).toContain('data-chemdraft-warnings="');
    expect(result.contents).toContain("export.svg.object_fallback");
    expect(result.contents).toContain("&quot;objectId&quot;:&quot;unknown_svg_001&quot;");
  });
});
