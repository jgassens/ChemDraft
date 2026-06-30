#!/usr/bin/env node
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

const protocolVersion = 2;
const commitRequestId = "req_commit";
const defaultSmiles = String.raw`CCN1/C(=C\C=C\C=C\C=C\C2=[N+](C3=C(C2)C=C(C=C3)S(=O)(=O)[O-])CCCCCC(=O)O)/CC4=C1C=CC(=C4)S(=O)(=O)O`;
const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const OCL = desktopRequire("openchemlib");

const sidecarPath = argValue("--sidecar", process.env.CHEMDRAFT_ENGINE3D_SIDECAR);
const smiles = argValue("--smiles", defaultSmiles);
const selectedAtomNumber = Number(argValue("--selected-atom", process.env.CHEMDRAFT_ENGINE3D_SELECTED_ATOM ?? "2"));
const targetScale = Number(argValue("--target-scale", process.env.CHEMDRAFT_ENGINE3D_TARGET_SCALE ?? "1.7"));
const targetZ = Number(argValue("--target-z", process.env.CHEMDRAFT_ENGINE3D_TARGET_Z ?? "0.85"));

if (!sidecarPath) {
  fail("Missing sidecar path. Pass --sidecar /path/to/avogadro3d-sidecar or set CHEMDRAFT_ENGINE3D_SIDECAR.");
}
if (!existsSync(sidecarPath)) {
  fail(`Sidecar binary does not exist: ${sidecarPath}`);
}

const fixture = createFixtureFromSmiles(smiles, selectedAtomNumber);
const transcript = createTranscript(fixture, { targetScale, targetZ });
const { stdout, stderr, code, signal } = await runSidecar(sidecarPath, transcript);
if (code !== 0) {
  fail(`Sidecar exited with ${signal ?? code}.\nSTDERR:\n${stderr}\nSTDOUT:\n${stdout}`);
}

const messages = parseProtocolLines(stdout);
assertSmokeResult(fixture, messages);

const commit = messages.find((message) => message.type === "response" && message.requestId === commitRequestId);
const finalCoord = commit.result.coords3dByAtomId[fixture.selectedAtomId];
const forceField = commit.result.forceField;
const baselineCoords = baselineCoordinates(messages);
const finalRadius = radiusOfGyration(fixture.atomIds, commit.result.coords3dByAtomId);
const initialRadius = radiusOfGyration(fixture.atomIds, baselineCoords);
const bulk = bulkFrameStats(fixture, baselineCoords, commit.result.coords3dByAtomId);
const maxSelectedBondLength = selectedBondMaxLength(fixture, commit.result.coords3dByAtomId);
const dragCoord = lastDragCoordinates(messages)?.[fixture.selectedAtomId];
const energyText = Number.isFinite(forceField.energy)
  ? `${forceField.energy.toFixed(3)} ${forceField.energyUnits}`
  : "not reported";

console.log(`Engine 3D headless smoke passed: ${fixture.atomIds.length} atoms, ${fixture.bonds.length} bonds.`);
console.log(`Force field: ${forceField.name} (${forceField.status}), energy ${energyText}.`);
console.log(`Selected atom ${fixture.selectedAtomId} final coordinate: ${formatCoord(finalCoord)}.`);
console.log(`Drag target: ${formatCoord(fixture.targetCoord)}; drag miss ${dragCoord ? distance(dragCoord, fixture.targetCoord).toFixed(3) : "n/a"}; release miss ${distance(finalCoord, fixture.targetCoord).toFixed(3)}.`);
console.log(`Molecular radius of gyration: ${initialRadius.toFixed(3)} -> ${finalRadius.toFixed(3)}.`);
console.log(`Bulk frame: centroid drift ${bulk.centroidDrift.toFixed(4)}, orientation delta ${degrees(bulk.orientationAngle).toFixed(2)} deg, max atom drift ${bulk.maxAtomDrift.toFixed(4)}.`);
console.log(`Max selected-bond length after tug: ${maxSelectedBondLength.toFixed(3)}.`);
console.log(`Events: ${messages.filter((message) => message.type === "event").map((message) => `${message.eventType}${message.reason ? `:${message.reason}` : ""}`).join(", ")}.`);

