import { finishLayout, regularPolygon } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

/** Six regular hexagons and four methylenes, constructed here rather than depicted from SMILES. */
function blueBoxLayout() {
  const atoms = [], bonds = [];
  const halfHeight = 1 + Math.sqrt(3) / 2;
  function ring(cx, cy, rotation, nitrogen) {
    const start = atoms.length;
    atoms.push(...regularPolygon(6, rotation).map((point, index) => ({
      element: index === nitrogen ? "N" : "C",
      ...(index === nitrogen ? { charge: 1 } : {}), x: point.x + cx, y: point.y + cy
    })));
    for (let i = 0; i < 6; i += 1) bonds.push([start + i, start + (i + 1) % 6, i % 2 ? 1 : 2]);
    return Array.from({ length: 6 }, (_, i) => start + i);
  }
  // Each bipyridinium runs N+—(para ring)—C—C—(para ring)—N+ along a long side.
  const topLeft = ring(-1.5, halfHeight, 0, 3);
  const topRight = ring(1.5, halfHeight, 0, 0);
  const bottomLeft = ring(-1.5, -halfHeight, 0, 3);
  const bottomRight = ring(1.5, -halfHeight, 0, 0);
  bonds.push([topLeft[0], topRight[3], 1], [bottomLeft[0], bottomRight[3], 1]);
  for (const side of [-1, 1]) {
    const phenylene = ring(side * 4, 0, Math.PI / 2, -1);
    for (const [position, vertex, nitrogen] of [
      [1, 0, side < 0 ? topLeft[3] : topRight[0]],
      [-1, 3, side < 0 ? bottomLeft[3] : bottomRight[0]]
    ]) {
      const methylene = atoms.length;
      atoms.push({ element: "C", x: side * 3.5, y: position * halfHeight });
      bonds.push([nitrogen, methylene, 1], [methylene, phenylene[vertex], 1]);
    }
  }
  return finishLayout({ atoms, bonds });
}

export const generator = {
  scriptName: "cyclophanes.mjs",
  fileName: "cyclophanes.ts",
  exportName: "cyclophanesTemplates",
  generateTemplates: () => [{
    id: "cbpqt", name: "Cyclobis(paraquat-p-phenylene)",
    synonyms: ["CBPQT4+", "CBPQT", "cyclobis(paraquat-p-phenylene) tetracation", "blue box", "cyclobis(paraquat-1,4-phenylene)"],
    family: "cyclophanes", category: "supramolecular",
    smiles: "C1C2=CC=C(C[N+]3=CC=C(C=C3)C4=CC=[N+](CC5=CC=C(C[N+]6=CC=C(C=C6)C7=CC=[N+]1C=C7)C=C5)C=C4)C=C2",
    // Hill composition and formal charge are separate fields in the template contract.
    formula: "C36H32N4", charge: 4,
    source: { database: "PubChem", cid: 4457151 },
    note: "Stored as the bare tetracation; counter-ions (usually PF6-) are not part of the template.",
    layout: blueBoxLayout()
  }]
};

runFamilyIfMain(import.meta.url, generator);
