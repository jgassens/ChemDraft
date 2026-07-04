#!/usr/bin/env node
// Headless regression for continuous-drag spin/jitter (CHEMDRAFT_ENGINE3D_CONTINUOUS_DRAG).
//
// Continuous mode preserves FIRE optimizer state across updateDrag frames. The risk is the
// interaction between that persistent momentum and the per-frame Kabsch rigid-body removal:
// if either regresses, the bulk atoms slowly rotate/translate while the user merely holds an
// atom in place — invisible to the 5-frame real-structure smoke, so this script holds the
// dragged atom at one FIXED target for many frames and checks accumulation.
//
// Signal design: atoms OUTSIDE the sidecar's drag mobile shell are frozen by the optimizer
// mask, so ONLY the Kabsch alignment can move them — their motion is pure rigid-body drift,
// uncontaminated by legitimate shell relaxation. Healthy behavior (measured on the default
// 43-atom cyanine fixture): the frozen set is carried a small bounded amount while the shell
// relaxes (~0.13 centroid / ~2.1 deg / ~0.67 max atom), then SATURATES once energy plateaus
// (frames 100->200 add under 0.005 / 0.01 deg). A momentum/alignment regression ratchets
// instead: drift keeps growing with every frame and blows through the late-growth caps.
//
// The deterministic (flag off) mode runs the same transcript as a control with the absolute
// caps only: its cold-restart optimizer legitimately keeps creeping toward the minimum for
// hundreds of frames, so the saturation invariant is asserted only for continuous mode.
//
// Caps are calibrated for the DEFAULT fixture; if you pass --smiles you are exploring, and
// should expect to re-derive caps before trusting failures.
import {
  argValue,
  resolveSidecarPath,
  createFixtureFromSmiles,
  outwardDragTarget,
  createTranscript,
  runSidecar,
  parseProtocolLines,
  commitResponse,
  coordinateEvents,
  bulkDriftStats,
  assertAllCoordinatesFinite,
  distance,
  formatCoord,
  fail
} from "./engine3d-smoke-lib.mjs";

const defaultSmiles = String.raw`CCN1/C(=C\C=C\C=C\C=C\C2=[N+](C3=C(C2)C=C(C=C3)S(=O)(=O)[O-])CCCCCC(=O)O)/CC4=C1C=CC(=C4)S(=O)(=O)O`;

const sidecarPath = resolveSidecarPath();
const smiles = argValue("--smiles", defaultSmiles);
const selectedAtomNumber = Number(argValue("--selected-atom", "2"));
const targetScale = Number(argValue("--target-scale", "1.7"));
const targetZ = Number(argValue("--target-z", "0.85"));
const holdFrames = Number(argValue("--hold-frames", "200"));
const approachFrames = 5;

// Must mirror the sidecar's updateDrag mobile shell (localDragMobileAtoms radius 4): atoms
// beyond this graph distance from the dragged atom are mask-frozen during drag frames.
const dragMobileShellRadius = 4;

// Absolute caps on frozen-set drift at EVERY held frame (~2-3x the healthy plateau).
const absoluteCaps = {
  centroidDrift: 0.3,
  meanRotationDeg: 4.0,
  maxRotationDeg: 5.5,
  maxAtomDrift: 1.2,
  heldTargetMiss: 0.01
};

// Saturation caps for continuous mode: drift added between the hold midpoint and the final
// held frame. Healthy runs add ~0.001-0.01; a ratchet of even 0.005 deg/frame adds ~0.5 deg
// over the late window and fails.
const lateGrowthCaps = {
  centroidDrift: 0.03,
  meanRotationDeg: 0.3,
  maxAtomDrift: 0.06
};

if (holdFrames < 40) {
  fail("--hold-frames must be at least 40 for the saturation window to be meaningful.");
}

