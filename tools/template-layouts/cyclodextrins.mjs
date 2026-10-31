import { finishLayout, rotate } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

// The supplied PubChem identities are metadata only. All coordinates are constructed below.
const entries = [
  {
    id: "alpha-cyclodextrin", name: "α-Cyclodextrin", units: 6, cid: 444913,
    synonyms: ["alpha-cyclodextrin", "α-CD", "alpha-CD", "a-cyclodextrin", "cyclohexaamylose", "cyclomaltohexaose", "Schardinger α-dextrin", "Schardinger alpha-dextrin"],
    formula: "C36H60O30",
    smiles: "C([C@@H]1[C@@H]2[C@@H]([C@H]([C@H](O1)O[C@@H]3[C@H](O[C@@H]([C@@H]([C@H]3O)O)O[C@@H]4[C@H](O[C@@H]([C@@H]([C@H]4O)O)O[C@@H]5[C@H](O[C@@H]([C@@H]([C@H]5O)O)O[C@@H]6[C@H](O[C@@H]([C@@H]([C@H]6O)O)O[C@@H]7[C@H](O[C@H](O2)[C@@H]([C@H]7O)O)CO)CO)CO)CO)CO)O)O)O"
  },
  {
    id: "beta-cyclodextrin", name: "β-Cyclodextrin", units: 7, cid: 444041,
    synonyms: ["beta-cyclodextrin", "β-CD", "beta-CD", "b-cyclodextrin", "cycloheptaamylose", "cyclomaltoheptaose", "Schardinger β-dextrin", "Schardinger beta-dextrin"],
    formula: "C42H70O35",
    smiles: "C([C@@H]1[C@@H]2[C@@H]([C@H]([C@H](O1)O[C@@H]3[C@H](O[C@@H]([C@@H]([C@H]3O)O)O[C@@H]4[C@H](O[C@@H]([C@@H]([C@H]4O)O)O[C@@H]5[C@H](O[C@@H]([C@@H]([C@H]5O)O)O[C@@H]6[C@H](O[C@@H]([C@@H]([C@H]6O)O)O[C@@H]7[C@H](O[C@@H]([C@@H]([C@H]7O)O)O[C@@H]8[C@H](O[C@H](O2)[C@@H]([C@H]8O)O)CO)CO)CO)CO)CO)CO)O)O)O"
  },
  {
    id: "gamma-cyclodextrin", name: "γ-Cyclodextrin", units: 8, cid: 5287407,
    synonyms: ["gamma-cyclodextrin", "γ-CD", "gamma-CD", "cyclooctaamylose", "cyclomaltooctaose"],
    formula: "C48H80O40",
    smiles: "C([C@@H]1[C@@H]2[C@@H]([C@H]([C@H](O1)O[C@@H]3[C@H](O[C@@H]([C@@H]([C@H]3O)O)O[C@@H]4[C@H](O[C@@H]([C@@H]([C@H]4O)O)O[C@@H]5[C@H](O[C@@H]([C@@H]([C@H]5O)O)O[C@@H]6[C@H](O[C@@H]([C@@H]([C@H]6O)O)O[C@@H]7[C@H](O[C@@H]([C@@H]([C@H]7O)O)O[C@@H]8[C@H](O[C@@H]([C@@H]([C@H]8O)O)O[C@@H]9[C@H](O[C@H](O2)[C@@H]([C@H]9O)O)CO)CO)CO)CO)CO)CO)CO)O)O)O"
  }
];

const radians = (degrees) => degrees * Math.PI / 180;
const step = (point, degrees) => ({ x: point.x + Math.cos(radians(degrees)), y: point.y + Math.sin(radians(degrees)) });

/**
 * A perspective chair made from three opposite pairs of unit edges, not a flat hexagon.
 * Ring order: C1, C2, C3, C4, C5, O5. The two tips are C1 and C4. Opposing
 * 20°/70° diagonals give the familiar chair silhouette without shortening any edge.
 * The other local atoms are C6, O6, O2 and O3; the linker O1 is added separately.
 */
