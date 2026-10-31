// Original rule-built cone, in ideal bond units. No external coordinates.
import { projectOrthographic, cueBondDepth, orderBondsByDepth } from "./geometry.mjs";
const radians = (degrees) => degrees * Math.PI / 180;

export const coneParameters = {
  tilt: 25, elevation: 18, bridgeAngle: 112, bridgePitch: 0, oxygenSplay: 10, oxygenTwist: 0,
  butylFan: 45, azimuthFraction: { odd: 0.75, even: 0.5 }
};

export function coneParametersFor(n) {
  const choices = {
    // View along one ring: one face-on foreground panel, its opposite behind,
    // and equal-depth end panels. Frame the depth plane ahead of the end rings;
    // the original 3D midpoint rule and 0.15 dead zone remain unchanged.
    4: { tilt: 3, elevation: 6.5, bridgeAngle: 132, bridgePitch: -100, butylFan: 45, fraction: 0,
      cameraDepthOffset: 0.85, screenPanelYaws: [-9.5, 0, 9.5, 0],
      screenShifts: [0, -0.515, 0, 0.515], screenFanSpreads: { 0: 0.6, 2: 0.6 },
      rearShift: 0, rimLevelling: 0.7 },
    // Retain the pentamer's carbon placement; its saturating depth-length curve
    // below separates the vertical OH labels without moving the aryl units.
    5: { tilt: 33.5, elevation: 21.5, bridgeAngle: 121, bridgePitch: 70, butylFan: 50, fraction: 0.75,
      rimLevelling: 0.73 },
    6: { tilt: 24, elevation: 7, bridgeAngle: 123, bridgePitch: 45, butylFan: 66, fraction: 0.5, rearShift: -0.59,
      // Retain the two-height stagger's original carbon framework and junctions;
      // no depth-length placement corrections are applied to n = 6 or 8.
      screenShifts: [0.04, 0.10, -0.08, 0.09, -0.07, -0.12],
      screenYShifts: [0, 0.11, -0.05, -0.04, 0.10, 0],
      screenBridgeOffsets: [{ x: -0.10, y: -0.01 }, { x: 0.05, y: -0.04 },
        { x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0.08 }],
      drop: 0.65 },
    // Keep the 9° camera, original panel orientations and two-height OH rows.
    8: { tilt: 11, elevation: 9, bridgeAngle: 125, bridgePitch: 65, butylFan: 57.5, fraction: 0.5, rearShift: -0.55,
      screenShifts: [0.092, 0.042, -0.042, -0.092, 0.118, 0.168, -0.168, -0.118],
      screenYShifts: [0, 0.011, 0.011, 0, -0.003, 0, 0, -0.003],
      screenBridgeOffsets: [{ x: 0.001, y: 0.022 }, { x: 0, y: -0.012 }, { x: -0.001, y: 0.022 }],
      drop: 0.60, rimLevelling: 0.2 }
  };
  const p = choices[n] ?? {};
  return { ...coneParameters, ...p,
    azimuthFractions: { [n]: p.fraction ?? (n % 2 ? 0.75 : 0.5) } };
}

const add3 = (a, b, s = 1) => ({ x: a.x + s * b.x, y: a.y + s * b.y, z: a.z + s * b.z });
const scale3 = (a, s) => ({ x: a.x * s, y: a.y * s, z: a.z * s });
const dot3 = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const unit3 = (a) => scale3(a, 1 / Math.sqrt(dot3(a, a)));

export function coneAzimuth(n, parameters = coneParameters) {
  const fraction = parameters.azimuthFractions?.[n]
    ?? (n % 2 ? parameters.azimuthFraction.odd : parameters.azimuthFraction.even);
  return fraction * 360 / n;
}

