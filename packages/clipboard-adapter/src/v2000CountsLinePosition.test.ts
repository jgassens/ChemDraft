import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureRdkit, resetRdkitForTesting } from "../../rdkit-adapter/src/conformer";
import { installRealRdkitModuleLoader } from "../../rdkit-adapter/src/testing";
import { detectMolfileFormat, extractRxnMolfileBlocks, parseMolfileGraph, type ParsedMolfileGraph } from "./index";

// Failing tests for the clipboard MOL/RXN counts-line reader (findV2000CountsLineIndex takes the
// FIRST counts-shaped line anywhere in the text; parseV2000CountsLine reads columns 1-6 first).
// The V2000 counts line is always line 4: lines 1-3 are the header (title, program, comment)
// and are never structure. Its atom and bond counts are fixed columns aaa (1-3) and bbb (4-6).
// Every fixture is hand-written; nothing here uses the production writer.

const atomLine = (x: number, y: number, symbol: string) =>
  `${x.toFixed(4).padStart(10)}${y.toFixed(4).padStart(10)}    0.0000 ${symbol.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`;
const bondLine = (from: number, to: number, order = 1) =>
  `${String(from).padStart(3)}${String(to).padStart(3)}${String(order).padStart(3)}  0  0  0  0`;

/** A ring of `size` carbons: `size` atom lines and `size` bond lines. */
function carbonRing(size: number): { atoms: string[]; bonds: string[] } {
  const atoms = Array.from({ length: size }, (_, index) =>
    atomLine(Math.cos((2 * Math.PI * index) / size) * size * 0.25, Math.sin((2 * Math.PI * index) / size) * size * 0.25, "C"));
  const bonds = Array.from({ length: size }, (_, index) => bondLine(index + 1, index === size - 1 ? 1 : index + 2));
  return { atoms, bonds };
}

const methanol = { atoms: [atomLine(0, 0, "C"), atomLine(1.5, 0, "O")], bonds: [bondLine(1, 2)] };

function expectGraph(graph: ParsedMolfileGraph, elements: readonly string[], bondCount: number): void {
  expect(graph.atoms.map((atom) => atom.element)).toEqual(elements);
  expect(graph.bonds).toHaveLength(bondCount);
  const ids = new Set(graph.atoms.map((atom) => atom.id));
  for (const bond of graph.bonds) {
    expect(ids.has(bond.fromAtomId)).toBe(true);
    expect(ids.has(bond.toAtomId)).toBe(true);
  }
  expect(graph.warnings).toEqual([]);
}

// Comment lines shaped like a zero-count counts line: one with the V2000 tag, one with six fields.
const zeroCountComments = [
  "  0  0  0  0  0  0  0  0  0  0999 V2000",
  "  0  0  0  0  0  0"
] as const;

describe("(a) a counts-shaped header comment is never the counts line", () => {
  it.each(zeroCountComments)("MOL paste reads past comment line %j", (comment) => {
    const molfile = ["methanol", "  Other", comment, "  2  1  0  0  0  0  0  0  0  0999 V2000",
      ...methanol.atoms, ...methanol.bonds, "M  END"].join("\n");
    expect(detectMolfileFormat(molfile)).toBe("molfile-v2000");
    // Before the fix: 0 atoms / 0 bonds with only a "no atoms" warning; the structure is lost.
    expectGraph(parseMolfileGraph(molfile), ["C", "O"], 1);
  });

  it.each(zeroCountComments)("RXN paste reads past comment line %j in a $MOL block", (comment) => {
    const rxnfile = ["$RXN", "methanol to methanol", "  Other", "", "  1  1",
      "$MOL", "methanol", "  Other", comment, "  2  1  0  0  0  0  0  0  0  0999 V2000", ...methanol.atoms, ...methanol.bonds, "M  END",
      "$MOL", "methanol", "  Other", "", "  2  1  0  0  0  0  0  0  0  0999 V2000", ...methanol.atoms, ...methanol.bonds, "M  END"
    ].join("\n");
    const blocks = extractRxnMolfileBlocks(rxnfile);
    expect(blocks.map((block) => block.format)).toEqual(["molfile-v2000", "molfile-v2000"]);
    for (const block of blocks) expectGraph(parseMolfileGraph(block.text), ["C", "O"], 1);
  });
});

