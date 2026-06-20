/**
 * Phase 1C — the corpus's INDEPENDENT cross-check.
 *
 * For every corpus case the flatten committed with an encoded stereocenter, this
 * test asks native RDKit two separate questions and asserts they agree:
 *   1. perceiveFrom3D — what chirality (CIP) does the 3D conformer actually have?
 *   2. perceiveFrom2D — what chirality does the flatten's 2D wedge depiction encode?
 * If our flatten/wedge math placed a sound wedge, an entirely different engine,
 * reading only the projected 2D coordinates + wedge, must arrive at the same CIP
 * descriptor it independently derived from the raw 3D geometry. This is the
 * external judge the roadmap requires — RDKit never sees our parity math.
 *
 * Skips (does not fail) when the isolated venv is absent, so CI without RDKit and
 * machines that have not run tools/rdkit-oracle/setup.sh stay green.
 */

import { describe, expect, it } from "vitest";

import { flattenPerspectiveFrom3D } from "@chemdraft/chem-core";
import type { MoleculeObject } from "@chemdraft/chem-core";

import { CORPUS, type CorpusCase } from "../../packages/chem-core/src/corpus";
import {
  isOracleAvailable,
  oracleEngineInfo,
  runOracle,
  type OracleBond,
  type OracleRequest,
  type OracleResult
} from "./client";

const available = isOracleAvailable();
const describeOracle = available ? describe : describe.skip;

function canonicalOrder(mol: MoleculeObject): { ids: string[]; index: Map<string, number> } {
  const ids = mol.atoms.map((a) => a.id);
  const index = new Map(ids.map((id, i) => [id, i]));
  return { ids, index };
}

function bondsFor(
  bonds: MoleculeObject["bonds"],
  index: Map<string, number>,
  withWedges: boolean
): OracleBond[] {
  return bonds.map((b) => {
    const style = b.display?.bondStyle;
    const wedge: OracleBond["wedge"] =
      withWedges && style === "wedge" ? "up" : withWedges && style === "hashed" ? "down" : null;
    return {
      from: index.get(b.fromAtomId) as number,
      to: index.get(b.toAtomId) as number,
      order: b.order,
      wedge
    };
  });
}

interface Encoded {
  caseId: string;
  atomId: string;
  centerIndex: number;
}