const fixture = createFixtureFromSmiles(smiles, selectedAtomNumber);
const targetCoord = outwardDragTarget(fixture, targetScale, targetZ);
const transcript = createTranscript(fixture, targetCoord, { approachFrames, holdFrames });
const frozenAtomIds = atomsOutsideMobileShell(fixture, dragMobileShellRadius);
if (frozenAtomIds.length < 3) {
  fail(`Fixture too small: only ${frozenAtomIds.length} atoms outside the drag mobile shell; the frozen-set drift signal needs at least 3.`);
}

const modes = [
  { label: "continuous", assertSaturation: true, env: { CHEMDRAFT_ENGINE3D_CONTINUOUS_DRAG: "1", CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE: undefined } },
  { label: "deterministic", assertSaturation: false, env: { CHEMDRAFT_ENGINE3D_CONTINUOUS_DRAG: undefined, CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE: undefined } }
];

for (const mode of modes) {
  const { stdout, stderr, code, signal } = await runSidecar(sidecarPath, transcript, mode.env);
  if (code !== 0) {
    fail(`[${mode.label}] Sidecar exited with ${signal ?? code}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`);
  }
  assertHoldSteady(mode.label, mode.assertSaturation, parseProtocolLines(stdout));
}

console.log(
  `Engine 3D hold-steady smoke passed: ${fixture.atomIds.length} atoms ` +
  `(${frozenAtomIds.length} frozen outside shell radius ${dragMobileShellRadius}), ` +
  `${holdFrames} held frames, both drag modes within caps.`
);