describe("(b) counts of 100 atoms and 100 bonds", () => {
  const ring = carbonRing(100);
  const ringElements = Array.from({ length: 100 }, () => "C");
  const withCounts = (counts: string) => ["macrocycle", "  Other", "", counts, ...ring.atoms, ...ring.bonds, "M  END"].join("\n");

  it("reads the standard fixed-column counts '100100' as 100 atoms and 100 bonds (control)", () => {
    expectGraph(parseMolfileGraph(withCounts("100100  0  0  0  0  0  0  0  0999 V2000")), ringElements, 100);
  });

  // By columns, "100 100" is aaa="100", bbb=" 10": 100 atoms and 10 bonds, which the 90 further
  // bond lines contradict. RDKit (MinimalLib) refuses each of these files. ChemDraft must read
  // the 100 bonds that are there; never keep 10 bonds and drop the other 90.
  it.each([
    "100 100  0  0  0  0",
    "100 100  0  0  0  0  0  0  0  0999 V2000",
    "100 100 V2000",
    "100 100"
  ])("never silently reads unpadded counts %j as anything but 100/100", (counts) => {
    expectGraph(parseMolfileGraph(withCounts(counts)), ringElements, 100);
  });

  it("refuses unpadded '100 100' with an error naming the counts line when neither reading fits", () => {
    // 55 bond lines: not the 10 the columns declare, nor the 100 the fields declare.
    const molfile = ["macrocycle", "  Other", "", "100 100  0  0  0  0", ...ring.atoms, ...ring.bonds.slice(0, 55), "M  END"].join("\n");
    expect(() => parseMolfileGraph(molfile)).toThrow(
      /V2000 counts line \(line 4, "100 100  0  0  0  0"\) is ambiguous: .*100 atoms and 10 bonds or 100 atoms and 100 bonds/
    );
  });
});

describe("(c) an RXN $MOL block with a blank program line never takes a bond record for its counts", () => {
  // Short counts lines (no V2000 tag, fewer than six fields) that RDKit reads by columns.
  const shortCounts = ["  6  6", "  6  6  0  0"] as const;

  it.each(shortCounts)("reads a cyclohexane block with counts %j", (counts) => {
    const ring = carbonRing(6);
    const rxnfile = ["$RXN", "", "", "", "  1  1",
      "$MOL", "cyclohexane", "", "", counts, ...ring.atoms, ...ring.bonds, "M  END",
      "$MOL", "methanol", "", "", "  2  1  0  0  0  0  0  0  0  0999 V2000", ...methanol.atoms, ...methanol.bonds, "M  END"
    ].join("\n");
    const blocks = extractRxnMolfileBlocks(rxnfile);
    expect(blocks).toHaveLength(2);
    // Before the fix the first bond record "  1  2  1  0  0  0  0" is read as 1 atom / 2 bonds,
    // and the next bond record becomes an atom with element "0".
    expectGraph(parseMolfileGraph(blocks[0]!.text), ["C", "C", "C", "C", "C", "C"], 6);
    expectGraph(parseMolfileGraph(blocks[1]!.text), ["C", "O"], 1);
  });
});

describe("headerless V2000 connection tables", () => {
  it("reads the two-atom CTAB whose first bond is on line 4", () => {
    const molfile = ["  2  1  0  0  0  0  0  0  0  0999 V2000",
      "    0.0000    0.0000    0.0000 C   0  0  0  0  0  0  0  0  0  0  0  0",
      "    1.0000    0.0000    0.0000 O   0  0  0  0  0  0  0  0  0  0  0  0",
      "  1  2  1  0  0  0  0", "M  END"].join("\n");
    expectGraph(parseMolfileGraph(molfile), ["C", "O"], 1);
  });

  it("reads a one-atom CTAB", () => {
    const molfile = ["  1  0  0  0  0  0  0  0  0  0999 V2000", atomLine(0, 0, "C"), "M  END"].join("\n");
    expectGraph(parseMolfileGraph(molfile), ["C"], 0);
  });

  it("reads a three-atom CTAB", () => {
    const molfile = ["  3  2  0  0  0  0  0  0  0  0999 V2000", atomLine(0, 0, "C"),
      atomLine(1, 0, "O"), atomLine(2, 0, "N"), bondLine(1, 2), bondLine(2, 3), "M  END"].join("\n");
    expectGraph(parseMolfileGraph(molfile), ["C", "O", "N"], 2);
  });
});