export function calixareneConeModel(n, tertButyl, parameters = coneParameters) {
  const { tilt: tiltDegrees, bridgeAngle, oxygenSplay, oxygenTwist = 0, butylFan } = parameters;
  const tilt = radians(tiltDegrees), sector = Math.PI / n;
  const atoms = [], bonds = [], rings = [];
  const add = (element, p) => { atoms.push({ element, x: p.x, y: p.y, z: p.z }); return atoms.length - 1; };
  const branch = (from, direction, element = "C") => {
    const to = add(element, add3(atoms[from], direction));
    bonds.push([from, to, 1]);
    return to;
  };
  const frame = (theta) => {
    const radial = { x: Math.cos(theta), y: Math.sin(theta), z: 0 };
    const tangent = { x: -Math.sin(theta), y: Math.cos(theta), z: 0 };
    const up = { x: Math.sin(tilt) * radial.x, y: Math.sin(tilt) * radial.y, z: Math.cos(tilt) };
    const direction = (u, t, r = 0, z = 0) => ({ x: u * up.x + t * tangent.x + r * radial.x,
      y: u * up.y + t * tangent.y + r * radial.y, z: u * up.z + z });
    return { radial, tangent, up, direction };
  };
  // Ortho exterior bisector, in the ring plane, and the bridge mirror plane's normal.
  const local = frame(0);
  const orthoOut = local.direction(-0.5, Math.sqrt(3) / 2);
  const mirror = { x: -Math.sin(sector), y: Math.cos(sector), z: 0 };
  const orthoAcross = dot3(orthoOut, mirror);
  const halfChord = Math.sin(radians(bridgeAngle) / 2);
  const radius = (halfChord + orthoAcross) / Math.sin(sector);
  const azimuth = radians(coneAzimuth(n, parameters));
  for (let unit = 0; unit < n; unit++) {
    const { radial, up, direction } = frame(azimuth + 2 * sector * unit);
    const centre = scale3(radial, radius);
    const ring = Array.from({ length: 6 }, (_, vertex) => {
      const angle = vertex * Math.PI / 3;
      return add("C", add3(centre, direction(-Math.cos(angle), Math.sin(angle))));
    });
    for (let vertex = 0; vertex < 6; vertex++) {
      bonds.push([ring[vertex], ring[(vertex + 1) % 6], vertex % 2 === 0 ? 2 : 1]);
    }
    rings.push(ring);
    const splay = radians(oxygenSplay), twist = radians(oxygenTwist);
    branch(ring[0], direction(0, Math.sin(twist) * Math.cos(splay), Math.sin(splay),
      -Math.cos(splay) * Math.cos(twist)), "O");
    if (tertButyl) {
      const carbon = branch(ring[3], up);
      for (const turn of [-butylFan, 0, butylFan]) {
        const angle = radians(turn);
        branch(carbon, direction(Math.cos(angle), Math.sin(angle)));
      }
    }
  }
  for (let unit = 0; unit < n; unit++) {
    const from = rings[unit][1], to = rings[(unit + 1) % n][5];
    const a = atoms[from], b = atoms[to];
    const mid = scale3(add3(a, b), 0.5);
    const across = unit3({ x: b.x - a.x, y: b.y - a.y, z: b.z - a.z });
    let pitch;
    if (parameters.bridgePitch === undefined) {
      // In the mirror plane, as close to the first ortho bisector as the bridge angle allows.
      const outward = add3(atoms[from], frame(azimuth + 2 * sector * unit).direction(-0.5, Math.sqrt(3) / 2));
      const toward = { x: outward.x - mid.x, y: outward.y - mid.y, z: outward.z - mid.z };
      pitch = unit3(add3(toward, across, -dot3(toward, across)));
    } else {
      const phi = azimuth + 2 * sector * unit + sector, q = radians(parameters.bridgePitch);
      pitch = { x: Math.cos(q) * Math.cos(phi), y: Math.cos(q) * Math.sin(phi), z: Math.sin(q) };
    }
    const bridge = add("C", add3(mid, pitch, Math.cos(radians(bridgeAngle) / 2)));
    bonds.push([from, bridge, 1], [bridge, to, 1]);
  }
  // Camera framing can move the middle plane along the view normal without
  // changing the regular, rotationally identical unit-bond construction.
  if (parameters.cameraDepthOffset !== undefined) {
    const e = radians(parameters.elevation), offset = parameters.cameraDepthOffset;
    return { atoms, bonds, centre: { x: 0, y: -offset * Math.cos(e), z: -offset * Math.sin(e) } };
  }
  return { atoms, bonds };
}

/**
 * Orthographic cone followed by the declared textbook adjustments. The camera's
 * oriented normal faces the broad front panels, not the narrow panels at the ends.
 * Styling and stacking use the original 3D midpoint depths, before screen edits.
 */