function assertHoldSteady(label, assertSaturation, messages) {
  for (const required of ["ready", "coordinatesChanged", "energyChanged", "selectionChanged", "closed"]) {
    if (!messages.some((message) => message.type === "event" && message.eventType === required)) {
      fail(`[${label}] Missing required event ${required}.`);
    }
  }

  const dragEvents = coordinateEvents(messages, "drag");
  const expectedFrames = approachFrames + holdFrames;
  if (dragEvents.length !== expectedFrames) {
    fail(`[${label}] Expected ${expectedFrames} drag frames, got ${dragEvents.length}.`);
  }
  for (const event of dragEvents) {
    assertAllCoordinatesFinite(fixture, event.coords3dByAtomId, `[${label}] drag frame`);
  }

  const commit = commitResponse(messages);
  if (commit.result.graphSignature !== fixture.graphSignature || commit.result.bondSignature !== fixture.bondSignature) {
    fail(`[${label}] Commit changed graph/bond signature.`);
  }
  assertAllCoordinatesFinite(fixture, commit.result.coords3dByAtomId, `[${label}] commit`);

  // The approach's final frame is the first frame AT the fixed target: the hold baseline.
  const holdStart = dragEvents[approachFrames - 1].coords3dByAtomId;
  const heldEvents = dragEvents.slice(approachFrames);

  const statsByFrame = [];
  let worstTargetMiss = 0;
  for (const [heldIndex, event] of heldEvents.entries()) {
    const coords = event.coords3dByAtomId;
    // frozenAtomIds never contains the dragged atom, so the stats cover exactly the frozen set.
    const stats = bulkDriftStats(frozenAtomIds, fixture.selectedAtomId, holdStart, coords);
    statsByFrame.push(stats);
    const targetMiss = distance(coords[fixture.selectedAtomId], targetCoord);
    worstTargetMiss = Math.max(worstTargetMiss, targetMiss);

    const frameLabel = `[${label}] held frame ${heldIndex + 1}/${heldEvents.length}`;
    if (targetMiss > absoluteCaps.heldTargetMiss) {
      fail(`${frameLabel}: dragged atom left the held target by ${targetMiss.toFixed(4)} (cap ${absoluteCaps.heldTargetMiss}). target ${formatCoord(targetCoord)}, got ${formatCoord(coords[fixture.selectedAtomId])}.`);
    }
    if (stats.centroidDrift > absoluteCaps.centroidDrift) {
      fail(`${frameLabel}: frozen-set centroid drifted ${stats.centroidDrift.toFixed(4)} (cap ${absoluteCaps.centroidDrift}).`);
    }
    if (stats.meanRotationDeg > absoluteCaps.meanRotationDeg || stats.maxRotationDeg > absoluteCaps.maxRotationDeg) {
      fail(`${frameLabel}: frozen set rotated mean ${stats.meanRotationDeg.toFixed(3)} deg / max ${stats.maxRotationDeg.toFixed(3)} deg (caps ${absoluteCaps.meanRotationDeg}/${absoluteCaps.maxRotationDeg}).`);
    }
    if (stats.maxAtomDrift > absoluteCaps.maxAtomDrift) {
      fail(`${frameLabel}: frozen atom drifted ${stats.maxAtomDrift.toFixed(4)} (cap ${absoluteCaps.maxAtomDrift}).`);
    }
  }

  const midpoint = statsByFrame[Math.floor(statsByFrame.length / 2)];
  const final = statsByFrame[statsByFrame.length - 1];
  if (assertSaturation) {
    const growth = {
      centroidDrift: final.centroidDrift - midpoint.centroidDrift,
      meanRotationDeg: final.meanRotationDeg - midpoint.meanRotationDeg,
      maxAtomDrift: final.maxAtomDrift - midpoint.maxAtomDrift
    };
    for (const [key, cap] of Object.entries(lateGrowthCaps)) {
      if (growth[key] > cap) {
        fail(`[${label}] Frozen-set drift did not saturate: ${key} grew ${growth[key].toFixed(4)} between hold midpoint and end (cap ${cap}). Midpoint ${midpoint[key].toFixed(4)}, final ${final[key].toFixed(4)}.`);
      }
    }

    // Energy must relax (or hold) across the held frames, never climb: energyChanged events
    // are [createSession, one per drag frame..., settle].
    const energies = messages
      .filter((message) => message.type === "event" && message.eventType === "energyChanged")
      .map((message) => message.forceField?.energy);
    const firstHeldEnergy = energies[1 + approachFrames];
    const lastHeldEnergy = energies[1 + approachFrames + holdFrames - 1];
    if (!Number.isFinite(firstHeldEnergy) || !Number.isFinite(lastHeldEnergy)) {
      fail(`[${label}] Held-frame energies are not finite: first ${firstHeldEnergy}, last ${lastHeldEnergy}.`);
    }
    if (lastHeldEnergy > firstHeldEnergy + 1e-6) {
      fail(`[${label}] Energy climbed during the hold: ${firstHeldEnergy.toFixed(3)} -> ${lastHeldEnergy.toFixed(3)}.`);
    }
  }

  console.log(
    `[${label}] ${heldEvents.length} held frames: frozen-set drift centroid ${final.centroidDrift.toFixed(4)}, ` +
    `rotation mean ${final.meanRotationDeg.toFixed(3)}/max ${final.maxRotationDeg.toFixed(3)} deg, ` +
    `max atom ${final.maxAtomDrift.toFixed(4)}; mid->end growth ${(final.maxAtomDrift - midpoint.maxAtomDrift).toFixed(4)}; ` +
    `target miss ${worstTargetMiss.toFixed(5)}.`
  );
}

function atomsOutsideMobileShell(fixtureData, radius) {
  const distances = new Map([[fixtureData.selectedAtomId, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const bond of fixtureData.bonds) {
      const a = distances.get(bond.fromAtomId);
      const b = distances.get(bond.toAtomId);
      if (a !== undefined && (b === undefined || b > a + 1)) {
        distances.set(bond.toAtomId, a + 1);
        changed = true;
      }
      if (b !== undefined && (a === undefined || a > b + 1)) {
        distances.set(bond.fromAtomId, b + 1);
        changed = true;
      }
    }
  }
  return fixtureData.atomIds.filter((atomId) => (distances.get(atomId) ?? Infinity) > radius);
}
