import path from "node:path";
import { fileURLToPath } from "node:url";
import { generator } from "./calixarenes-pillararenes.mjs";
import { coneParametersFor, coneAzimuth, calixareneConeModel } from "./calixarene-cone.mjs";
import { projectOrthographic } from "./geometry.mjs";

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const orientation = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const epsilon = 1e-8;
const onSegment = (a, b, p) => Math.abs(orientation(a, b, p)) <= epsilon &&
  p.x >= Math.min(a.x, b.x) - epsilon && p.x <= Math.max(a.x, b.x) + epsilon &&
  p.y >= Math.min(a.y, b.y) - epsilon && p.y <= Math.max(a.y, b.y) + epsilon;
const opposite = (a, b) => a > epsilon && b < -epsilon || a < -epsilon && b > epsilon;
const intersects = (a, b, c, d) =>
  opposite(orientation(a, b, c), orientation(a, b, d)) && opposite(orientation(c, d, a), orientation(c, d, b)) ||
  onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
function segmentDistance(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)));
  return distance(p, { x: a.x + t * dx, y: a.y + t * dy });
}

// Report all authored centreline crossings before the native renderer's ordinary crossing gaps.
export function projectionMetrics({ atoms, bonds, stretchedBonds = [] }, countCrossings = true) {
  const lengths = bonds.map(([a, b]) => distance(atoms[a], atoms[b]));
  const regular = lengths.filter((_, i) => !stretchedBonds.some(([a, b]) => {
    const [c, d] = bonds[i];
    return a === c && b === d || a === d && b === c;
  }));
  const longest = Math.max(...regular);
  const adjacent = new Set(bonds.map(([a, b]) => `${Math.min(a, b)}:${Math.max(a, b)}`));
  let atomClearance = Infinity, labelAtomClearance = Infinity, labelBondClearance = Infinity, crossings = 0;
  for (let a = 0; a < atoms.length; a++) for (let b = a + 1; b < atoms.length; b++) {
    if (adjacent.has(`${a}:${b}`)) continue;
    const gap = distance(atoms[a], atoms[b]) / longest;
    atomClearance = Math.min(atomClearance, gap);
    if (atoms[a].element !== "C" || atoms[b].element !== "C") labelAtomClearance = Math.min(labelAtomClearance, gap);
  }
  for (const [index, atom] of atoms.entries()) if (atom.element !== "C") {
    for (const [a, b] of bonds) if (index !== a && index !== b) {
      labelBondClearance = Math.min(labelBondClearance, segmentDistance(atom, atoms[a], atoms[b]) / longest);
    }
  }
  if (countCrossings) for (let i = 0; i < bonds.length; i++) for (let j = i + 1; j < bonds.length; j++) {
    const [a, b] = bonds[i], [c, d] = bonds[j];
    if (a === c || a === d || b === c || b === d) continue;
    if (intersects(atoms[a], atoms[b], atoms[c], atoms[d])) crossings++;
  }
  return { minMaxBondRatio: Math.min(...regular) / longest,
    stretchedLengths: stretchedBonds.map(([a, b]) => distance(atoms[a], atoms[b]) / longest),
    boldBonds: bonds.filter(bond => bond[3] === "bold").length,
    crossings, atomClearance, labelAtomClearance, labelBondClearance };
}

