import { equalBondArc, finishLayout, fuseBenzeneOnEdge, regularPolygon } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

// Identity metadata is the vetted PubChem input. Coordinates below are our own geometric designs.
const crowns = [
  {
    id: "12-crown-4", name: "12-Crown-4", ringSize: 12,
    synonyms: ["1,4,7,10-tetraoxacyclododecane", "12C4", "12-crown-4 ether"],
    cid: 9269, formula: "C8H16O4", smiles: "C1COCCOCCOCCO1"
  },
  {
    id: "15-crown-5", name: "15-Crown-5", ringSize: 15,
    synonyms: ["1,4,7,10,13-pentaoxacyclopentadecane", "15C5", "15-crown-5 ether"],
    cid: 36336, formula: "C10H20O5", smiles: "C1COCCOCCOCCOCCO1"
  },
  {
    id: "18-crown-6", name: "18-Crown-6", ringSize: 18,
    synonyms: ["1,4,7,10,13,16-hexaoxacyclooctadecane", "18C6", "18-crown-6 ether"],
    cid: 28557, formula: "C12H24O6", smiles: "C1COCCOCCOCCOCCOCCO1"
  },
  {
    id: "21-crown-7", name: "21-Crown-7", ringSize: 21,
    synonyms: ["1,4,7,10,13,16,19-heptaoxacyclohenicosane", "21C7", "21-crown-7 ether"],
    cid: 93160, formula: "C14H28O7", smiles: "C1COCCOCCOCCOCCOCCOCCO1"
  },
  {
    id: "24-crown-8", name: "24-Crown-8", ringSize: 24,
    synonyms: ["1,4,7,10,13,16,19,22-octaoxacyclotetracosane", "24C8", "24-crown-8 ether"],
    cid: 10893545, formula: "C16H32O8", smiles: "C1COCCOCCOCCOCCOCCOCCOCCO1"
  },
  {
    id: "benzo-15-crown-5", name: "Benzo-15-crown-5", ringSize: 15, fusedEdges: [6],
    synonyms: ["B15C5", "benzo 15 crown 5"],
    cid: 84197, formula: "C14H20O5", smiles: "C1COCCOC2=CC=CC=C2OCCOCCO1"
  },
  {
    id: "dibenzo-18-crown-6", name: "Dibenzo-18-crown-6", ringSize: 18, fusedEdges: [3, 12],
    synonyms: ["DB18C6", "dibenzo 18 crown 6"],
    cid: 26541, formula: "C20H24O6", smiles: "C1COC2=CC=CC=C2OCCOCCOC3=CC=CC=C3OCCO1"
  },
  {
    id: "dibenzo-24-crown-8", name: "Dibenzo-24-crown-8", ringSize: 24, fusedEdges: [6, 18],
    synonyms: ["DB24C8", "dibenzo 24 crown 8"],
    cid: 84238, formula: "C24H32O8", smiles: "C1COCCOC2=CC=CC=C2OCCOCCOCCOC3=CC=CC=C3OCCO1"
  }
];

const cryptands = [
  {
    id: "2-2-2-cryptand", name: "[2.2.2]Cryptand", bridges: [2, 2, 2], span: 6,
    synonyms: ["cryptand 222", "cryptand[2.2.2]", "2.2.2-cryptand", "222 cryptand", "[2.2.2] cryptand"],
    cid: 72801, formula: "C18H36N2O6", smiles: "C1COCCOCCN2CCOCCOCCN1CCOCCOCC2"
  },
  {
    id: "2-2-1-cryptand", name: "[2.2.1]Cryptand", bridges: [2, 1, 2], span: 5.5,
    synonyms: ["cryptand 221", "cryptand[2.2.1]", "2.2.1-cryptand", "221 cryptand", "[2.2.1] cryptand"],
    cid: 123438, formula: "C16H32N2O5", smiles: "C1COCCN2CCOCCOCCN1CCOCCOCC2"
  },
  {
    id: "2-1-1-cryptand", name: "[2.1.1]Cryptand", bridges: [2, 1, 1], span: 5,
    synonyms: ["cryptand 211", "cryptand[2.1.1]", "2.1.1-cryptand", "211 cryptand", "[2.1.1] cryptand"],
    cid: 169276, formula: "C14H28N2O4", smiles: "C1COCCN2CCOCCN1CCOCCOCC2"
  }
];

function crownLayout({ ringSize, fusedEdges = [] }) {
  // Orient the first fused edge vertically on the left; a second is diametrically opposite.
  const rotation = fusedEdges.length ? Math.PI - (2 * fusedEdges[0] + 1) * Math.PI / ringSize : Math.PI / 2;
  const atoms = regularPolygon(ringSize, rotation).map((point, index) => ({
    element: index % 3 === 2 ? "O" : "C", ...point
  }));
  const bonds = atoms.map((_, index) => [index, (index + 1) % ringSize, 1]);
  const layout = { atoms, bonds };
  for (const edge of fusedEdges) fuseBenzeneOnEdge(layout, edge, (edge + 1) % ringSize);
  return finishLayout(layout);
}

function middleBridge(bondCount, span) {
  // Horizontal terminal N-C bonds keep all three bridge exits well separated.
  // Inside: unit diagonals alternating with a horizontal central bond for odd contours.
  const diagonals = bondCount - 2 - (bondCount % 2);
  const dx = (span - 2 - (bondCount % 2)) / diagonals;
  const dy = Math.sqrt(1 - dx * dx);
  const points = [{ x: -span / 2, y: 0 }, { x: -span / 2 + 1, y: 0 }];
  for (let step = 0; step < diagonals; step += 1) {
    if (bondCount % 2 && step === diagonals / 2) {
      points.push({ x: points.at(-1).x + 1, y: points.at(-1).y });
    }
    points.push({ x: points.at(-1).x + dx, y: step % 2 === 0 ? dy : 0 });
  }
  points.push({ x: span / 2, y: 0 });
  return points;
}

function cryptandLayout({ bridges, span }) {
  const atoms = [{ element: "N", x: -span / 2, y: 0 }, { element: "N", x: span / 2, y: 0 }];
  const bonds = [];
  bridges.forEach((oxygenCount, bridge) => {
    const bondCount = 3 * oxygenCount + 3;
    const points = bridge === 1 ? middleBridge(bondCount, span) : equalBondArc(bondCount, span, bridge === 0 ? 1 : -1);
    let previous = 0;
    points.slice(1, -1).forEach((point, index) => {
      const next = atoms.length;
      atoms.push({ element: (index + 1) % 3 === 0 ? "O" : "C", ...point });
      bonds.push([previous, next, 1]);
      previous = next;
    });
    bonds.push([previous, 1, 1]);
  });
  return finishLayout({ atoms, bonds });
}

function template(entry, layout) {
  return {
    id: entry.id, name: entry.name, synonyms: entry.synonyms,
    family: "crown-ethers-cryptands", category: "supramolecular",
    smiles: entry.smiles, formula: entry.formula, charge: 0,
    source: { database: "PubChem", cid: entry.cid }, layout
  };
}

export const generator = {
  scriptName: "crown-ethers-cryptands.mjs",
  fileName: "crownEthersCryptands.ts",
  exportName: "crownEthersCryptandsTemplates",
  generateTemplates: () => [
    ...crowns.map((entry) => template(entry, crownLayout(entry))),
    ...cryptands.map((entry) => template(entry, cryptandLayout(entry)))
  ]
};

runFamilyIfMain(import.meta.url, generator);