export function projectCone(model, elevation = coneParameters.elevation, options = {}) {
  const projected = orderBondsByDepth(cueBondDepth(projectOrthographic(model, { elevation, viewerSide: -1, centre: model.centre })));
  const original = projected.atoms.map(atom => ({ ...atom }));
  const n = model.atoms.filter(atom => atom.element === "O").length;
  const size = (model.atoms.length - n) / n;
  const rearShift = options.rearShift ?? -0.5;
  for (let unit = 0; unit < n; unit++) {
    const start = unit * size;
    const yaw = radians(options.screenPanelYaws?.[unit] ?? 0);
    if (yaw !== 0) {
      // Textbook screen splay exposes both sides of an otherwise edge-on
      // panel. The source cone stays regular; cosmetic depth was fixed above.
      const ring = model.atoms.slice(start, start + 6);
      const cx = ring.reduce((sum, atom) => sum + atom.x / 6, 0);
      const cy = ring.reduce((sum, atom) => sum + atom.y / 6, 0);
      const atoms = model.atoms.slice(start, start + size).map(atom => ({ ...atom,
        x: cx + (atom.x - cx) * Math.cos(yaw) - (atom.y - cy) * Math.sin(yaw),
        y: cy + (atom.x - cx) * Math.sin(yaw) + (atom.y - cy) * Math.cos(yaw) }));
      const screen = projectOrthographic({ atoms }, { elevation, centre: model.centre }).atoms;
      for (let i = 0; i < size; i++) {
        projected.atoms[start + i].x = screen[i].x;
        projected.atoms[start + i].y = screen[i].y;
      }
    }
    // Shift whole units, never individual ring vertices. These declared screen
    // adjustments leave each panel rigid and its original depth marks intact.
    const stationY = model.atoms.slice(start, start + 6).reduce((sum, atom) => sum + atom.y / 6, 0);
    const dy = stationY * Math.sin(radians(elevation)) * (options.rimLevelling ?? 0)
      + (options.screenYShifts?.[unit] ?? 0);
    for (let i = start; i < start + size; i++) projected.atoms[i].y += dy;
    const shift = options.screenShifts?.[unit] ?? 0;
    for (let i = start; i < start + size; i++) projected.atoms[i].x += shift;
    if (n % 2 === 0 && model.atoms[start].y < 0) {
      // Choose the near-half displacement from the unshifted projection, so a
      // small screen translation cannot flip a central unit to the other side.
      const dx = Math.abs(original[start].x) < 0.01 ? rearShift : Math.sign(original[start].x) * rearShift;
      for (let i = start; i < start + size; i++) projected.atoms[i].x += dx;
    }
    // A declared textbook fan opening keeps the end tBu groups readable when
    // their benzene planes are almost edge-on. Depth and stacking still come
    // from the original regular 3D model, before all screen adjustments.
    const fanSpread = options.screenFanSpreads?.[unit];
    if (size === 11 && fanSpread !== undefined) {
      const centre = projected.atoms[start + 7].x;
      projected.atoms[start + 8].x = centre - fanSpread;
      projected.atoms[start + 10].x = centre + fanSpread;
    }
  }
  // Keep each CH2 junction between the displaced units without moving its atom alone.
  for (let unit = 0; unit < n; unit++) {
    const a = unit * size + 1, b = ((unit + 1) % n) * size + 5;
    for (const axis of ["x", "y"]) projected.atoms[n * size + unit][axis] +=
      ((projected.atoms[a][axis] - original[a][axis]) + (projected.atoms[b][axis] - original[b][axis])) / 2;
  }
  // Explicit junction offsets clear carbon corners after whole-unit placement.
  // They change neither connectivity nor the original 3D depth/stacking decision.
  for (let unit = 0; unit < n; unit++) {
    const offset = options.screenBridgeOffsets?.[unit];
    if (offset) {
      projected.atoms[n * size + unit].x += offset.x;
      projected.atoms[n * size + unit].y += offset.y;
    }
  }
  const units = Array.from({ length: n }, (_, unit) => ({ ipso: unit * size, oxygen: unit * size + 6 }))
    .sort((a, b) => projected.atoms[a.ipso].x - projected.atoms[b.ipso].x);
  const nominal = Math.max(...projected.bonds.filter(([a, b]) =>
    projected.atoms[a].element === "C" && projected.atoms[b].element === "C")
    .map(([a, b]) => Math.hypot(projected.atoms[a].x - projected.atoms[b].x,
      projected.atoms[a].y - projected.atoms[b].y)));
  if (n === 4 || n === 5) {
    // Depth-length OH for the tetramer and pentamer. Use the
    // original ring depths, before screen edits; the pentamer's curve saturates.
    const depths = units.map(unit => original.slice(unit.ipso, unit.ipso + 6)
      .reduce((sum, atom) => sum + atom.depth / 6, 0));
    const far = Math.min(...depths), near = Math.max(...depths);
    const short = options.oxygenLength?.short ?? (n === 5 ? 0.79 : 0.78);
    const long = options.oxygenLength?.long ?? 1.99;
    for (const [index, unit] of units.entries()) {
      const t = (depths[index] - far) / (near - far);
      const fraction = n === 5 ? -Math.expm1(-8 * t) / -Math.expm1(-8) : t;
      projected.atoms[unit.oxygen].x = projected.atoms[unit.ipso].x;
      projected.atoms[unit.oxygen].y = projected.atoms[unit.ipso].y - nominal * (short + (long - short) * fraction);
    }
  } else {
    // Larger cones retain the two-height stagger: foreground upper, rear lower.
    // Only oxygen positions change here; the original ring/CH2 placement stays.
    const bottom = Math.min(...units.map(unit => projected.atoms[unit.ipso].y));
    for (const unit of units) {
      const front = original.slice(unit.ipso, unit.ipso + 6).reduce((sum, atom) => sum + atom.depth, 0) > 0;
      projected.atoms[unit.oxygen].x = projected.atoms[unit.ipso].x;
      projected.atoms[unit.oxygen].y = bottom - nominal * ((options.drop ?? 0.65) + (front ? 0 : 1.09));
    }
  }
  // Every adjusted C–O is declared, including those shortened by
  // splay. Endpoints stay joined by one straight bond; no hidden atoms or elbows.
  return { bonds: projected.bonds, atoms: projected.atoms.map(({ depth: _depth, ...atom }) => atom),
    stretchedBonds: units.map(({ ipso, oxygen }) => [ipso, oxygen]) };
}
