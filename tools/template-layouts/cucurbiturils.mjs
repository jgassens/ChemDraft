import { finishLayout } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

// Vetted PubChem identities only. All coordinates are constructed below, without a depiction engine.
const hosts = [
  {
    n: 5, cid: 6096206, formula: "C30H30N20O10",
    synonyms: ["CB[5]", "CB5", "cucurbit5uril"],
    smiles: "C1N2C3C4N(C2=O)CN5C6C7N(C5=O)CN8C9C2N(C8=O)CN5C8C%10N(C5=O)CN5C%11C(N1C5=O)N1CN3C(=O)N4CN6C(=O)N7CN9C(=O)N2CN8C(=O)N%10CN%11C1=O"
  },
  {
    n: 6, cid: 196163, formula: "C36H36N24O12",
    synonyms: ["CB[6]", "CB6", "cucurbituril", "cucurbit6uril"],
    smiles: "C1N2C3C4N(C2=O)CN5C6C7N(C5=O)CN8C9C2N(C8=O)CN5C8C%10N(C5=O)CN5C%11C%12N(C5=O)CN5C%13C(N1C5=O)N1CN3C(=O)N4CN6C(=O)N7CN9C(=O)N2CN8C(=O)N%10CN%11C(=O)N%12CN%13C1=O",
    note: "PubChem's record title is the historical name 'cucurbituril' for the n = 6 homologue."
  },
  {
    n: 7, cid: 6096207, formula: "C42H42N28O14",
    synonyms: ["CB[7]", "CB7", "cucurbit7uril"],
    smiles: "C1N2C3C4N(C2=O)CN5C6C7N(C5=O)CN8C9C2N(C8=O)CN5C8C%10N(C5=O)CN5C%11C%12N(C5=O)CN5C%13C%14N(C5=O)CN5C%15C(N1C5=O)N1CN3C(=O)N4CN6C(=O)N7CN9C(=O)N2CN8C(=O)N%10CN%11C(=O)N%12CN%13C(=O)N%14CN%15C1=O",
    note: "PubChem's record title mentions a hydrate; the stored formula and SMILES describe the anhydrous host."
  },
  {
    n: 8, cid: 16133299, formula: "C48H48N32O16",
    synonyms: ["CB[8]", "CB8", "cucurbit8uril"],
    smiles: "C1N2C3C4N(C2=O)CN5C6C7N(C5=O)CN8C9C2N(C8=O)CN5C8C%10N(C5=O)CN5C%11C%12N(C5=O)CN5C%13C%14N(C5=O)CN5C%15C%16N(C5=O)CN5C%17C(N1C5=O)N1CN3C(=O)N4CN6C(=O)N7CN9C(=O)N2CN8C(=O)N%10CN%11C(=O)N%12CN%13C(=O)N%14CN%15C(=O)N%16CN%17C1=O"
  },
  {
    n: 10, cid: 16150917, formula: "C60H60N40O20",
    synonyms: ["CB[10]", "CB10", "cucurbit10uril"],
    smiles: "C1N2C3C4N(C2=O)CN5C6C7N(C5=O)CN8C9C2N(C8=O)CN5C8C%10N(C5=O)CN5C%11C%12N(C5=O)CN5C%13C%14N(C5=O)CN5C%15C%16N(C5=O)CN5C%17C%18N(C5=O)CN5C%19C%20N(C5=O)CN5C%21C(N1C5=O)N1CN3C(=O)N4CN6C(=O)N7CN9C(=O)N2CN8C(=O)N%10CN%11C(=O)N%12CN%13C(=O)N%14CN%15C(=O)N%16CN%17C(=O)N%18CN%19C(=O)N%20CN%21C1=O"
  }
];

// The compact portals need shallower pentagons than the larger hosts to leave
// their inward carbonyls and N-CH2-N bridges apart. These original geometric
// designs tighten bond-length spread while retaining >= 0.95 label clearance.
// CB[7] fits the 5% window; CB[5]/[6] remain explicit exceptions in the geometry
// test. All homologues retain the same graph and tangential shared methine edge.
const compactPortalDesigns = {
  5: {
    inner: { a: 1.1011446628, b: 0.7888226553, h: 1.1683883543, carbonyl: 1.1345593463, bridge: 1.0765795517 },
    outer: { a: 1.2541237317, b: 0.6441875058, h: 0.6941906732, carbonyl: 1.2494736361, bridge: 1.2557186317 },
    outerHalfChord: 1.2556665852
  },
  6: {
    inner: { a: 0.9451556384, b: 0.8954532135, h: 1.4770917977, carbonyl: 1.0229998658, bridge: 1.0760910898 },
    outer: { a: 1.1567432562, b: 0.7541142456, h: 0.8041498057, carbonyl: 1.1576352847, bridge: 1.1578248879 },
    outerHalfChord: 1.1572634195
  },
  7: {
    inner: { a: 0.8098588441, b: 0.9662815691, h: 1.603474658, carbonyl: 1.0138034582, bridge: 1.0179548696 },
    outer: { a: 1.0578792649, b: 0.8476404023, h: 0.9033581847, carbonyl: 1.0459857583, bridge: 1.05786753 },
    outerHalfChord: 1.0559153658
  }
};

