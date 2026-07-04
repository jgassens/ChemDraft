#!/usr/bin/env node
// Headless A/B proof that the annealed settle (CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE) lowers the
// final energy on a FLEXIBLE molecule. The real-structure smoke's cyanine fixture is rigid —
// its torsion trials never improve, so that smoke only proves the anneal is a safe no-op.
// This smoke folds an n-octane chain into a strained torsion basin the deterministic settle
// cannot escape (a local relax never crosses a torsion barrier), runs the identical
// transcript with the anneal off and on, and asserts:
//   1. anneal-on final energy <= anneal-off final energy (always), and
//   2. for the default fixture, a strict improvement of at least --min-improvement kJ/mol
//      (measured ~9.2 on the pinned fold; the cap keeps 9x margin), with
//   3. geometry still safe in both runs (finite, bonds near their relaxed lengths, no
//      nonbonded collapse, radius of gyration sane).
// Pass --min-improvement 0 when exploring other fixtures with --smiles.
import {
  argValue,
  resolveSidecarPath,
  createFixtureFromSmiles,
  foldDragTarget,
  createTranscript,
  runSidecar,
  parseProtocolLines,
  commitResponse,
  coordinateEvents,
  relaxedBaseline,
  annealTrialCount,
  assertAllCoordinatesFinite,
  minNonbondedDistance,
  radiusOfGyration,
  distance,
  fail
} from "./engine3d-smoke-lib.mjs";

const sidecarPath = resolveSidecarPath();
const smiles = argValue("--smiles", "CCCCCCCC");
const selectedAtomNumber = Number(argValue("--selected-atom", "1"));
const foldTowardAtomNumber = Number(argValue("--fold-toward-atom", "6"));
const foldFraction = Number(argValue("--fold-fraction", "0.8"));
const targetZ = Number(argValue("--target-z", "0.6"));
const minImprovement = Number(argValue("--min-improvement", "1.0"));

const fixture = createFixtureFromSmiles(smiles, selectedAtomNumber);
const targetCoord = foldDragTarget(fixture, foldTowardAtomNumber, foldFraction, targetZ);
const transcript = createTranscript(fixture, targetCoord, { approachFrames: 5, holdFrames: 0 });

// Same transcript, anneal off vs on. Continuous drag stays off in both runs so the energy
// delta is attributable to the anneal alone; timing stays on for the trials count.
const runs = [
  { label: "anneal-off", env: { CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE: undefined } },
  { label: "anneal-on", env: { CHEMDRAFT_ENGINE3D_ANNEAL_SETTLE: "1" } }
];
const results = {};
for (const run of runs) {
  const { stdout, stderr, code, signal } = await runSidecar(sidecarPath, transcript, {
    ...run.env,
    CHEMDRAFT_ENGINE3D_CONTINUOUS_DRAG: undefined,
    CHEMDRAFT_ENGINE3D_TIMING: "1"
  });
  if (code !== 0) {
    fail(`[${run.label}] Sidecar exited with ${signal ?? code}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`);
  }
  const messages = parseProtocolLines(stdout);
  results[run.label] = {
    energy: assertSafeSettledRun(run.label, messages),
    trials: annealTrialCount(stderr)
  };
}

const offEnergy = results["anneal-off"].energy;
const onEnergy = results["anneal-on"].energy;
if (results["anneal-off"].trials !== null) {
  fail(`anneal-off run unexpectedly ran ${results["anneal-off"].trials} torsion trials; the env override leaked.`);
}
if (onEnergy > offEnergy + 1e-6) {
  fail(`Annealed settle RAISED the final energy: off ${offEnergy.toFixed(3)} -> on ${onEnergy.toFixed(3)} kJ/mol.`);
}
if (offEnergy - onEnergy < minImprovement) {
  fail(
    `Annealed settle did not improve energy by at least ${minImprovement} kJ/mol on the flexible fixture: ` +
    `off ${offEnergy.toFixed(3)} -> on ${onEnergy.toFixed(3)} (delta ${(onEnergy - offEnergy).toFixed(3)}). ` +
    `Either the torsion trials regressed or the fixture stopped exercising them.`
  );
}

console.log(`Engine 3D anneal-energy smoke passed: ${fixture.atomIds.length}-atom flexible fixture (${smiles}).`);
console.log(`Final energy anneal-off ${offEnergy.toFixed(3)} kJ/mol -> anneal-on ${onEnergy.toFixed(3)} kJ/mol (improvement ${(offEnergy - onEnergy).toFixed(3)}, required >= ${minImprovement}).`);
console.log(`Anneal torsion trials: ${results["anneal-on"].trials ?? "not reported"}.`);

// Shared safety assertions for one run; returns the committed final energy.
function assertSafeSettledRun(label, messages) {
  for (const reason of ["embed", "initial-relax", "drag", "settle"]) {
    if (coordinateEvents(messages, reason).length === 0) {
      fail(`[${label}] Missing coordinatesChanged reason ${reason}.`);
    }
  }

  const commit = commitResponse(messages);
  if (commit.result.graphSignature !== fixture.graphSignature || commit.result.bondSignature !== fixture.bondSignature) {
    fail(`[${label}] Commit changed graph/bond signature.`);
  }
  const finalCoords = commit.result.coords3dByAtomId;
  assertAllCoordinatesFinite(fixture, finalCoords, `[${label}] commit`);

  // Compare bonds against the relaxed baseline geometry, not the OCL 2D embed: the relaxed
  // frame is the first physically meaningful geometry of the session.
  const baseline = relaxedBaseline(messages);
  assertAllCoordinatesFinite(fixture, baseline, `[${label}] baseline`);
  for (const bond of fixture.bonds) {
    const restLength = distance(baseline[bond.fromAtomId], baseline[bond.toAtomId]);
    const finalLength = distance(finalCoords[bond.fromAtomId], finalCoords[bond.toAtomId]);
    if (restLength > 1e-6 && Math.abs(finalLength / restLength - 1) > 0.2) {
      fail(`[${label}] Bond ${bond.id} ended at ${finalLength.toFixed(3)} vs relaxed ${restLength.toFixed(3)} (>20% off).`);
    }
  }

  const minNonbonded = minNonbondedDistance(fixture, finalCoords);
  if (minNonbonded < 0.45) {
    fail(`[${label}] Nonbonded atoms collapsed: minimum nonbonded distance ${minNonbonded.toFixed(3)}.`);
  }

  const baselineRadius = radiusOfGyration(fixture.atomIds, baseline);
  const finalRadius = radiusOfGyration(fixture.atomIds, finalCoords);
  if (finalRadius < baselineRadius * 0.7 || finalRadius > baselineRadius * 1.4) {
    fail(`[${label}] Radius of gyration left the sane window: ${baselineRadius.toFixed(3)} -> ${finalRadius.toFixed(3)}.`);
  }

  const energy = commit.result.forceField?.energy;
  if (commit.result.forceField?.name !== "UFF" || !Number.isFinite(energy)) {
    fail(`[${label}] Commit did not report a finite UFF energy: ${JSON.stringify(commit.result.forceField)}.`);
  }
  return energy;
}
