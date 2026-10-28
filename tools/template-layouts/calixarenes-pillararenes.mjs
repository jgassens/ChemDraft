import { finishLayout } from "./geometry.mjs";
import { runFamilyIfMain } from "./generate.mjs";

// PubChem supplies identity metadata only. Coordinates below are original unit-hexagon,
// regular-polygon and circle-intersection constructions, without a depiction engine.
const entries = [
  {
    id: "calix-4-arene", name: "Calix[4]arene", kind: "calix", n: 4,
    synonyms: ["calix4arene", "calix[4]arene-25,26,27,28-tetrol", "25,26,27,28-tetrahydroxycalix[4]arene"],
    cid: 562409, formula: "C28H24O4",
    smiles: "C1C2=C(C(=CC=C2)CC3=C(C(=CC=C3)CC4=CC=CC(=C4O)CC5=CC=CC1=C5O)O)O",
    note: "The bare name means the tetrol (the phenolic macrocycle). PubChem's record named just 'calix[4]arene' (CID 11740710) is the hydroxyl-free [1.1.1.1]metacyclophane and was not used."
  },
  {
    id: "p-tert-butylcalix-4-arene", name: "p-tert-Butylcalix[4]arene", kind: "calix", n: 4, tertButyl: true,
    synonyms: ["4-tert-butylcalix[4]arene", "p-t-butylcalix[4]arene", "tBu-calix[4]arene", "p-tBu-calix[4]arene"],
    cid: 335377, formula: "C44H56O4",
    smiles: "CC(C)(C)C1=CC2=C(C(=C1)CC3=CC(=CC(=C3O)CC4=CC(=CC(=C4O)CC5=C(C(=CC(=C5)C(C)(C)C)C2)O)C(C)(C)C)C(C)(C)C)O"
  },
  {
    id: "p-tert-butylcalix-5-arene", name: "p-tert-Butylcalix[5]arene", kind: "calix", n: 5, tertButyl: true,
    synonyms: ["4-tert-butylcalix[5]arene", "p-tBu-calix[5]arene", "p-t-butylcalix[5]arene", "tBu-calix[5]arene"],
    cid: 2725100, formula: "C55H70O5",
    smiles: "CC(C)(C)C1=CC2=C(C(=C1)CC3=CC(=CC(=C3O)CC4=CC(=CC(=C4O)CC5=C(C(=CC(=C5)C(C)(C)C)CC6=C(C(=CC(=C6)C(C)(C)C)C2)O)O)C(C)(C)C)C(C)(C)C)O"
  },
  {
    id: "calix-6-arene", name: "Calix[6]arene", kind: "calix", n: 6,
    synonyms: ["calix6arene"], cid: 2724885, formula: "C42H36O6",
    smiles: "C1C2=C(C(=CC=C2)CC3=C(C(=CC=C3)CC4=C(C(=CC=C4)CC5=CC=CC(=C5O)CC6=CC=CC(=C6O)CC7=CC=CC1=C7O)O)O)O"
  },
  {
    id: "p-tert-butylcalix-6-arene", name: "p-tert-Butylcalix[6]arene", kind: "calix", n: 6, tertButyl: true,
    synonyms: ["4-tert-butylcalix[6]arene", "p-tBu-calix[6]arene", "p-t-butylcalix[6]arene", "tBu-calix[6]arene"],
    cid: 335356, formula: "C66H84O6",
    smiles: "CC(C)(C)C1=CC2=C(C(=C1)CC3=CC(=CC(=C3O)CC4=CC(=CC(=C4O)CC5=CC(=CC(=C5O)CC6=C(C(=CC(=C6)C(C)(C)C)CC7=C(C(=CC(=C7)C(C)(C)C)C2)O)O)C(C)(C)C)C(C)(C)C)C(C)(C)C)O"
  },
  {
    id: "calix-8-arene", name: "Calix[8]arene", kind: "calix", n: 8,
    synonyms: ["calix8arene"], cid: 2724886, formula: "C56H48O8",
    smiles: "C1C2=C(C(=CC=C2)CC3=C(C(=CC=C3)CC4=C(C(=CC=C4)CC5=C(C(=CC=C5)CC6=CC=CC(=C6O)CC7=CC=CC(=C7O)CC8=CC=CC(=C8O)CC9=CC=CC1=C9O)O)O)O)O"
  },
  {
    id: "p-tert-butylcalix-8-arene", name: "p-tert-Butylcalix[8]arene", kind: "calix", n: 8, tertButyl: true,
    synonyms: ["4-tert-butylcalix[8]arene", "p-tBu-calix[8]arene", "p-t-butylcalix[8]arene", "tBu-calix[8]arene"],
    cid: 434172, formula: "C88H112O8",
    smiles: "CC(C)(C)C1=CC2=C(C(=C1)CC3=CC(=CC(=C3O)CC4=CC(=CC(=C4O)CC5=CC(=CC(=C5O)CC6=CC(=CC(=C6O)CC7=C(C(=CC(=C7)C(C)(C)C)CC8=C(C(=CC(=C8)C(C)(C)C)CC9=C(C(=CC(=C9)C(C)(C)C)C2)O)O)O)C(C)(C)C)C(C)(C)C)C(C)(C)C)C(C)(C)C)O"
  },
  {
    id: "pillar-5-arene", name: "Pillar[5]arene", kind: "pillar", n: 5,
    synonyms: ["pillar5arene", "P5", "per-hydroxypillar[5]arene"],
    cid: 50940581, formula: "C35H30O10",
    smiles: "C1C2=CC(=C(CC3=CC(=C(CC4=CC(=C(CC5=C(C=C(CC6=C(C=C1C(=C6)O)O)C(=C5)O)O)C=C4O)O)C=C3O)O)C=C2O)O",
    note: "The bare name is read literally as the per-hydroxy parent built from hydroquinone. The common per-methoxy host is the separate entry 1,4-dimethoxypillar[5]arene."
  },
  {
    id: "dimethoxypillar-5-arene", name: "1,4-Dimethoxypillar[5]arene", kind: "pillar", n: 5, methoxy: true,
    synonyms: ["dimethoxypillar[5]arene", "DMP5", "DMpillar[5]arene", "permethylated pillar[5]arene"],
    cid: 50940580, formula: "C45H50O10",
    smiles: "COC1=CC2=C(C=C1CC3=CC(=C(CC4=CC(=C(CC5=C(C=C(CC6=C(C=C(C2)C(=C6)OC)OC)C(=C5)OC)OC)C=C4OC)OC)C=C3OC)OC)OC",
    note: "The per-methoxy pillar[5]arene usually meant in the host-guest literature; kept separate from the per-hydroxy parent."
  },
  {
    id: "pillar-6-arene", name: "Pillar[6]arene", kind: "pillar", n: 6,
    synonyms: ["pillar6arene", "P6", "per-hydroxypillar[6]arene"],
    cid: 56839249, formula: "C42H36O12",
    smiles: "C1C2=CC(=C(CC3=CC(=C(CC4=CC(=C(CC5=C(C=C(CC6=C(C=C(CC7=C(C=C1C(=C7)O)O)C(=C6)O)O)C(=C5)O)O)C=C4O)O)C=C3O)O)C=C2O)O",
    note: "The bare name is read literally as the per-hydroxy parent; the per-methoxy host is 1,4-dimethoxypillar[6]arene."
  },
  {
    id: "dimethoxypillar-6-arene", name: "1,4-Dimethoxypillar[6]arene", kind: "pillar", n: 6, methoxy: true,
    synonyms: ["dimethoxypillar[6]arene", "DMP6", "DMpillar[6]arene", "permethylated pillar[6]arene"],
    cid: 132572533, formula: "C54H60O12",
    smiles: "COC1=CC2=C(C=C1CC3=CC(=C(CC4=CC(=C(CC5=CC(=C(CC6=C(C=C(CC7=C(C=C(C2)C(=C7)OC)OC)C(=C6)OC)OC)C=C5OC)OC)C=C4OC)OC)C=C3OC)OC)OC",
    note: "The per-methoxy pillar[6]arene; kept separate from the per-hydroxy parent."
  },
  {
    id: "resorcin-4-arene", name: "Resorcin[4]arene", kind: "resorcin", n: 4,
    synonyms: ["resorcin4arene", "calix[4]resorcinarene", "calix[4]resorcarene"],
    cid: 10929046, formula: "C28H24O8",
    smiles: "C1C2=CC(=C(C=C2O)O)CC3=CC(=C(C=C3O)O)CC4=C(C=C(C(=C4)CC5=C(C=C(C1=C5)O)O)O)O",
    note: "The unsubstituted parent (bridge CH2). The common C-methyl compound is a separate entry."
  },
  {
    id: "c-methylresorcin-4-arene", name: "C-Methylresorcin[4]arene", kind: "resorcin", n: 4, bridgeMethyl: true,
    synonyms: ["C-methylcalix[4]resorcinarene", "C-methylresorcinarene", "tetramethylresorcin[4]arene"],
    cid: 3952517, formula: "C32H32O8",
    smiles: "CC1C2=CC(=C(C=C2O)O)C(C3=CC(=C(C=C3O)O)C(C4=C(C=C(C(=C4)C(C5=C(C=C(C1=C5)O)O)C)O)O)C)C",
    note: "Bridge-carbon stereo is not specified in the PubChem record, so no isomer (rccc etc.) is claimed."
  },
  {
    id: "cyclotriveratrylene", name: "Cyclotriveratrylene", kind: "ctv", n: 3, methoxy: true,
    synonyms: ["CTV", "cyclotriveratrylene host"], cid: 273730, formula: "C27H30O6",
    smiles: "COC1=C(C=C2CC3=CC(=C(C=C3CC4=CC(=C(C=C4CC2=C1)OC)OC)OC)OC)OC"
  }
];