function glucoseChair() {
  const vertices = [{ x: 0, y: 0 }];
  for (const angle of [-160, 180, -110, 20, 0]) vertices.push(step(vertices.at(-1), angle));
  const centre = { x: (vertices[0].x + vertices[3].x) / 2, y: (vertices[0].y + vertices[3].y) / 2 };
  const ring = vertices.map(({ x, y }, index) => ({ element: index === 5 ? "O" : "C", x: x - centre.x, y: y - centre.y }));
  const primaryCarbon = { element: "C", ...step(ring[4], -100) };
  // Local +y faces the secondary rim; the primary CH2OH extends towards local -y.
  return [...ring, primaryCarbon,
    { element: "O", ...step(primaryCarbon, -40) },
    // Fan the secondary OH bonds apart on every chair. In particular, the
    // bottom unit must leave room for the full HO/OH text, not just its oxygen.
    { element: "O", ...step(ring[1], 90) },
    { element: "O", ...step(ring[2], 135) }
  ];
}

function cyclodextrinLayout(count) {
  // Turn the C1-C4 axis almost tangential to the polygon. This makes room at the
  // secondary rim even for the six-unit homologue without stretching the linkers.
  const chair = rotate(glucoseChair(), radians(-25));
  const halfTurn = Math.PI / count;
  const c = Math.cos(halfTurn), s = Math.sin(halfTurn);
  // Solve the polygon radius from the C1-to-next-C4 chord. The two glycosidic bonds
  // remain unit length, while the open chord leaves room between neighbouring chairs.
  const chord = 1.8;
  const { x: a, y: b } = chair[0];
  const radius = (a * c + Math.sqrt(chord * chord - 4 * b * b * c * c) / 2) / s;
  const atoms = [], bonds = [];
  for (let unit = 0; unit < count; unit += 1) {
    atoms.push(...rotate(chair.map((atom) => ({ ...atom, y: atom.y - radius })), 2 * halfTurn * unit),
      { element: "O", x: 0, y: 0 });
  }
  for (let unit = 0; unit < count; unit += 1) {
    const base = unit * 11, next = ((unit + 1) % count) * 11;
    for (let atom = 0; atom < 6; atom += 1) bonds.push([base + atom, base + (atom + 1) % 6, 1]);
    // In this projection of the 4C1 D-glucose chair, C1-O1 is axial down;
    // C2-O2 and C4-O1 are equatorial down, C3-O3 and C5-C6 equatorial up.
    // Up/down describes the chair face, not the page's y coordinate. The directed
    // substituent wedges/hashes encode all five centres; chair edges stay plain.
    bonds.push([base + 4, base + 6, 1, "wedge"], [base + 6, base + 7, 1],
      [base + 1, base + 8, 1, "hash"], [base + 2, base + 9, 1, "hash"]);
    const from = atoms[base], to = atoms[next + 3];
    const dx = to.x - from.x, dy = to.y - from.y;
    const height = Math.sqrt(1 - chord * chord / 4);
    atoms[base + 10] = {
      element: "O", x: (from.x + to.x) / 2 - height * dy / chord,
      y: (from.y + to.y) / 2 + height * dx / chord
    };
    bonds.push([base, base + 10, 1, "wedge"], [next + 3, base + 10, 1, "wedge"]);
  }
  return finishLayout({ atoms, bonds });
}

export const generator = {
  scriptName: "cyclodextrins.mjs",
  fileName: "cyclodextrins.ts",
  exportName: "cyclodextrinsTemplates",
  generateTemplates: () => entries.map((entry) => ({
    id: entry.id, name: entry.name, synonyms: entry.synonyms,
    family: "cyclodextrins", category: "supramolecular",
    smiles: entry.smiles, formula: entry.formula, charge: 0,
    source: { database: "PubChem", cid: entry.cid },
    note: `Neutral, unsubstituted cyclic α-(1→4)-linked ${entry.units}-mer of D-glucopyranose; every unit is drawn as a ⁴C₁ chair. Primary CH₂OH groups form the outer rim and the 2-OH/3-OH groups the inner rim.`,
    layout: cyclodextrinLayout(entry.units)
  }))
};

runFamilyIfMain(import.meta.url, generator);
