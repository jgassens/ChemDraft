import { describe, expect, it } from "vitest";
import {
  detectMolfileFormat,
  extractRxnMolfileBlocks,
  inspectClipboardPayload,
  isCdxType,
  isVectorArtworkType,
  parseMolfileGraph
} from "./index";

const cyclopropaneV2000 = [
  "ChemDraft test",
  "  ChemDraft",
  "",
  "  3  3  0  0  0  0            999 V2000",
  "    0.0000    1.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "   -0.8660   -0.5000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.8660   -0.5000    0.0000 N   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0  0  0  0",
  "  2  3  2  0  0  0  0",
  "  3  1  1  0  0  0  0",
  "M  CHG  1   3   1",
  "M  END"
].join("\n");

const etheneV3000 = [
  "ChemDraft V3000",
  "  ChemDraft",
  "",
  "  0  0  0  0  0  0            999 V3000",
  "M  V30 BEGIN CTAB",
  "M  V30 COUNTS 2 1 0 0 0",
  "M  V30 BEGIN ATOM",
  "M  V30 1 C -0.7500 0.0000 0.0000 0",
  "M  V30 2 C 0.7500 0.0000 0.0000 0 CHG=-1",
  "M  V30 END ATOM",
  "M  V30 BEGIN BOND",
  "M  V30 1 2 1 2",
  "M  V30 END BOND",
  "M  V30 END CTAB",
  "M  END"
].join("\n");

const chemdrawMacClipboardMolfile = lengthPrefixedClipboardMolfile([
  "  ChemDraw06022613552D",
  "  6  5  0  0  0  0  0  0  0  0999 V2000",
  "   -1.7862   -0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "   -1.0717    0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "   -0.3572   -0.2062    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "    0.3572    0.2062    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.0717   -0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.7862    0.2062    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0        0",
  "  2  3  1  0        0",
  "  3  4  1  0        0",
  "  4  5  1  0        0",
  "  5  6  1  0        0",
  "M  END"
]);

const chemdrawMacClipboardRxnfile = lengthPrefixedClipboardMolfile([
  "$RXN",
  "      ChemDraw 0602202615382D",
  "  1  1",
  "$MOL",
  "  ChemDraw06022615382D",
  "  2  1  0  0  0  0            999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.5600    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  1  0        0",
  "M  END",
  "$MOL",
  "  ChemDraw06022615382D",
  "  2  1  0  0  0  0            999 V2000",
  "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "    1.5600    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
  "  1  2  2  0        0",
  "M  END"
]);

