/**
 * Node client for the dev-only native-RDKit stereo oracle (`oracle.py`).
 *
 * DEV / TEST TOOLING ONLY — never imported by app runtime code. It spawns the
 * Python bridge with a fixed argument array (no shell, no string interpolation),
 * writes a JSON request to its stdin, and parses the JSON it writes to stdout.
 *
 * If the isolated venv is absent (a machine without the oracle installed), the
 * client reports unavailable so harnesses can SKIP rather than fail.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..");

/** Path to the isolated oracle interpreter created by `setup.sh`. */
export const ORACLE_PYTHON = join(REPO_ROOT, ".venv-rdkit-oracle", "bin", "python");
export const ORACLE_SCRIPT = join(HERE, "oracle.py");

export type OracleOp = "perceiveFrom3D" | "perceiveFrom2D";

export interface OracleAtom {
  element: string;
  x: number;
  y: number;
  z?: number;
}

export interface OracleBond {
  from: number; // 0-based index into atoms
  to: number; // 0-based index into atoms
  order?: "single" | "double" | "triple" | "aromatic" | "unknown";
  wedge?: "up" | "down" | null; // only consulted for perceiveFrom2D
}

export interface OracleRequest {
  id: string;
  op: OracleOp;
  atoms: OracleAtom[];
  bonds: OracleBond[];
}

export interface OracleResult {
  id: string;
  op: OracleOp;
  /** Atom index (as a string) -> CIP code ("R" | "S" | ...). */
  centers: Record<string, string>;
  error: string | null;
}

export interface OracleResponse {
  engine: { name: string; version: string };
  results: OracleResult[];
}

/** True when the isolated oracle venv + script are present on this machine. */
export function isOracleAvailable(): boolean {
  return existsSync(ORACLE_PYTHON) && existsSync(ORACLE_SCRIPT);
}

/** Report the backing engine (name + version), or null if unavailable. */
export function oracleEngineInfo(): { name: string; version: string } | null {
  if (!isOracleAvailable()) return null;
  const response = invoke({ engineInfo: true, requests: [] });
  return response.engine;
}

interface OraclePayload {
  engineInfo?: boolean;
  requests: OracleRequest[];
}

function invoke(payload: OraclePayload): OracleResponse {
  const proc = spawnSync(ORACLE_PYTHON, [ORACLE_SCRIPT], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024
  });
  if (proc.status !== 0) {
    throw new Error(
      `rdkit oracle exited with status ${proc.status}: ${proc.stderr || proc.error?.message || "unknown error"}`
    );
  }
  try {
    return JSON.parse(proc.stdout) as OracleResponse;
  } catch (cause) {
    throw new Error(`rdkit oracle returned non-JSON stdout: ${proc.stdout.slice(0, 200)}`, { cause });
  }
}

/** Run a batch of perception requests through the oracle. */
export function runOracle(requests: OracleRequest[]): OracleResponse {
  if (!isOracleAvailable()) {
    throw new Error(`rdkit oracle unavailable; run tools/rdkit-oracle/setup.sh (looked for ${ORACLE_PYTHON})`);
  }
  return invoke({ requests });
}