function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${name}.`);
  }
  return value;
}

function createFixtureFromSmiles(inputSmiles, selectedAtomNumber) {
  const mol = OCL.Molecule.fromSmiles(inputSmiles);
  mol.inventCoordinates();
  const atomIds = [];
  const atoms = [];
  const coordinates = [];
  for (let index = 0; index < mol.getAllAtoms(); index += 1) {
    const id = `atom_${index + 1}`;
    atomIds.push(id);
    atoms.push({
      id,
      element: mol.getAtomLabel(index)
    });
    coordinates.push({
      x: mol.getAtomX(index),
      y: -mol.getAtomY(index),
      z: ((index % 7) - 3) * 0.08
    });
  }

  const bonds = [];
  for (let index = 0; index < mol.getAllBonds(); index += 1) {
    bonds.push({
      id: `bond_${index + 1}`,
      fromAtomId: atomIds[mol.getBondAtom(0, index)],
      toAtomId: atomIds[mol.getBondAtom(1, index)],
      order: bondOrder(mol.getBondOrder(index))
    });
  }

  const selectedAtomIndex = Number.isInteger(selectedAtomNumber)
    ? Math.max(0, Math.min(atomIds.length - 1, selectedAtomNumber - 1))
    : 1;
  const selectedAtomId = atomIds[selectedAtomIndex] ?? atomIds[0];
  const coords3dByAtomId = Object.fromEntries(atomIds.map((atomId, index) => [atomId, coordinates[index]]));
  const centroid = vectorCentroid(Object.values(coords3dByAtomId));
  const selectedCoord = coords3dByAtomId[selectedAtomId];
  const outward = normalize({
    x: selectedCoord.x - centroid.x,
    y: selectedCoord.y - centroid.y,
    z: selectedCoord.z - centroid.z
  });
  const targetCoord = {
    x: selectedCoord.x + outward.x * targetScale,
    y: selectedCoord.y + outward.y * targetScale,
    z: selectedCoord.z + targetZ
  };

  return {
    molfile: mol.toMolfile(),
    atomIds,
    atoms,
    coords3dByAtomId,
    bonds,
    graphSignature: createGraphSignature({ atoms, bonds }),
    bondSignature: createBondSignature(bonds),
    selectedAtomId,
    targetCoord
  };
}

function createTranscript(fixture) {
  const sessionId = "engine3d-session-1";
  const input = {
    molfile: fixture.molfile,
    format: "molfile-v2000",
    atomIdByMolfileIndex: fixture.atomIds,
    graphSignature: fixture.graphSignature,
    bondSignature: fixture.bondSignature,
    selectedAtomIds: [fixture.selectedAtomId],
    coords3dByAtomId: fixture.coords3dByAtomId
  };
  const start = fixture.coords3dByAtomId[fixture.selectedAtomId];
  const dragPoints = Array.from({ length: 5 }, (_, index) => {
    const t = (index + 1) / 5;
    return {
      x: start.x + (fixture.targetCoord.x - start.x) * t,
      y: start.y + (fixture.targetCoord.y - start.y) * t,
      z: start.z + (fixture.targetCoord.z - start.z) * t
    };
  });

  return [
    { protocolVersion, type: "createSession", requestId: "req_1", input },
    {
      protocolVersion,
      type: "beginDrag",
      requestId: "req_begin",
      sessionId,
      atomId: fixture.selectedAtomId
    },
    ...dragPoints.map((target, index) => ({
      protocolVersion,
      type: "updateDrag",
      requestId: `req_drag_${index + 1}`,
      sessionId,
      atomId: fixture.selectedAtomId,
      target
    })),
    {
      protocolVersion,
      type: "endDrag",
      requestId: "req_end",
      sessionId,
      atomId: fixture.selectedAtomId
    },
    { protocolVersion, type: "commit", requestId: commitRequestId, sessionId },
    { protocolVersion, type: "dispose", requestId: "req_dispose", sessionId }
  ];
}

async function runSidecar(binaryPath, messages) {
  const child = spawn(binaryPath, ["--stdio"], {
    stdio: ["pipe", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  for (const message of messages) {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  child.stdin.end();

  const result = await new Promise((resolve) => {
    child.on("close", (exitCode, signal) => {
      resolve({ code: exitCode, signal });
    });
  });

  return { stdout, stderr, ...result };
}

function parseProtocolLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        fail(`Invalid NDJSON line: ${line}`);
      }
    });
}

function assertSmokeResult(fixture, messages) {
  for (const required of ["ready", "coordinatesChanged", "energyChanged", "selectionChanged", "closed"]) {
    if (!messages.some((message) => message.type === "event" && message.eventType === required)) {
      fail(`Missing required event ${required}.`);
    }
  }
  const reasons = messages
    .filter((message) => message.type === "event" && message.eventType === "coordinatesChanged")
    .map((message) => message.reason);
  for (const reason of ["embed", "initial-relax", "drag", "settle"]) {
    if (!reasons.includes(reason)) {
      fail(`Missing coordinatesChanged reason ${reason}. Got ${reasons.join(", ")}.`);
    }
  }

  const ready = messages.find((message) => message.type === "event" && message.eventType === "ready");
  if (ready?.capabilities?.headlessPhysics !== true || ready?.capabilities?.frontendRendering !== true) {
    fail(`Ready capabilities did not advertise headless frontend-rendered physics: ${JSON.stringify(ready?.capabilities)}.`);
  }

  const commit = messages.find((message) => message.type === "response" && message.requestId === commitRequestId);
  if (!commit?.ok || !commit.result?.coords3dByAtomId) {
    fail(`Missing successful commit response. Got ${JSON.stringify(commit)}.`);
  }
  if (commit.result.graphSignature !== fixture.graphSignature) {
    fail("Commit graph signature changed.");
  }
  if (commit.result.bondSignature !== fixture.bondSignature) {
    fail("Commit bond signature changed.");
  }
  if (commit.result.forceField?.name !== "UFF" || commit.result.forceField?.avogadroBacked !== true) {
    fail(`Commit did not report Avogadro UFF. Got ${JSON.stringify(commit.result.forceField)}.`);
  }

  const coords = commit.result.coords3dByAtomId ?? {};
  for (const atomId of fixture.atomIds) {
    if (!coords[atomId]) {
      fail(`Commit is missing coordinates for ${atomId}.`);
    }
    if (!isFiniteCoord(coords[atomId])) {
      fail(`Commit coordinates for ${atomId} are not finite.`);
    }
  }
  for (const atomId of Object.keys(coords)) {
    if (!fixture.atomIds.includes(atomId)) {
      fail(`Commit returned unexpected atom ${atomId}.`);
    }
  }

  const baseline = baselineCoordinates(messages);
  const coordinateEvents = messages.filter((message) => message.type === "event" && message.eventType === "coordinatesChanged");
  const initialRadius = radiusOfGyration(fixture.atomIds, baseline);
  for (const event of coordinateEvents) {
    const eventCoords = event.coords3dByAtomId;
    if (!eventCoords) {
      fail(`Coordinate event ${event.requestId} did not include coords3dByAtomId.`);
    }
    const radius = radiusOfGyration(fixture.atomIds, eventCoords);
    if (radius < initialRadius * 0.82) {
      fail(`Molecule collapsed during ${event.requestId}: radius ${radius.toFixed(3)} from initial ${initialRadius.toFixed(3)}.`);
    }
    if (event.reason === "embed" || event.reason === "initial-relax") {
      continue;
    }
    const bulk = bulkFrameStats(fixture, baseline, eventCoords);
    if (bulk.centroidDrift > 0.18 || bulk.orientationAngle > radians(3.0) || bulk.maxAtomDrift > 0.42) {
      fail(`Bulk frame drifted during ${event.requestId}: centroid ${bulk.centroidDrift.toFixed(3)}, angle ${degrees(bulk.orientationAngle).toFixed(2)} deg, atom ${bulk.maxAtomDrift.toFixed(3)}.`);
    }
    const eventSelectedLength = selectedBondMaxLength(fixture, eventCoords);
    if (event.reason === "drag" && eventSelectedLength > 3.2) {
      fail(`Selected atom bonds stretched too far during ${event.requestId}: max length ${eventSelectedLength.toFixed(3)}.`);
    }
  }

  const finalCoord = coords[fixture.selectedAtomId];
  const startCoord = fixture.coords3dByAtomId[fixture.selectedAtomId];
  const requestedDragDistance = distance(startCoord, fixture.targetCoord);
  const lastDragCoords = lastDragCoordinates(messages);
  const dragCoord = lastDragCoords?.[fixture.selectedAtomId];
  if (!dragCoord) {
    fail("Missing final drag coordinate event.");
  }
  const dragTargetMiss = distance(dragCoord, fixture.targetCoord);
  if (requestedDragDistance <= 2.4 && dragTargetMiss > 0.65) {
    fail(`Dragged atom did not hold reachable target during drag: drag ${formatCoord(dragCoord)}, target ${formatCoord(fixture.targetCoord)}.`);
  }
  if (requestedDragDistance > 2.4 && distance(dragCoord, startCoord) < 0.45) {
    fail(`Dragged atom did not make clamped tug progress during drag: drag ${formatCoord(dragCoord)}, start ${formatCoord(startCoord)}, target ${formatCoord(fixture.targetCoord)}.`);
  }
  const maxSelectedLength = selectedBondMaxLength(fixture, coords);
  if (maxSelectedLength > 1.95) {
    fail(`Selected atom bonds did not relax after release: max length ${maxSelectedLength.toFixed(3)}.`);
  }
  const minNonbonded = minNonbondedDistance(fixture, coords);
  if (minNonbonded < 0.45) {
    fail(`Nonbonded atoms collapsed after tug: minimum nonbonded distance ${minNonbonded.toFixed(3)}.`);
  }
}

function baselineCoordinates(messages) {
  const initialRelax = messages.find((message) =>
    message.type === "event" &&
    message.eventType === "coordinatesChanged" &&
    message.reason === "initial-relax"
  );
  if (initialRelax?.coords3dByAtomId) {
    return initialRelax.coords3dByAtomId;
  }
  const embed = messages.find((message) =>
    message.type === "event" &&
    message.eventType === "coordinatesChanged" &&
    message.reason === "embed"
  );
  if (!embed?.coords3dByAtomId) {
    fail("Missing embed coordinates.");
  }
  return embed.coords3dByAtomId;
}

function lastDragCoordinates(messages) {
  const dragEvents = messages.filter((message) =>
    message.type === "event" &&
    message.eventType === "coordinatesChanged" &&
    message.reason === "drag"
  );
  return dragEvents.at(-1)?.coords3dByAtomId;
}

function bulkFrameStats(fixture, baseline, coords) {
  const bulkIds = stableBulkAtomIds(fixture, baseline);
  const baselineCentroid = vectorCentroid(bulkIds.map((atomId) => baseline[atomId]));
  const centroid = vectorCentroid(bulkIds.map((atomId) => coords[atomId]));
  const centroidDrift = distance(baselineCentroid, centroid);
  const maxAtomDrift = Math.max(...bulkIds.map((atomId) => distance(baseline[atomId], coords[atomId])));
  const [a, b, c] = bulkIds;
  const baseVector = normalize(subtract(baseline[b] ?? baseline[a], baseline[a]));
  const nextVector = normalize(subtract(coords[b] ?? coords[a], coords[a]));
  const baseSecond = c ? normalize(subtract(baseline[c], baseline[a])) : baseVector;
  const nextSecond = c ? normalize(subtract(coords[c], coords[a])) : nextVector;
  const orientationAngle = Math.max(vectorAngle(baseVector, nextVector), vectorAngle(baseSecond, nextSecond));
  return { centroidDrift, maxAtomDrift, orientationAngle, bulkIds };
}

function stableBulkAtomIds(fixture, coords) {
  const distances = graphDistances(fixture, fixture.selectedAtomId);
  const selected = coords[fixture.selectedAtomId];
  return fixture.atomIds
    .filter((atomId) => atomId !== fixture.selectedAtomId)
    .map((atomId) => ({
      atomId,
      graphDistance: distances.get(atomId) ?? -1,
      spatialDistance: distance(selected, coords[atomId])
    }))
    .sort((left, right) =>
      right.graphDistance - left.graphDistance ||
      right.spatialDistance - left.spatialDistance ||
      left.atomId.localeCompare(right.atomId)
    )
    .slice(0, Math.min(8, Math.max(3, fixture.atomIds.length - 1)))
    .map((entry) => entry.atomId);
}

function graphDistances(fixture, startAtomId) {
  const distances = new Map([[startAtomId, 0]]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const bond of fixture.bonds) {
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
  return distances;
}

function selectedBondMaxLength(fixture, coords) {
  const lengths = fixture.bonds
    .filter((bond) => bond.fromAtomId === fixture.selectedAtomId || bond.toAtomId === fixture.selectedAtomId)
    .map((bond) => distance(coords[bond.fromAtomId], coords[bond.toAtomId]));
  return Math.max(0, ...lengths);
}

function minNonbondedDistance(fixture, coords) {
  const bonded = new Set(fixture.bonds.flatMap((bond) => [
    `${bond.fromAtomId}|${bond.toAtomId}`,
    `${bond.toAtomId}|${bond.fromAtomId}`
  ]));
  let min = Infinity;
  for (let i = 0; i < fixture.atomIds.length; i += 1) {
    for (let j = i + 1; j < fixture.atomIds.length; j += 1) {
      const a = fixture.atomIds[i];
      const b = fixture.atomIds[j];
      if (bonded.has(`${a}|${b}`)) continue;
      min = Math.min(min, distance(coords[a], coords[b]));
    }
  }
  return min;
}

function radiusOfGyration(atomIds, coords) {
  const centroid = vectorCentroid(atomIds.map((atomId) => coords[atomId]));
  const meanSquare = atomIds.reduce((sum, atomId) => {
    const d = distance(coords[atomId], centroid);
    return sum + d * d;
  }, 0) / Math.max(1, atomIds.length);
  return Math.sqrt(meanSquare);
}

function vectorCentroid(coords) {
  const finiteCoords = coords.filter(Boolean);
  if (finiteCoords.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }
  const sum = finiteCoords.reduce((acc, coord) => ({
    x: acc.x + coord.x,
    y: acc.y + coord.y,
    z: acc.z + coord.z
  }), { x: 0, y: 0, z: 0 });
  return {
    x: sum.x / finiteCoords.length,
    y: sum.y / finiteCoords.length,
    z: sum.z / finiteCoords.length
  };
}

function subtract(a, b) {
  return {
    x: a.x - b.x,
    y: a.y - b.y,
    z: a.z - b.z
  };
}

function normalize(vector) {
  const length = Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
  if (length < 1e-9) {
    return { x: 1, y: 0, z: 0 };
  }
  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length
  };
}

function vectorAngle(a, b) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot);
}

function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function isFiniteCoord(coord) {
  return Number.isFinite(coord?.x) && Number.isFinite(coord?.y) && Number.isFinite(coord?.z);
}

function createGraphSignature({ atoms, bonds }) {
  const atomPart = atoms.map((atom) => `${atom.id}:${atom.element}`).join("|");
  return `atoms=${atomPart};bonds=${createBondSignature(bonds)}`;
}

function createBondSignature(bonds) {
  return bonds
    .map((bond) => {
      const [a, b] = [bond.fromAtomId, bond.toAtomId].sort();
      return `${a}-${b}:${bond.order ?? "unknown"}`;
    })
    .sort()
    .join("|");
}

function bondOrder(order) {
  if (order === 2) return "double";
  if (order === 3) return "triple";
  return "single";
}

function formatCoord(coord) {
  return `(${coord.x.toFixed(4)}, ${coord.y.toFixed(4)}, ${coord.z.toFixed(4)})`;
}

function degrees(radiansValue) {
  return radiansValue * 180 / Math.PI;
}

function radians(degreesValue) {
  return degreesValue * Math.PI / 180;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