const point = (angle, radius = 1) => ({ x: radius * Math.cos(angle), y: radius * Math.sin(angle) });

function hostLayout(entry) {
  const { kind, n } = entry;
  const halfSector = Math.PI / n;
  const pillar = kind === "pillar", ctv = kind === "ctv";
  // Intersect equal-radius circles at each pair of bridge endpoints. Calix[4]/[5] need
  // a wider lower rim for their inward OH labels: modestly lengthen the bridge bonds
  // before mean normalization (all final lengths remain within 0.85–1.15).
  // Pillararenes need the larger chord in both parent and methylated hosts: it
  // leaves a clear central aperture between their inward O-H/O-Me substituents.
  const wideLowerRim = kind === "calix" && n <= 5;
  const bridgeLength = pillar ? 1.18 : wideLowerRim ? 1.14 : 1;
  const chord = pillar ? 2.32 : wideLowerRim ? 2.2 : ctv ? Math.sqrt(3) : 1.9;
  const radialInset = pillar ? 0 : ctv ? Math.sqrt(3) / 2 : 0.5;
  const tangentReach = pillar ? 1 : ctv ? 0.5 : Math.sqrt(3) / 2;
  const radius = radialInset + (chord + 2 * tangentReach * Math.cos(halfSector)) / (2 * Math.sin(halfSector));
  const atoms = [], bonds = [], rings = [];
  const add = (element, position) => { atoms.push({ element, ...position }); return atoms.length - 1; };
  const branch = (from, element, angle, length = 1) => {
    const step = point(angle, length);
    const to = add(element, { x: atoms[from].x + step.x, y: atoms[from].y + step.y });
    bonds.push([from, to, 1]);
    return to;
  };
  for (let unit = 0; unit < n; unit += 1) {
    const theta = Math.PI / 2 + unit * 2 * halfSector;
    const centre = point(theta, radius);
    const orientation = theta + (pillar ? Math.PI / 2 : ctv ? Math.PI - Math.PI / 6 : Math.PI);
    const ring = Array.from({ length: 6 }, (_, vertex) => {
      const offset = point(orientation + vertex * Math.PI / 3);
      return add("C", { x: centre.x + offset.x, y: centre.y + offset.y });
    });
    for (let vertex = 0; vertex < 6; vertex += 1) {
      bonds.push([ring[vertex], ring[(vertex + 1) % 6], vertex % 2 === 0 ? 2 : 1]);
    }
    rings.push(ring);
    const oxygenVertices = pillar ? [1, 4] : ctv ? [3, 4] : kind === "resorcin" ? [2, 4] : [0];
    for (const vertex of oxygenVertices) {
      // Turn the calixarene OH bonds together by 30 degrees, separating their
      // full OH/HO labels without changing the classic radial benzene skeleton.
      const angle = orientation + vertex * Math.PI / 3 + (kind === "calix" ? Math.PI / 6 : 0);
      const oxygen = branch(ring[vertex], "O", angle);
      // Bend C-O-C by 120 degrees. Eight unit bonds plus two bridge bonds per
      // pillar unit give skeletal mean 0.8 + 0.2 * bridgeLength. Giving the added
      // O-Me bond that length prevents mean normalization from resizing the
      // parent skeleton when methyls are added (only bbox centring can change).
      if (entry.methoxy) branch(oxygen, "C", angle + Math.PI / 3, pillar ? 0.8 + 0.2 * bridgeLength : 1);
    }
    if (entry.tertButyl) {
      const angle = orientation + Math.PI;
      const carbon = branch(ring[3], "C", angle);
      // Three explicit methyl branches, without abbreviation atoms.
      for (const turn of [-Math.PI / 2, 0, Math.PI / 2]) branch(carbon, "C", angle + turn);
    }
  }
  for (let unit = 0; unit < n; unit += 1) {
    const next = (unit + 1) % n;
    const from = rings[unit][pillar ? 0 : ctv ? 0 : 5];
    const to = rings[next][pillar ? 3 : 1];
    const a = atoms[from], b = atoms[to];
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const angle = Math.PI / 2 + (unit + 0.5) * 2 * halfSector;
    const offset = point(angle, Math.sqrt(bridgeLength * bridgeLength - chord * chord / 4));
    const bridge = add("C", { x: midpoint.x + offset.x, y: midpoint.y + offset.y });
    bonds.push([from, bridge, 1], [bridge, to, 1]);
    // Plain bonds deliberately leave bridge-carbon stereo unspecified.
    if (entry.bridgeMethyl) branch(bridge, "C", angle + Math.PI);
  }
  return finishLayout({ atoms, bonds });
}

export const generator = {
  scriptName: "calixarenes-pillararenes.mjs",
  fileName: "calixarenesPillararenes.ts",
  exportName: "calixarenesPillararenesTemplates",
  generateTemplates: () => entries.map((entry) => ({
    id: entry.id, name: entry.name, synonyms: entry.synonyms,
    family: "calixarenes-pillararenes", category: "supramolecular",
    smiles: entry.smiles, formula: entry.formula, charge: 0,
    source: { database: "PubChem", cid: entry.cid },
    ...(entry.note ? { note: entry.note } : {}), layout: hostLayout(entry)
  }))
};

runFamilyIfMain(import.meta.url, generator);