export function calixareneReview(template, variant = "B") {
  const n = template.layout.atoms.filter(atom => atom.element === "O").length;
  const p = coneParametersFor(n, variant), metrics = projectionMetrics(template.layout);
  const unitSize = template.layout.atoms.length / n - 1;
  const model = calixareneConeModel(n, unitSize === 11, p);
  const original = projectOrthographic(model, { elevation: p.elevation, viewerSide: -1, centre: model.centre });
  const depths = Array.from({ length: n }, (_, unit) => original.atoms.slice(unit * unitSize, unit * unitSize + 6)
    .reduce((sum, atom) => sum + atom.depth / 6, 0));
  const bridgeAngles = Array.from({ length: n }, (_, unit) => {
    const a = model.atoms[unit * unitSize + 1], b = model.atoms[((unit + 1) % n) * unitSize + 5];
    return 2 * Math.asin(Math.min(1, Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) / 2)) * 180 / Math.PI;
  });
  const boldBonds = template.layout.bonds.flatMap((bond, index) => bond[3] === "bold"
    ? [{ index, from: bond[0], to: bond[1], order: bond[2] }] : []);
  const rings = Array.from({ length: n }, (_, unit) => {
    const start = unit * unitSize, atoms = template.layout.atoms.slice(start, start + 6);
    const bottom = atoms[0], top = atoms[3];
    return { unit, depth: depths[unit], width: Math.max(...atoms.map(atom => atom.x)) - Math.min(...atoms.map(atom => atom.x)),
      axisFromVerticalDegrees: Math.atan2(top.x - bottom.x, top.y - bottom.y) * 180 / Math.PI,
      boldBonds: template.layout.bonds.filter(([a, b, , display]) => display === "bold"
        && a >= start && a < start + 6 && b >= start && b < start + 6).length };
  });
  const projectedBridgeAngles = Array.from({ length: n }, (_, unit) => {
    const a = template.layout.atoms[unit * unitSize + 1], b = template.layout.atoms[((unit + 1) % n) * unitSize + 5];
    const junction = template.layout.atoms[n * unitSize + unit];
    return Math.acos(Math.max(-1, Math.min(1, ((a.x - junction.x) * (b.x - junction.x)
      + (a.y - junction.y) * (b.y - junction.y)) / (distance(a, junction) * distance(b, junction))))) * 180 / Math.PI;
  });
  const oxygenBonds = template.layout.stretchedBonds.map(([from, to], index) => {
    const carbon = template.layout.atoms[from], oxygen = template.layout.atoms[to];
    const bond = template.layout.bonds.find(([a, b]) => a === from && b === to || a === to && b === from);
    const unit = from / unitSize;
    return { unit, depth: depths[unit], from, to, display: bond[3] ?? "normal", length: metrics.stretchedLengths[index],
      horizontalOffset: oxygen.x - carbon.x,
      angleFromVerticalDegrees: Math.atan2(oxygen.x - carbon.x, carbon.y - oxygen.y) * 180 / Math.PI };
  });
  const oxygens = oxygenBonds.map(({ to }) => template.layout.atoms[to]);
  return { id: template.id, variant, rings,
    ...(n === 4 ? { endToFaceWidthRatio: rings[0].width / rings[3].width } : {}),
    anglesDegrees: { tilt: p.panelTilts ?? p.tilt, inclination: p.elevation,
      azimuth: p.panelAngles ?? coneAzimuth(n, p),
      bridgeAngle: p.panelAngles ? bridgeAngles : p.bridgeAngle,
      bridgePitch: p.bridgePitches ?? p.bridgePitch, butylFan: p.butylFan, projectedBridgeAngles },
    modelCentre: model.centre ?? { x: 0, y: 0, z: 0 },
    cameraDepthOffset: p.cameraDepthOffset ?? 0,
    screenAdjustments: { panelYaws: p.screenPanelYaws ?? [], shifts: p.screenShifts ?? [],
      yShifts: p.screenYShifts ?? [], bridgeOffsets: p.screenBridgeOffsets ?? [],
      fanHalfWidths: p.screenFanSpreads ?? {}, rimLevelling: p.rimLevelling ?? 0,
      nearHalfShift: p.rearShift ?? -0.5,
      ...(n === 4 || n === 5
        ? { oxygenLength: { short: n === 5 ? 0.79 : 0.78, long: 1.99, curvature: n === 5 ? 8 : 0 } }
        : { oxygenRow: "vertical, foreground upper / rear lower", oxygenDrop: p.drop, oxygenStagger: 1.09 }),
      oxygenSpacings: oxygens.slice(1).map((atom, index) => atom.x - oxygens[index].x),
      projectedBridgeLength: p.screenBridgeLength ?? null },
    viewerSide: -1, deadZone: 0.15,
    ...metrics, boldBondCount: metrics.boldBonds, boldBonds,
    stretchedBonds: oxygenBonds,
    oxygenHeightSpread: Math.max(...oxygens.map(atom => atom.y)) - Math.min(...oxygens.map(atom => atom.y)),
    margins: { bondRatio: metrics.minMaxBondRatio - 0.35, nonbondedAtom: metrics.atomClearance - 0.30,
      labelAtom: metrics.labelAtomClearance - 0.95, labelBond: metrics.labelBondClearance - 0.75,
      stretchedLowerLimit: Math.min(...metrics.stretchedLengths) - 0.35,
      stretchedUpperLimit: 2 - Math.max(...metrics.stretchedLengths),
      verticalDegrees: 1 - Math.max(...oxygenBonds.map(bond => Math.abs(bond.angleFromVerticalDegrees))) } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--calix4-variant"), variant = index < 0 ? "B" : process.argv[index + 1];
  if (!["A", "B"].includes(variant)) throw new Error("--calix4-variant must be A or B");
  for (const template of generator.generateTemplates(variant).filter(entry => entry.projection === "perspective")) {
    console.log(JSON.stringify(calixareneReview(template, variant)));
  }
}