function unitPentagon(a) {
  // With a unit shared C-C edge, solve both remaining pairs of sides as unit
  // circle intersections, rather than scaling a regular pentagon independently.
  const b = Math.sqrt(1 - (a - 0.5) ** 2);
  return { a, b, h: b + Math.sqrt(1 - a * a), carbonyl: 1, bridge: 1 };
}

function portalLayout(n) {
  // Two pentagons share a tangential methine C-C edge. Their carbonyls point
  // radially inward/outward; the corresponding N pairs belong to the two portals.
  // A radial shared edge would instead put the two carbonyls on tangential sides.
  const sharedHalfEdge = 0.5;
  const { inner, outer, outerHalfChord } = compactPortalDesigns[n] ?? {
    inner: unitPentagon(0.7), outer: unitPentagon(0.96), outerHalfChord: 0.995
  };
  const halfSector = Math.PI / n;
  const sin = Math.sin(halfSector), cos = Math.cos(halfSector);
  // Solve the outer N-pair chord for the macrocycle radius. A circle intersection
  // closes each portal bridge at its prescribed length; the larger hosts use
  // unit bonds throughout, including both carbonyls and both bridge circuits.
  const radius = (outer.a * cos + outerHalfChord) / sin - outer.b;
  const bridgeRadius = (nitrogenRadius, a, length, side) => {
    const halfChord = nitrogenRadius * sin - a * cos;
    if (halfChord <= 0 || halfChord >= length) throw new Error(`Invalid CB[${n}] portal chord.`);
    const midpoint = nitrogenRadius * cos + a * sin;
    return midpoint + side * Math.sqrt(length * length - halfChord * halfChord);
  };
  const innerBridgeRadius = bridgeRadius(radius - inner.b, inner.a, inner.bridge, -1);
  const outerBridgeRadius = bridgeRadius(radius + outer.b, outer.a, outer.bridge, 1);
  const atoms = [], bonds = [];
  for (let unit = 0; unit < n; unit += 1) {
    const angle = Math.PI / 2 + 2 * unit * halfSector;
    // Local x is tangential and y is radial; this is a rigid rotation/translation.
    const point = (element, x, y) => ({
      element,
      x: (radius + y) * Math.cos(angle) - x * Math.sin(angle),
      y: (radius + y) * Math.sin(angle) + x * Math.cos(angle)
    });
    atoms.push(
      point("C", -sharedHalfEdge, 0), point("C", sharedHalfEdge, 0),
      point("N", -inner.a, -inner.b), point("N", inner.a, -inner.b),
      point("C", 0, -inner.h), point("O", 0, -inner.h - inner.carbonyl),
      point("N", -outer.a, outer.b), point("N", outer.a, outer.b),
      point("C", 0, outer.h), point("O", 0, outer.h + outer.carbonyl),
      ...[innerBridgeRadius, outerBridgeRadius].map((r) => ({
        element: "C", x: r * Math.cos(angle + halfSector), y: r * Math.sin(angle + halfSector)
      }))
    );
    const offset = 12 * unit, next = 12 * ((unit + 1) % n);
    // Each glycoluril contributes C4N4O2 plus two CH2 bridges: C6H6N4O2.
    // No wedges/hashes: the supplied identities leave methine stereo unspecified.
    for (const [from, to, order] of [
      [0, 1, 1], [0, 2, 1], [1, 3, 1], [2, 4, 1], [3, 4, 1], [4, 5, 2],
      [0, 6, 1], [1, 7, 1], [6, 8, 1], [7, 8, 1], [8, 9, 2],
      [3, 10, 1], [7, 11, 1]
    ]) bonds.push([offset + from, offset + to, order]);
    bonds.push([offset + 10, next + 2, 1], [offset + 11, next + 6, 1]);
  }
  return finishLayout({ atoms, bonds });
}

export const generator = {
  scriptName: "cucurbiturils.mjs",
  fileName: "cucurbiturils.ts",
  exportName: "cucurbiturilsTemplates",
  generateTemplates: () => hosts.map((entry) => ({
    id: `cucurbit-${entry.n}-uril`, name: `Cucurbit[${entry.n}]uril`, synonyms: entry.synonyms,
    family: "cucurbiturils", category: "supramolecular",
    smiles: entry.smiles, formula: entry.formula, charge: 0,
    source: { database: "PubChem", cid: entry.cid },
    note: [entry.note, "Planar portal view with tangential shared methine C-C bonds, inward and outward carbonyls, and two methylene bridges between each neighbouring pair of glycolurils. Methine stereochemistry is unspecified, as in the PubChem identity."].filter(Boolean).join(" "),
    layout: portalLayout(entry.n)
  }))
};

runFamilyIfMain(import.meta.url, generator);
