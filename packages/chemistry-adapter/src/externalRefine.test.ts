import { describe, expect, it } from "vitest";
import {
  applyExternalMinimizedMolfile,
  parseV2000AtomBlock,
  type Generate3DConformerResult
} from "./index";

interface Atom {
  element: string;
  x: number;
  y: number;
  z: number;
}

/** Build a fixed-column V2000 molfile (spec layout: three 10-char coord fields, then a
 *  space, then the 3-char symbol at columns 32–34) so we exercise the real parser path. */
function v2000(atoms: Atom[]): string {
  const f = (n: number) => n.toFixed(4).padStart(10);
  const counts = `${String(atoms.length).padStart(3)}  0  0  0  0  0  0  0  0  0999 V2000`;
  const atomLines = atoms.map(
    (a) => `${f(a.x)}${f(a.y)}${f(a.z)} ${a.element.padEnd(3)} 0  0  0  0  0  0  0  0  0  0  0  0`
  );
  return ["", "  test", "", counts, ...atomLines, "M  END"].join("\n");
}

/** Minimal embedded result: `engineToOriginalAtom` maps engine atom order → original
 *  index (or -1 for an engine-generated H). */
function makeEmbedded(engineToOriginalAtom: number[], originalAtomCount: number): Generate3DConformerResult {
  const originalToEngineAtom = new Array<number>(originalAtomCount).fill(-1);
  engineToOriginalAtom.forEach((orig, engineIdx) => {
    if (orig >= 0) originalToEngineAtom[orig] = engineIdx;
  });
  return {
    mapping: {
      coords3dByOriginalAtom: new Float64Array(originalAtomCount * 3), // all zero = "embedded"
      originalToEngineAtom,
      engineToOriginalAtom,
      generatedHydrogenEngineAtoms: engineToOriginalAtom.flatMap((orig, i) => (orig < 0 ? [i] : []))
    },
    originalAtomCount,
    generatedAtomCount: engineToOriginalAtom.filter((orig) => orig < 0).length,
    hydrogens: { added: true, explicitInputHydrogensPreserved: false },
    engine: { name: "openchemlib", version: "test", parameters: {} },
    embed: { status: "ok" },
    forceField: { name: "MMFF94", status: "not-run" },
    unsupportedFeatures: [],
    warnings: []
  };
}

describe("parseV2000AtomBlock", () => {
  it("parses elements and coordinates by fixed columns", () => {
    const atoms = parseV2000AtomBlock(
      v2000([
        { element: "C", x: 0, y: 0, z: 0 },
        { element: "O", x: -1.2345, y: 2.5, z: 0.5 },
        { element: "Cl", x: 10.1, y: -3.25, z: 4 }
      ])
    );
    expect(atoms).not.toBeNull();
    expect(atoms).toEqual([
      { element: "C", x: 0, y: 0, z: 0 },
      { element: "O", x: -1.2345, y: 2.5, z: 0.5 },
      { element: "Cl", x: 10.1, y: -3.25, z: 4 }
    ]);
  });

  it("tolerates CRLF line endings", () => {
    const molfile = v2000([{ element: "C", x: 1, y: 2, z: 3 }]).replace(/\n/g, "\r\n");
    expect(parseV2000AtomBlock(molfile)).toEqual([{ element: "C", x: 1, y: 2, z: 3 }]);
  });

  it("returns null for malformed molfiles", () => {
    expect(parseV2000AtomBlock("")).toBeNull();
    expect(parseV2000AtomBlock("only\none\ntwo")).toBeNull(); // < 4 lines
    // Counts claims 2 atoms but only one atom line follows.
    expect(parseV2000AtomBlock(["", "t", "", "  2  0  0  0  0  0  0  0  0  0999 V2000",
      "    0.0000    0.0000    0.0000 C   0", "M  END"].join("\n"))).toBeNull();
  });
});

describe("applyExternalMinimizedMolfile", () => {
  // 2 heavy atoms (original 0,1) + 1 engine-generated H (engine idx 2 → original -1).
  const engineToOriginal = [0, 1, -1];
  const embeddedMol = v2000([
    { element: "C", x: 0, y: 0, z: 0 },
    { element: "O", x: 1.4, y: 0, z: 0 },
    { element: "H", x: -1, y: 0, z: 0 }
  ]);

  it("scatters minimised coordinates onto the right original atoms", () => {
    const embedded = makeEmbedded(engineToOriginal, 2);
    const minimizedMol = v2000([
      { element: "C", x: 0.1, y: 0.2, z: 0.3 },
      { element: "O", x: 1.5, y: 0.6, z: 0.7 },
      { element: "H", x: -1.1, y: 0.9, z: 0.0 }
    ]);

    const outcome = applyExternalMinimizedMolfile(embedded, embeddedMol, minimizedMol, {
      name: "UFF",
      status: "converged",
      returnCode: 0,
      energy: -12.5
    });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    // Original atom 0 ← engine atom 0; original atom 1 ← engine atom 1; the H (engine 2) is dropped.
    expect([...outcome.result.mapping.coords3dByOriginalAtom]).toEqual([0.1, 0.2, 0.3, 1.5, 0.6, 0.7]);
    expect(outcome.result.forceField).toEqual({
      name: "UFF",
      status: "converged",
      returnCode: 0,
      energy: -12.5,
      iterations: undefined
    });
    // The embedded result is not mutated.
    expect([...embedded.mapping.coords3dByOriginalAtom]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("rejects when the sidecar changes the atom count", () => {
    const embedded = makeEmbedded(engineToOriginal, 2);
    const minimizedMol = v2000([
      { element: "C", x: 0, y: 0, z: 0 },
      { element: "O", x: 1, y: 0, z: 0 }
    ]);
    const outcome = applyExternalMinimizedMolfile(embedded, embeddedMol, minimizedMol, {
      name: "UFF",
      status: "converged"
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toMatch(/atom count/);
  });

  it("rejects when the sidecar reorders atoms (element sequence differs)", () => {
    const embedded = makeEmbedded(engineToOriginal, 2);
    const reordered = v2000([
      { element: "O", x: 0, y: 0, z: 0 }, // was C
      { element: "C", x: 1.4, y: 0, z: 0 }, // was O
      { element: "H", x: -1, y: 0, z: 0 }
    ]);
    const outcome = applyExternalMinimizedMolfile(embedded, embeddedMol, reordered, {
      name: "GAFF",
      status: "converged"
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toMatch(/atom order/);
  });

  it("rejects an unparseable minimised molfile", () => {
    const embedded = makeEmbedded(engineToOriginal, 2);
    const outcome = applyExternalMinimizedMolfile(embedded, embeddedMol, "garbage", {
      name: "UFF",
      status: "converged"
    });
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toMatch(/not valid V2000/);
  });
});
