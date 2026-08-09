import { describe, expect, it } from "vitest";
import {
  detectMolfileFormat,
  extractRxnMolfileBlocks,
  inspectClipboardPayload,
  isCdxType,
  isVectorArtworkType,
  looksLikeInchi,
  looksLikeSmiles,
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

  it("preserves V2000 wedge/hash bond stereo as bondStyle", () => {
    const wedgeHashV2000 = [
      "ChemDraft stereo",
      "  ChemDraft",
      "",
      "  4  3  0  0  1  0            999 V2000",
      "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
      "    1.0000    0.0000    0.0000 F   0  0  0  0  0  0  0  0  0  0  0  0",
      "   -0.5000    0.8660    0.0000 Cl  0  0  0  0  0  0  0  0  0  0  0  0",
      "   -0.5000   -0.8660    0.0000 Br  0  0  0  0  0  0  0  0  0  0  0  0",
      "  1  2  1  1  0  0  0",
      "  1  3  1  6  0  0  0",
      "  1  4  1  0  0  0  0",
      "M  END"
    ].join("\n");

    const graph = parseMolfileGraph(wedgeHashV2000);

    expect(graph.bonds[0]).toMatchObject({ order: "single", bondStyle: "wedge" });
    expect(graph.bonds[1]).toMatchObject({ order: "single", bondStyle: "hashed" });
    expect(graph.bonds[2].bondStyle).toBeUndefined();
  });

  it("treats atom-block charges as zero once any M CHG line is present (V2000 spec)", () => {
    // Atom 1 carries a legacy atom-block charge (code 3 = +1); atom 2 is named in M CHG.
    // Per spec the presence of any M CHG line voids ALL atom-block charges, so atom 1 must
    // import as neutral rather than a phantom +1.
    const lines = [
      "ChemDraft charge",
      "  ChemDraft",
      "",
      "  2  1  0  0  0  0            999 V2000",
      "    0.0000    0.0000    0.0000 N   0  3  0  0  0  0  0  0  0  0  0  0",
      "    1.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
      "  1  2  1  0  0  0  0"
    ];
    // Without an M CHG line, the atom-block charge IS honored (+1 on atom 1).
    const withoutChg = parseMolfileGraph([...lines, "M  END"].join("\n"));
    expect(withoutChg.atoms[0].formalCharge).toBe(1);

    // With an M CHG line (atom 2 only), atom 1's atom-block charge is discarded.
    const withChg = parseMolfileGraph([...lines, "M  CHG  1   2  -1", "M  END"].join("\n"));
    expect(withChg.atoms[0].formalCharge).toBe(0);
    expect(withChg.atoms[1].formalCharge).toBe(-1);
  });

  it("parses V2000 columns even when coordinates abut (≥100 magnitude)", () => {
    // Two coordinates at magnitude ≥100 fill their 10-char columns with no separator
    // ("-123.4567-123.4567"); a whitespace split would read them as one token.
    const abutting = [
      "ChemDraft wide",
      "  ChemDraft",
      "",
      "  2  1  0  0  0  0            999 V2000",
      " -123.4567 -123.4567    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
      " -123.4567  123.4567    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
      "  1  2  1  0  0  0  0",
      "M  END"
    ].join("\n");

    const graph = parseMolfileGraph(abutting);

    expect(graph.atoms[0]).toMatchObject({ x: -123.4567, y: -123.4567, element: "C" });
    expect(graph.atoms[1]).toMatchObject({ x: -123.4567, y: 123.4567, element: "O" });
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

  it("classifies plain-text InChI as an inchi payload (not yet importable)", () => {
    const detected = inspectClipboardPayload({
      types: ["public.utf8-plain-text"],
      textItems: [{ type: "public.utf8-plain-text", text: "InChI=1S/C2H6O/c1-2-3/h3H,2H2,1H3" }]
    });

    expect(detected).toMatchObject({ kind: "inchi", text: "InChI=1S/C2H6O/c1-2-3/h3H,2H2,1H3" });
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

describe("looksLikeInchi", () => {
  it("matches standard and non-standard InChI prefixes", () => {
    expect(looksLikeInchi("InChI=1S/CH4/h1H4")).toBe(true);
    expect(looksLikeInchi("  InChI=1/C2H6O/c1-2-3/h3H,2H2,1H3")).toBe(true);
  });
  it("rejects SMILES and prose", () => {
    expect(looksLikeInchi("C[C@H](F)Cl")).toBe(false);
    expect(looksLikeInchi("the inchi is below")).toBe(false);
  });
});

describe("looksLikeSmiles (pre-filter only — never asserts validity)", () => {
  it("accepts whitespace-free chemical-charset tokens", () => {
    expect(looksLikeSmiles("CCO")).toBe(true);
    expect(looksLikeSmiles("C[C@H](F)Cl")).toBe(true);
    expect(looksLikeSmiles("c1ccccc1")).toBe(true);
  });
  it("rejects prose, single characters, InChI, and empty input", () => {
    expect(looksLikeSmiles("reaction conditions: rt, 1 h")).toBe(false); // has spaces
    expect(looksLikeSmiles("C")).toBe(false); // too short
    expect(looksLikeSmiles("InChI=1S/CH4/h1H4")).toBe(false);
    expect(looksLikeSmiles("123")).toBe(false); // no element letter
  });
});

describe("V3000 line continuations", () => {
  it("joins a wrapped line instead of dropping everything after the wrap", () => {
    // V3000 wraps long lines: the line ends with "-" and the rest follows on the next "M  V30 "
    // line. Splitting on newlines without rejoining silently dropped the tail — here a formal
    // charge that happened to fall past the wrap, so the anion pasted as a neutral atom.
    const wrapped = [
      "ChemDraft V3000",
      "  ChemDraft",
      "",
      "  0  0  0  0  0  0            999 V3000",
      "M  V30 BEGIN CTAB",
      "M  V30 COUNTS 2 1 0 0 0",
      "M  V30 BEGIN ATOM",
      "M  V30 1 C -0.7500 0.0000 0.0000 0",
      // The wrap falls between tokens, which is where a conforming writer puts it: the trailing
      // "-" is purely the continuation marker, and the charge follows intact on the next line.
      "M  V30 2 O 0.7500 0.0000 0.0000 0 -",
      "M  V30 CHG=-1",
      "M  V30 END ATOM",
      "M  V30 BEGIN BOND",
      "M  V30 1 1 1 2",
      "M  V30 END BOND",
      "M  V30 END CTAB",
      "M  END"
    ].join("\n");

    const parsed = parseMolfileGraph(wrapped);

    expect(parsed.atoms).toHaveLength(2);
    expect(parsed.atoms[1]).toMatchObject({ element: "O", formalCharge: -1 });
    expect(parsed.bonds).toHaveLength(1);
  });

  it("still parses an unwrapped file identically", () => {
    const parsed = parseMolfileGraph(etheneV3000);
    expect(parsed.atoms).toHaveLength(2);
    expect(parsed.atoms[1]).toMatchObject({ element: "C", formalCharge: -1 });
    expect(parsed.bonds).toHaveLength(1);
  });
});

describe("molfile detection is structural, not keyword-matching", () => {
  it("does not classify ordinary prose that happens to contain V3000 or V2000", () => {
    // A bare version keyword is not evidence of a molfile. Classifying prose as one sent it to a
    // parser that throws, and the exception escaped the whole paste handler — so pasting a line of
    // text into the canvas did nothing at all, with no message.
    expect(detectMolfileFormat("Bruker V3000 spectrometer manual")).toBeUndefined();
    expect(detectMolfileFormat("see appendix V2000 for the calibration table")).toBeUndefined();
    expect(detectMolfileFormat("Exported from V3000-series software on Tuesday")).toBeUndefined();
  });

  it("still recognises real molfiles", () => {
    expect(detectMolfileFormat(etheneV3000)).toBe("molfile-v3000");
    expect(detectMolfileFormat(cyclopropaneV2000)).toBe("molfile-v2000");
  });
});

function lengthPrefixedClipboardMolfile(lines: readonly string[]): string {
  return lines.map((line) => `\0${String.fromCharCode(line.length)}${line}`).join("");
}