describe("clipboard-adapter", () => {
  it("detects and parses V2000 molfile text", () => {
    expect(detectMolfileFormat(cyclopropaneV2000)).toBe("molfile-v2000");

    const graph = parseMolfileGraph(cyclopropaneV2000);

    expect(graph.format).toBe("molfile-v2000");
    expect(graph.atoms).toHaveLength(3);
    expect(graph.bonds).toEqual([
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "single" },
      { id: "bond_002", fromAtomId: "atom_002", toAtomId: "atom_003", order: "double" },
      { id: "bond_003", fromAtomId: "atom_003", toAtomId: "atom_001", order: "single" }
    ]);
    expect(graph.atoms[2]).toMatchObject({ element: "N", formalCharge: 1 });
  });

  it("detects and parses V3000 molfile text", () => {
    expect(detectMolfileFormat(etheneV3000)).toBe("molfile-v3000");

    const graph = parseMolfileGraph(etheneV3000);

    expect(graph.format).toBe("molfile-v3000");
    expect(graph.atoms).toHaveLength(2);
    expect(graph.atoms[1]).toMatchObject({ id: "atom_002", element: "C", formalCharge: -1 });
    expect(graph.bonds).toEqual([
      { id: "bond_001", fromAtomId: "atom_001", toAtomId: "atom_002", order: "double" }
    ]);
  });

  it("prioritizes molecule payloads before plain text", () => {
    const detected = inspectClipboardPayload({
      types: ["public.utf8-plain-text"],
      textItems: [{ type: "public.utf8-plain-text", text: cyclopropaneV2000 }]
    });

    expect(detected).toMatchObject({
      kind: "molfile",
      format: "molfile-v2000"
    });
  });

  it("decodes ChemDraw Mac length-prefixed MOL clipboard text", () => {
    expect(detectMolfileFormat(chemdrawMacClipboardMolfile)).toBe("molfile-v2000");

    const graph = parseMolfileGraph(chemdrawMacClipboardMolfile);

    expect(graph.atoms.map((atom) => atom.element)).toEqual(["C", "C", "O", "O", "C", "C"]);
    expect(graph.bonds).toHaveLength(5);
  });

  it("prefers ChemDraw Mac MOL text over PDF, CDX, and SMILES sidecar types", () => {
    const detected = inspectClipboardPayload({
      types: [
        "com.adobe.pdf",
        "com.revvity.chemdraw.cdx-clipboard",
        "com.mdli.molfile",
        "org.opensmiles.smiles"
      ],
      textItems: [
        { type: "com.mdli.molfile", text: chemdrawMacClipboardMolfile },
        { type: "org.opensmiles.smiles", text: "CCOOCC\0" }
      ]
    });

    expect(detected).toMatchObject({
      kind: "molfile",
      format: "molfile-v2000",
      sourceType: "com.mdli.molfile"
    });
    expect(detected.kind === "molfile" ? detected.text.split("\n") : []).toHaveLength(14);
  });

  it("detects ChemDraw Mac RXN wrappers before MOL and extracts embedded MOL blocks", () => {
    expect(detectMolfileFormat(chemdrawMacClipboardRxnfile)).toBeUndefined();

    const detected = inspectClipboardPayload({
      types: [
        "com.adobe.pdf",
        "com.revvity.chemdraw.cdx-clipboard",
        "com.mdli.molfile",
        "org.opensmiles.smiles"
      ],
      textItems: [
        { type: "com.mdli.molfile", text: chemdrawMacClipboardRxnfile },
        { type: "org.opensmiles.smiles", text: "CCO.CC\0" }
      ]
    });
    const blocks = extractRxnMolfileBlocks(detected.kind === "rxnfile" ? detected.text : "");

    expect(detected).toMatchObject({
      kind: "rxnfile",
      sourceType: "com.mdli.molfile"
    });
    expect(blocks).toHaveLength(2);
    expect(blocks.map((block) => block.format)).toEqual(["molfile-v2000", "molfile-v2000"]);
    expect(parseMolfileGraph(blocks[0].text).atoms.map((atom) => atom.element)).toEqual(["C", "O"]);
    expect(parseMolfileGraph(blocks[1].text).bonds[0]?.order).toBe("double");
  });

  it("classifies ordinary text as editable plain text", () => {
    const detected = inspectClipboardPayload({
      types: ["public.utf8-plain-text"],
      textItems: [{ type: "public.utf8-plain-text", text: "reaction conditions: rt, 1 h" }]
    });

    expect(detected).toMatchObject({
      kind: "plain-text",
      text: "reaction conditions: rt, 1 h"
    });
  });

  it("does not treat ambiguous plain SMILES-looking text as chemistry without a SMILES type", () => {
    const detected = inspectClipboardPayload({
      types: ["public.utf8-plain-text"],
      textItems: [{ type: "public.utf8-plain-text", text: "CCO" }]
    });

    expect(detected.kind).toBe("plain-text");
  });

  it("accepts explicit SMILES clipboard types as chemistry payloads", () => {
    const detected = inspectClipboardPayload({
      types: ["chemical/x-daylight-smiles"],
      textItems: [{ type: "chemical/x-daylight-smiles", text: "CCO" }]
    });

    expect(detected).toMatchObject({
      kind: "smiles",
      text: "CCO"
    });
  });

  it("reports CDXML and CDX as detected but not implemented", () => {
    expect(inspectClipboardPayload({
      types: ["public.utf8-plain-text"],
      textItems: [{ type: "public.utf8-plain-text", text: "<CDXML><page /></CDXML>" }]
    })).toMatchObject({
      kind: "cdxml",
      warnings: [{ code: "clipboard.cdxml_not_implemented" }]
    });

    expect(isCdxType("com.cambridgesoft.ChemDraw.CDX")).toBe(true);
    expect(inspectClipboardPayload({
      types: ["com.cambridgesoft.ChemDraw.CDX"],
      textItems: []
    })).toMatchObject({
      kind: "cdx",
      warnings: [{ code: "clipboard.cdx_not_implemented" }]
    });
  });

  it("reports vector-only pasteboards instead of pretending they are chemistry", () => {
    expect(isVectorArtworkType("public.pdf")).toBe(true);

    const detected = inspectClipboardPayload({
      types: ["public.pdf", "public.svg"],
      textItems: []
    });

    expect(detected).toMatchObject({
      kind: "vector-only",
      warnings: [{ code: "clipboard.vector_only" }]
    });
  });
});

function lengthPrefixedClipboardMolfile(lines: readonly string[]): string {
  return lines.map((line) => `\0${String.fromCharCode(line.length)}${line}`).join("");
}