describeOracle("Phase 1C corpus — independent RDKit cross-check", () => {
  it("reports the pinned engine", () => {
    const engine = oracleEngineInfo();
    expect(engine?.name).toBe("rdkit");
    // Pinned to 2026.3.x; record-and-tolerate patch drift per setup notes.
    expect(engine?.version.startsWith("2026.")).toBe(true);
  });

  // Build one batched request set across the whole corpus, then assert.
  const requests: OracleRequest[] = [];
  const encodedCenters: Encoded[] = [];

  for (const testCase of CORPUS as readonly CorpusCase[]) {
    const result = flattenPerspectiveFrom3D(testCase.mol, testCase.coords3d, testCase.viewMatrix, {
      objectId: testCase.mol.id
    });
    const encoded = result.stereoCenters.filter((c) => c.status === "encoded");
    if (result.status !== "committed" || encoded.length === 0) continue;

    const projected = result.mol2dProjected as MoleculeObject;
    const { ids, index } = canonicalOrder(testCase.mol);
    const projectedById = new Map(projected.atoms.map((a) => [a.id, a]));

    // 3D request: original connectivity + the spun conformer coordinates.
    requests.push({
      id: `${testCase.id}:3d`,
      op: "perceiveFrom3D",
      atoms: ids.map((id, i) => ({
        element: testCase.mol.atoms[i].element,
        x: testCase.coords3d[i * 3],
        y: testCase.coords3d[i * 3 + 1],
        z: testCase.coords3d[i * 3 + 2]
      })),
      bonds: bondsFor(testCase.mol.bonds, index, false)
    });

    // 2D request: the flatten's projected depiction + its wedges.
    requests.push({
      id: `${testCase.id}:2d`,
      op: "perceiveFrom2D",
      atoms: ids.map((id) => {
        const a = projectedById.get(id);
        return { element: a?.element ?? "C", x: a?.x ?? 0, y: a?.y ?? 0, z: 0 };
      }),
      bonds: bondsFor(projected.bonds, index, true)
    });

    for (const center of encoded) {
      encodedCenters.push({
        caseId: testCase.id,
        atomId: center.atomId,
        centerIndex: index.get(center.atomId) as number
      });
    }
  }

  it("exercises at least one encoded stereocenter (the check is not vacuous)", () => {
    expect(encodedCenters.length).toBeGreaterThan(0);
  });

  it("RDKit agrees: every encoded wedge's CIP matches the 3D conformer's CIP", () => {
    const response = runOracle(requests);
    const byId = new Map<string, OracleResult>(response.results.map((r) => [r.id, r]));

    const mismatches: string[] = [];
    for (const { caseId, atomId, centerIndex } of encodedCenters) {
      const r3d = byId.get(`${caseId}:3d`);
      const r2d = byId.get(`${caseId}:2d`);
      const key = String(centerIndex);
      const cip3d = r3d?.centers[key];
      const cip2d = r2d?.centers[key];

      if (r3d?.error) mismatches.push(`${caseId}/${atomId}: 3D oracle error ${r3d.error}`);
      else if (r2d?.error) mismatches.push(`${caseId}/${atomId}: 2D oracle error ${r2d.error}`);
      else if (!cip3d) mismatches.push(`${caseId}/${atomId}: RDKit found no CIP in 3D conformer`);
      else if (!cip2d) mismatches.push(`${caseId}/${atomId}: RDKit found no CIP in 2D depiction`);
      else if (cip3d !== cip2d)
        mismatches.push(`${caseId}/${atomId}: 3D=${cip3d} but depiction=${cip2d} (wedge inverts chirality!)`);
    }

    expect(mismatches, mismatches.join("\n")).toEqual([]);
  });

  it("has teeth: flipping an encoded wedge makes the oracle DISAGREE with the 3D truth", () => {
    // Take a known chiral case, then deliberately invert its wedge (up<->down) in
    // the depiction. The oracle must now report the opposite CIP from the 3D
    // conformer — proving the cross-check above would catch a wrong-handed wedge.
    const testCase = (CORPUS as readonly CorpusCase[]).find((c) => c.id === "single-center-pos");
    expect(testCase, "single-center-pos corpus case must exist").toBeDefined();
    const chosen = testCase as CorpusCase;

    const result = flattenPerspectiveFrom3D(chosen.mol, chosen.coords3d, chosen.viewMatrix, {
      objectId: chosen.mol.id
    });
    const encoded = result.stereoCenters.filter((c) => c.status === "encoded");
    expect(encoded).toHaveLength(1);
    const center = encoded[0];

    const projected = result.mol2dProjected as MoleculeObject;
    const { ids, index } = canonicalOrder(chosen.mol);
    const projectedById = new Map(projected.atoms.map((a) => [a.id, a]));
    const centerIndex = index.get(center.atomId) as number;

    const flippedBonds: OracleBond[] = projected.bonds.map((b) => {
      const style = b.display?.bondStyle;
      // Invert the encoded wedge; leave everything else plain.
      const wedge: OracleBond["wedge"] =
        style === "wedge" ? "down" : style === "hashed" ? "up" : null;
      return { from: index.get(b.fromAtomId) as number, to: index.get(b.toAtomId) as number, order: b.order, wedge };
    });

    const response = runOracle([
      {
        id: "truth:3d",
        op: "perceiveFrom3D",
        atoms: ids.map((id, i) => ({
          element: chosen.mol.atoms[i].element,
          x: chosen.coords3d[i * 3],
          y: chosen.coords3d[i * 3 + 1],
          z: chosen.coords3d[i * 3 + 2]
        })),
        bonds: bondsFor(chosen.mol.bonds, index, false)
      },
      {
        id: "flipped:2d",
        op: "perceiveFrom2D",
        atoms: ids.map((id) => {
          const a = projectedById.get(id);
          return { element: a?.element ?? "C", x: a?.x ?? 0, y: a?.y ?? 0, z: 0 };
        }),
        bonds: flippedBonds
      }
    ]);

    const byId = new Map<string, OracleResult>(response.results.map((r) => [r.id, r]));
    const key = String(centerIndex);
    const cipTruth = byId.get("truth:3d")?.centers[key];
    const cipFlipped = byId.get("flipped:2d")?.centers[key];

    expect(cipTruth).toBeDefined();
    expect(cipFlipped).toBeDefined();
    expect(cipFlipped).not.toBe(cipTruth); // the inverted wedge encodes the enantiomer
  });
});
