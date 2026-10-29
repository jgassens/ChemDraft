import { finishLayout, fuseBenzeneOnEdge, regularPolygon, rotate } from "./geometry.mjs";
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
    id: "2-2-2-cryptand", name: "[2.2.2]Cryptand", bridges: [2, 2, 2],
    synonyms: ["cryptand 222", "cryptand[2.2.2]", "2.2.2-cryptand", "222 cryptand", "[2.2.2] cryptand"],
    cid: 72801, formula: "C18H36N2O6", smiles: "C1COCCOCCN2CCOCCOCCN1CCOCCOCC2"
  },
  {
    id: "2-2-1-cryptand", name: "[2.2.1]Cryptand", bridges: [2, 1, 2],
    synonyms: ["cryptand 221", "cryptand[2.2.1]", "2.2.1-cryptand", "221 cryptand", "[2.2.1] cryptand"],
    cid: 123438, formula: "C16H32N2O5", smiles: "C1COCCN2CCOCCOCCN1CCOCCOCC2"
  },
  {
    id: "2-1-1-cryptand", name: "[2.1.1]Cryptand", bridges: [2, 1, 1],
    synonyms: ["cryptand 211", "cryptand[2.1.1]", "2.1.1-cryptand", "211 cryptand", "[2.1.1] cryptand"],
    cid: 169276, formula: "C14H28N2O4", smiles: "C1COCCN2CCOCCN1CCOCCOCC2"
  }
];

/**
 * Three unit bonds between donor stations: two carbon corners bow away from the
 * cavity. A donor separation of 2 gives 120-degree carbon angles and a lobe
 * height of sqrt(3)/2. The right-hand side is outside a counterclockwise crown;
 * upper cryptand paths instead use the left-hand side. No reference coordinates.
 */
function ethyleneBridge(from, to, side = 1) {
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  if (span <= 1 || span >= 3) throw new Error("A three-bond lobe needs a donor span between 1 and 3.");
  const ux = (to.x - from.x) / span, uy = (to.y - from.y) / span;
  const along = (span - 1) / 2, height = Math.sqrt(1 - along * along);
  const dx = side * height * uy, dy = -side * height * ux;
  return [
    from,
    { x: from.x + along * ux + dx, y: from.y + along * uy + dy },
    { x: to.x - along * ux + dx, y: to.y - along * uy + dy },
    to
  ];
}

function crownLayout({ ringSize, fusedEdges = [] }) {
  const donorCount = ringSize / 3;
  // Four/eight donors straddle the vertical axis; five/six/seven put an O on it.
  // For benzo crowns, put the rigid ortho edge on the left. Opposite fused edges
  // then give opposed regular hexagons with balanced upper/lower flexible chains.
  const rotation = fusedEdges.length
    ? Math.PI - Math.PI / donorCount - 2 * Math.PI * (fusedEdges[0] / 3) / donorCount
    : Math.PI / 2 + (donorCount % 4 === 0 ? Math.PI / donorCount : 0);
  const donors = regularPolygon(donorCount, rotation).map(({ x, y }) => ({ x: 2 * x, y: 2 * y }));
  // Keep the existing C-C-O atom indexing and fused-edge identities.
  const atoms = donors.flatMap((donor, index) => {
    const [, a, b, oxygen] = ethyleneBridge(donor, donors[(index + 1) % donorCount]);
    return [{ element: "C", ...a }, { element: "C", ...b }, { element: "O", ...oxygen }];
  });
  const bonds = atoms.map((_, index) => [index, (index + 1) % ringSize, 1]);
  const layout = { atoms, bonds };
  for (const edge of fusedEdges) fuseBenzeneOnEdge(layout, edge, (edge + 1) % ringSize);
  return finishLayout(layout);
}

function middleBridge(oxygenCount, angle) {
  // A continuous equal-bond zigzag exposes every carbon, including beside N.
  // Rotate the odd-bond chain as a rigid unit to level its bridgeheads; its two
  // oxygens then sit on opposite sides of the centre line, without stereobonds.
  const bondCount = 3 * oxygenCount + 3;
  const points = [{ x: 0, y: 0 }];
  for (let step = 0; step < bondCount; step += 1) {
    points.push({ x: (step + 1) * Math.cos(angle), y: step % 2 === 0 ? Math.sin(angle) : 0 });
  }
  const end = points.at(-1);
  const span = Math.hypot(end.x, end.y);
  return rotate(points, -Math.atan2(end.y, end.x)).map(({ x, y }) => ({ x: x - span / 2, y }));
}

function outerBridge(oxygenCount, span, donorSpan, side) {
  // Donor stations describe the cage envelope; the carbon corners, not circular
  // arc interpolation, supply the chain's outward bends. Longer stations in the
  // wide [2.2.2] projection leave room for its nine-bond central zigzag.
  const offset = oxygenCount === 2 ? donorSpan / 2 : 0;
  const height = Math.sqrt(donorSpan * donorSpan - (span / 2 - offset) ** 2);
  if (!Number.isFinite(height)) throw new Error("Cryptand donor stations cannot reach the bridgeheads.");
  const stations = [
    { x: -span / 2, y: 0 },
    ...(oxygenCount === 2 ? [{ x: -offset, y: side * height }, { x: offset, y: side * height }]
      : [{ x: 0, y: side * height }]),
    { x: span / 2, y: 0 }
  ];
  return stations.flatMap((station, index) => index === stations.length - 1 ? [station]
    : ethyleneBridge(station, stations[index + 1], -side).slice(0, -1));
}

function cryptandLayout({ bridges }) {
  const middleOxygens = bridges[1];
  const shortOuterArm = bridges[2] === 1;
  const angle = (middleOxygens === 2 ? 45 : shortOuterArm ? 40 : 30) * Math.PI / 180;
  const middle = middleBridge(middleOxygens, angle);
  const span = middle.at(-1).x - middle[0].x;
  const atoms = [{ element: "N", x: -span / 2, y: 0 }, { element: "N", x: span / 2, y: 0 }];
  const bonds = [];
  bridges.forEach((oxygenCount, bridge) => {
    const donorSpan = middleOxygens === 2 || oxygenCount === 1 ? 2.5 : 2;
    const points = bridge === 1 ? middle : outerBridge(oxygenCount, span, donorSpan, bridge === 0 ? 1 : -1);
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
    source: { database: "PubChem", cid: entry.cid },
    ...(entry.bridges ? { note: "The [a.b.c] convention counts ether oxygen atoms in each of the three bridges between the nitrogen bridgeheads." } : {}),
    layout
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