describe("headerless CTABs of 1, 2 and 3 atoms, tagged or not, with leading blank lines", () => {
  const fullCounts = (atoms: number, bonds: number, tagged: boolean) =>
    `${String(atoms).padStart(3)}${String(bonds).padStart(3)}  0  0  0  0  0  0  0  0999${tagged ? " V2000" : ""}`;
  const tables = {
    "one-atom": { atoms: [atomLine(0, 0, "C")], bonds: [] as string[], elements: ["C"] },
    "two-atom": { atoms: [atomLine(0, 0, "C"), atomLine(1, 0, "O")], bonds: [bondLine(1, 2)], elements: ["C", "O"] },
    "three-atom": { atoms: [atomLine(0, 0, "C"), atomLine(1, 0, "O"), atomLine(2, 0, "N")], bonds: [bondLine(1, 2), bondLine(2, 3)], elements: ["C", "O", "N"] }
  } as const;
  const cases = Object.entries(tables).flatMap(([name, table]) =>
    [true, false].flatMap((tagged) => [0, 1, 2].map((blanks) => ({ name, table, tagged, blanks }))));

  it.each(cases)("reads the $name headerless CTAB (tagged: $tagged, $blanks leading blank lines)", ({ table, tagged, blanks }) => {
    const molfile = [...Array.from({ length: blanks }, () => ""), fullCounts(table.atoms.length, table.bonds.length, tagged),
      ...table.atoms, ...table.bonds, "M  END"].join("\n");
    expect(detectMolfileFormat(molfile)).toBe("molfile-v2000");
    const graph = parseMolfileGraph(molfile);
    expectGraph(graph, table.elements, table.bonds.length);
    if (table.bonds.length > 0) {
      const ids = graph.atoms.map((atom) => atom.id);
      expect(graph.bonds.map((bond) => [ids.indexOf(bond.fromAtomId), ids.indexOf(bond.toAtomId)]))
        .toEqual(table.bonds.map((_, index) => [index, index + 1]));
    }
  });

  it("still reads a headered two-atom molfile whose title is blank, tagged or not", () => {
    for (const tagged of [true, false]) {
      const molfile = ["", "  Other", "", fullCounts(2, 1, tagged), ...methanol.atoms, ...methanol.bonds, "M  END"].join("\n");
      expectGraph(parseMolfileGraph(molfile), ["C", "O"], 1);
    }
  });
});

describe("a counts line declaring no atoms never hides atom records", () => {
  const loose = ["0 0 0 C 0 0 0", "1 0 0 O 0 0 0", "2 0 0 N 0 0 0"];

  it("reads a headerless tagged CTAB of three loose whole-number atoms, no bonds", () => {
    const molfile = ["  3  0  0  0  0  0  0  0  0999 V2000", ...loose, "M  END"].join("\n");
    expectGraph(parseMolfileGraph(molfile), ["C", "O", "N"], 0);
  });

  it("refuses, never an empty molecule, when the selected counts line has 0 atoms and atom lines follow", () => {
    const zero = "  0  0  0  0  0  0  0  0  0  0999 V2000";
    const texts = [
      ["T", "P", "C", zero, atomLine(0, 0, "C"), "M  END"],
      ["T", "P", "C", zero, ...loose, "M  END"],
      [zero, ...loose, "M  END"]
    ].map((rows) => rows.join("\n"));
    for (const text of texts) expect(() => parseMolfileGraph(text)).toThrow(/declares no atoms/);
  });
});

describe("RDKit reference for the fixtures above", () => {
  beforeAll(installRealRdkitModuleLoader);
  afterAll(resetRdkitForTesting);

  it("reads line 4 as the counts line, by columns, and refuses unpadded 100 100", async () => {
    const rdkit = await ensureRdkit();
    const atomCount = (molfile: string): number | undefined => {
      const molecule = rdkit.get_mol(molfile);
      if (!molecule) return undefined;
      try {
        return (JSON.parse(molecule.get_json!()) as { molecules: { atoms: unknown[] }[] }).molecules[0]!.atoms.length;
      } finally {
        molecule.delete();
      }
    };
    for (const comment of zeroCountComments) {
      expect(atomCount(["methanol", "  Other", comment, "  2  1  0  0  0  0  0  0  0  0999 V2000",
        ...methanol.atoms, ...methanol.bonds, "M  END"].join("\n"))).toBe(2);
    }
    const ring100 = carbonRing(100);
    expect(atomCount(["", "  Other", "", "100100  0  0  0  0  0  0  0  0999 V2000", ...ring100.atoms, ...ring100.bonds, "M  END"].join("\n"))).toBe(100);
    expect(atomCount(["", "  Other", "", "100 100  0  0  0  0", ...ring100.atoms, ...ring100.bonds, "M  END"].join("\n"))).toBeUndefined();
    const ring6 = carbonRing(6);
    for (const counts of ["  6  6", "  6  6  0  0"]) {
      expect(atomCount(["cyclohexane", "", "", counts, ...ring6.atoms, ...ring6.bonds, "M  END"].join("\n"))).toBe(6);
    }
  }, 30_000);
});
