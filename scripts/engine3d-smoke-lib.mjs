// Shared helpers for the Engine 3D headless smokes that need explicit sidecar env control
// (hold-steady drift regression, anneal energy A/B). The original real-structure smoke stays
// self-contained; new sibling smokes import from here instead of copying its helpers.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

export const protocolVersion = 2;
export const commitRequestId = "req_commit";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const OCL = desktopRequire("openchemlib");

export function argValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    fail(`Missing value for ${name}.`);
  }
  return value;
}

export function resolveSidecarPath() {
  const sidecarPath = argValue("--sidecar", process.env.CHEMDRAFT_ENGINE3D_SIDECAR);
  if (!sidecarPath) {
    fail("Missing sidecar path. Pass --sidecar /path/to/avogadro3d-sidecar or set CHEMDRAFT_ENGINE3D_SIDECAR.");
  }
  if (!existsSync(sidecarPath)) {
    fail(`Sidecar binary does not exist: ${sidecarPath}`);
  }
  return sidecarPath;
}

// Build atoms/bonds/coordinates from a SMILES via OCL 2D layout plus deterministic depth
// jitter, mirroring how the desktop app seeds an interactive 3D session from the drawing.
export function createFixtureFromSmiles(inputSmiles, selectedAtomNumber) {
  const mol = OCL.Molecule.fromSmiles(inputSmiles);
  mol.inventCoordinates();
  const atomIds = [];
  const atoms = [];
  const coordinates = [];
  for (let index = 0; index < mol.getAllAtoms(); index += 1) {
    const id = `atom_${index + 1}`;
    atomIds.push(id);
    atoms.push({ id, element: mol.getAtomLabel(index) });
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

  return {
    molfile: mol.toMolfile(),
    atomIds,
    atoms,
    coords3dByAtomId,
    bonds,
    graphSignature: createGraphSignature({ atoms, bonds }),
    bondSignature: createBondSignature(bonds),
    selectedAtomId
  };
}

// Outward-from-centroid drag target, matching the real-structure smoke's tug direction.
export function outwardDragTarget(fixture, targetScale, targetZ) {
  const start = fixture.coords3dByAtomId[fixture.selectedAtomId];
  const centroid = vectorCentroid(Object.values(fixture.coords3dByAtomId));
  const outward = normalize(subtract(start, centroid));
  return {
    x: start.x + outward.x * targetScale,
    y: start.y + outward.y * targetScale,
    z: start.z + targetZ
  };
}

// Fold drag target: pull the selected atom toward another atom's position. Used to push a
// flexible chain into a strained torsion basin the deterministic settle will not escape.
export function foldDragTarget(fixture, towardAtomNumber, fraction, targetZ) {
  const start = fixture.coords3dByAtomId[fixture.selectedAtomId];
  const towardId = fixture.atomIds[Math.max(0, Math.min(fixture.atomIds.length - 1, towardAtomNumber - 1))];
  const toward = fixture.coords3dByAtomId[towardId];
  return {
    x: start.x + (toward.x - start.x) * fraction,
    y: start.y + (toward.y - start.y) * fraction,
    z: start.z + targetZ
  };
}

// createSession -> beginDrag -> approach frames -> optional held frames at the final target
// -> endDrag -> commit -> dispose.
export function createTranscript(fixture, targetCoord, { approachFrames = 5, holdFrames = 0 } = {}) {
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
  const dragPoints = [];
  for (let index = 1; index <= approachFrames; index += 1) {
    const t = index / approachFrames;
    dragPoints.push({
      x: start.x + (targetCoord.x - start.x) * t,
      y: start.y + (targetCoord.y - start.y) * t,
      z: start.z + (targetCoord.z - start.z) * t
    });
  }
  for (let index = 0; index < holdFrames; index += 1) {
    dragPoints.push({ ...targetCoord });
  }

  return [
    { protocolVersion, type: "createSession", requestId: "req_1", input },
    { protocolVersion, type: "beginDrag", requestId: "req_begin", sessionId, atomId: fixture.selectedAtomId },
    ...dragPoints.map((target, index) => ({
      protocolVersion,
      type: "updateDrag",
      requestId: `req_drag_${index + 1}`,
      sessionId,
      atomId: fixture.selectedAtomId,
      target
    })),
    { protocolVersion, type: "endDrag", requestId: "req_end", sessionId, atomId: fixture.selectedAtomId },
    { protocolVersion, type: "commit", requestId: commitRequestId, sessionId },
    { protocolVersion, type: "dispose", requestId: "req_dispose", sessionId }
  ];
}

// Spawn the sidecar with explicit control over the Engine 3D env flags. `envOverrides` values
// of undefined DELETE the variable so flags leaking in from the caller's shell cannot skew an
// A/B run; string values are set as given.
export async function runSidecar(binaryPath, messages, envOverrides = {}) {
  const env = { ...process.env };
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }

  const child = spawn(binaryPath, ["--stdio"], {
    stdio: ["pipe", "pipe", "pipe"],
    env
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

export function parseProtocolLines(stdout) {
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

export function commitResponse(messages) {
  const commit = messages.find((message) => message.type === "response" && message.requestId === commitRequestId);
  if (!commit?.ok || !commit.result?.coords3dByAtomId) {
    fail(`Missing successful commit response. Got ${JSON.stringify(commit)}.`);
  }
  return commit;
}

export function coordinateEvents(messages, reason) {
  return messages.filter((message) =>
    message.type === "event" &&
    message.eventType === "coordinatesChanged" &&
    (reason === undefined || message.reason === reason)
  );
}

// Post-initial-relax geometry: the baseline every drift/safety comparison should use. The raw
// embed frame is OCL 2D layout with short bonds and must not be treated as physical geometry.
export function relaxedBaseline(messages) {
  const initialRelax = coordinateEvents(messages, "initial-relax").at(0);
  if (initialRelax?.coords3dByAtomId) {
    return initialRelax.coords3dByAtomId;
  }
  const embed = coordinateEvents(messages, "embed").at(0);
  if (!embed?.coords3dByAtomId) {
    fail("Missing embed coordinates.");
  }
  return embed.coords3dByAtomId;
}

export function annealTrialCount(stderr) {
  const line = stderr
    .split("\n")
    .filter((entry) => entry.includes("[engine3d-timing]") && entry.includes("phase=endDrag-anneal"))
    .at(-1);
  const match = line?.match(/trials=(\d+)/);
  return match ? Number(match[1]) : null;
}

// Net rigid-body drift of the non-dragged atoms between two frames: centroid translation plus
// a rotation proxy (angle between centroid-relative direction vectors per atom). A pure rigid
// rotation about the centroid shows up directly; shape relaxation shows up in maxAtomDrift.
export function bulkDriftStats(atomIds, selectedAtomId, referenceCoords, frameCoords) {
  const bulkIds = atomIds.filter((atomId) => atomId !== selectedAtomId);
  const refCentroid = vectorCentroid(bulkIds.map((atomId) => referenceCoords[atomId]));
  const frameCentroid = vectorCentroid(bulkIds.map((atomId) => frameCoords[atomId]));
  const centroidDrift = distance(refCentroid, frameCentroid);

  let maxAtomDrift = 0;
  let rotationSum = 0;
  let rotationMax = 0;
  let rotationCount = 0;
  for (const atomId of bulkIds) {
    maxAtomDrift = Math.max(maxAtomDrift, distance(referenceCoords[atomId], frameCoords[atomId]));
    const refRadial = subtract(referenceCoords[atomId], refCentroid);
    const frameRadial = subtract(frameCoords[atomId], frameCentroid);
    if (vectorLength(refRadial) < 0.75 || vectorLength(frameRadial) < 0.75) {
      continue; // too close to the centroid for a stable direction
    }
    const angle = vectorAngle(normalize(refRadial), normalize(frameRadial));
    rotationSum += angle;
    rotationMax = Math.max(rotationMax, angle);
    rotationCount += 1;
  }

  return {
    centroidDrift,
    maxAtomDrift,
    meanRotationDeg: rotationCount > 0 ? degrees(rotationSum / rotationCount) : 0,
    maxRotationDeg: degrees(rotationMax)
  };
}

export function meanBulkFrameToFrameMovement(atomIds, selectedAtomId, previousCoords, currentCoords) {
  const bulkIds = atomIds.filter((atomId) => atomId !== selectedAtomId);
  if (bulkIds.length === 0) {
    return 0;
  }
  const total = bulkIds.reduce((sum, atomId) => sum + distance(previousCoords[atomId], currentCoords[atomId]), 0);
  return total / bulkIds.length;
}

export function bondLengthStats(fixture, coords) {
  let max = 0;
  let min = Infinity;
  for (const bond of fixture.bonds) {
    const length = distance(coords[bond.fromAtomId], coords[bond.toAtomId]);
    max = Math.max(max, length);
    min = Math.min(min, length);
  }
  return { max, min };
}

export function minNonbondedDistance(fixture, coords) {
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

export function radiusOfGyration(atomIds, coords) {
  const centroid = vectorCentroid(atomIds.map((atomId) => coords[atomId]));
  const meanSquare = atomIds.reduce((sum, atomId) => {
    const d = distance(coords[atomId], centroid);
    return sum + d * d;
  }, 0) / Math.max(1, atomIds.length);
  return Math.sqrt(meanSquare);
}

export function assertAllCoordinatesFinite(fixture, coords, label) {
  for (const atomId of fixture.atomIds) {
    if (!coords[atomId]) {
      fail(`${label}: missing coordinates for ${atomId}.`);
    }
    if (!isFiniteCoord(coords[atomId])) {
      fail(`${label}: coordinates for ${atomId} are not finite.`);
    }
  }
}

export function vectorCentroid(coords) {
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

export function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function vectorLength(vector) {
  return Math.sqrt(vector.x * vector.x + vector.y * vector.y + vector.z * vector.z);
}

export function normalize(vector) {
  const length = vectorLength(vector);
  if (length < 1e-9) {
    return { x: 1, y: 0, z: 0 };
  }
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}

export function vectorAngle(a, b) {
  const dot = Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z));
  return Math.acos(dot);
}

export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function isFiniteCoord(coord) {
  return Number.isFinite(coord?.x) && Number.isFinite(coord?.y) && Number.isFinite(coord?.z);
}

export function degrees(radiansValue) {
  return radiansValue * 180 / Math.PI;
}

export function formatCoord(coord) {
  return `(${coord.x.toFixed(4)}, ${coord.y.toFixed(4)}, ${coord.z.toFixed(4)})`;
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

export function fail(message) {
  console.error(message);
  process.exit(1);
}
