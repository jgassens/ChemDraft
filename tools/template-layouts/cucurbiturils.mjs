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

// One sector is repeated by rigid rotation: a/b locate each N tangentially/
// radially from the shared methine edge, h locates the carbonyl C. Both CH2
// circuits bend outward into the gaps between glycolurils, away from the inner
// carbonyls. The modest glycoluril tilt in CB[7]/[8] opens the inner portal while
// keeping the carbonyls strictly radial (their O positions are solved separately).
// CB[5]/[6] retain their existing unequal-bond exceptions; CB[7]/[8]/[10] remain
// within 5% of their mean. All designs preserve >= 0.75 label-to-bond clearance,
// >= 0.35 nonincident bond clearance and bridge angles between 90 and 155 degrees.
const portalDesigns = {
  5: {
    inner: { a: 1.1754680062, b: 0.7370131491, h: 1.3436847367, carbonyl: 1.2421084275, bridge: 0.9997907184 },
    outer: { a: 1.3493420374, b: 0.5273081742, h: 0.5136119162, carbonyl: 1.3446511622, bridge: 1.3457152810 },
    radius: 3.5628989483, tilt: 0
  },
  6: {
    inner: { a: 0.6543929205, b: 0.9895204409, h: 1.7929182997, carbonyl: 1.0084750416, bridge: 1.2127935339 },
    outer: { a: 1.2357367519, b: 0.6722827835, h: 0.6939926052, carbonyl: 1.2377949291, bridge: 1.2357096005 },
    radius: 3.8686638297, tilt: 0
  },
  7: {
    inner: { a: 0.5675572011, b: 0.9574590017, h: 1.7509011871, carbonyl: 0.9601055372, bridge: 1.0472662664 },
    outer: { a: 1.0586906814, b: 0.7809436208, h: 0.7905783429, carbonyl: 1.0586402951, bridge: 1.0587178726 },
    radius: 3.7607494353, tilt: 0.1855418430
  },
  8: {
    inner: { a: 0.5123158969, b: 0.9943330908, h: 1.8356100814, carbonyl: 0.9979640451, bridge: 1.0003714525 },
    outer: { a: 1.0063426566, b: 0.8822798731, h: 0.9529463432, carbonyl: 1.0148158969, bridge: 1.0148158969 },
    radius: 4.0467367666, tilt: 0.1899273956
  }
};

function unitPentagon(a) {
  // With a unit shared C-C edge, solve both remaining pairs of sides as unit
  // circle intersections, rather than scaling a regular pentagon independently.
  const b = Math.sqrt(1 - (a - 0.5) ** 2);
  return { a, b, h: b + Math.sqrt(1 - a * a), carbonyl: 1, bridge: 1 };
}

function portalLayout(n) {
  // Two pentagons share a nearly tangential methine C-C edge; their corresponding
  // N pairs belong to the two portals. Tilt is applied to the entire glycoluril,
  // never to individual bridges or individual repeats.
  const sharedHalfEdge = 0.5;
  const halfSector = Math.PI / n;
  const { inner, outer, radius, tilt } = portalDesigns[n] ?? {
    inner: unitPentagon(0.6), outer: unitPentagon(0.98), tilt: 0,
    radius: (0.98 * Math.cos(halfSector) + 0.965) / Math.sin(halfSector) - unitPentagon(0.98).b
  };
  const atoms = [], bonds = [];
  for (let unit = 0; unit < n; unit += 1) {
    const angle = Math.PI / 2 + 2 * unit * halfSector;
    const point = (element, x, y) => {
      const tx = x * Math.cos(tilt) - y * Math.sin(tilt);
      const ty = x * Math.sin(tilt) + y * Math.cos(tilt);
      return {
        element,
        x: (radius + ty) * Math.cos(angle) - tx * Math.sin(angle),
        y: (radius + ty) * Math.sin(angle) + tx * Math.cos(angle)
      };
    };
    // Aim from the carbonyl C along its actual radius, even in a tilted unit.
    const oxygen = (y, length) => {
      const carbon = point("C", 0, y);
      const scale = 1 + length / Math.hypot(carbon.x, carbon.y);
      return { element: "O", x: carbon.x * scale, y: carbon.y * scale };
    };
    atoms.push(
      point("C", -sharedHalfEdge, 0), point("C", sharedHalfEdge, 0),
      point("N", -inner.a, -inner.b), point("N", inner.a, -inner.b),
      point("C", 0, -inner.h), oxygen(-inner.h, -inner.carbonyl),
      point("N", -outer.a, outer.b), point("N", outer.a, outer.b),
      point("C", 0, outer.h), oxygen(outer.h, outer.carbonyl),
      // Filled from neighbouring N positions after every sector exists.
      point("C", 0, 0), point("C", 0, 0)
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
  for (let unit = 0; unit < n; unit += 1) {
    const offset = 12 * unit, next = 12 * ((unit + 1) % n);
    for (const [from, to, bridge, length] of [
      [offset + 3, next + 2, offset + 10, inner.bridge],
      [offset + 7, next + 6, offset + 11, outer.bridge]
    ]) {
      const a = atoms[from], b = atoms[to];
      const dx = b.x - a.x, dy = b.y - a.y, chord = Math.hypot(dx, dy);
      if (chord <= 0 || chord >= 2 * length) throw new Error(`Invalid CB[${n}] portal chord.`);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const height = Math.sqrt(length * length - chord * chord / 4);
      // The outward circle intersection keeps the inner bridge clear of C=O.
      const candidates = [-1, 1].map((side) => ({
        element: "C", x: mx + side * height * dy / chord, y: my - side * height * dx / chord
      }));
      atoms[bridge] = candidates.reduce((a, b) => Math.hypot(a.x, a.y) > Math.hypot(b.x, b.y) ? a : b);
    }
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
    note: [entry.note, "Rotationally symmetric planar portal view with nearly tangential shared methine C-C bonds, radial inward and outward carbonyls, and two bent methylene bridges between each neighbouring pair of glycolurils. Methine stereochemistry is unspecified, as in the PubChem identity."].filter(Boolean).join(" "),
    layout: portalLayout(entry.n)
  }))
};

runFamilyIfMain(import.meta.url, generator);
