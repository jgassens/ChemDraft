import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const python = ["python3", "python"].find((command) => {
  const probe = spawnSync(command, ["-c", "import sys; sys.exit(0 if sys.version_info.major == 3 else 1)"],
    { encoding: "utf8", timeout: 3000 });
  return !probe.error && probe.status === 0;
});
if (!python) throw new Error("Python 3 is required: neither python3 nor python found a working Python 3 interpreter");

const here = fileURLToPath(new URL(".", import.meta.url));
const expected = JSON.parse(readFileSync(new URL("expected.json", import.meta.url), "utf8"))
  .fixtures[0].expectedSmiles;
const id = "brevetoxin-a / file";
const progress = (run: number, runsPlanned = 5) => ({ id, type: "progress", stage: "reading", run, runsPlanned });
// Reconstruct the flat protocol-2 result from the supplied failure log's 4/5 vote.
const result = {
  id, type: "result", smiles: expected, molfile: "", atoms: [], bonds: [],
  confidence: 0.7516801099946047,
  agreement: { runs: 5, agreeing: 4, invalidRuns: 1, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 1000
};

// Exercise the Python reader with only the standard library; no installed engine is needed.
function readReply(messages: unknown[], step = 1, timeout = 300) {
  const child = spawnSync(python!, ["-I", "-B", "-c", `
import json, sys
from unittest.mock import patch
sys.path.insert(0, sys.argv[1])
from sidecar_reply import read_result
data = json.load(sys.stdin)
messages = iter(data["messages"])
now, waits = [0], []
def read(timeout):
    waits.append(timeout)
    now[0] += data["step"]
    return next(messages)
with patch("sidecar_reply.time.monotonic", side_effect=lambda: now[0]):
    try:
        answer = {"reply": read_result(read, ${JSON.stringify(id)}, data["timeout"])}
    except SystemExit as problem:
        answer = {"error": str(problem)}
answer["waits"] = waits
answer["remaining"] = list(messages)
print(json.dumps(answer))
`, here], { input: JSON.stringify({ messages, step, timeout }), encoding: "utf8",
  timeout: process.env.CI ? 19_000 : 4_000 });
  expect(child.error).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  return JSON.parse(child.stdout);
}

describe("sidecar reply", () => {
  it("reads the logged 4/5 winner after all progress, leaving the next reply queued", () => {
    const next = { ...result, id: "brevetoxin-a / retina-2x-on-white" };
    const actual = readReply([...[1, 2, 3, 4, 5].map((run) => progress(run)), result, next]);
    expect(actual.reply).toEqual(result);
    expect(actual.remaining).toEqual([next]);
    expect(actual.waits).toEqual([300, 299, 298, 297, 296, 295]);
  });

  it("accepts a widening vote and a result with no progress", () => {
    expect(readReply([progress(5), progress(6, 15), result]).reply).toEqual(result);
    expect(readReply([result]).reply).toEqual(result);
    expect(readReply([progress(64, 64), result]).reply).toEqual(result);
  });

  it("preserves wrong structures and genuine failures for the existing pass rules", () => {
    const wrong = { ...result, smiles: "CCO" };
    expect(readReply([progress(1), wrong]).reply).toEqual(wrong);
    for (const code of ["recognition_failed", "invalid_image"]) {
      const failure = { id, type: "error", code, message: "The engine could not read a valid structure." };
      expect(readReply([progress(1), failure]).reply).toEqual(failure);
      expect(readReply([{ ...failure, id: null }]).reply).toEqual({ ...failure, id: null });
    }
  });

  it("rejects mismatched requests, unexpected messages and malformed progress", () => {
    for (const message of [progress(1), result, { id, type: "error", code: "recognition_failed" }]) {
      expect(readReply([{ ...message, id: "another case" }]).error).toMatch(/another case.*waiting for/);
    }
    expect(readReply([{ type: "ready" }]).error).toMatch(/unexpected sidecar message/);
    expect(readReply([progress(0)]).error).toMatch(/inconsistent sidecar progress/);
    expect(readReply([progress(6)]).error).toMatch(/inconsistent sidecar progress/);
    expect(readReply([progress(1, 65)]).error).toMatch(/inconsistent sidecar progress/);
  });

  it("checks agreement counts and sizes", () => {
    const withoutInvalid = { runs: 5, agreeing: 4, scalesPx: result.agreement.scalesPx };
    expect(readReply([{ ...result, agreement: withoutInvalid }]).reply.agreement).toEqual(withoutInvalid);
    for (const agreement of [
      { ...result.agreement, runs: 0 },
      { ...result.agreement, agreeing: 0 },
      { ...result.agreement, agreeing: 5 },
      { ...result.agreement, scalesPx: [800] },
      { ...result.agreement, invalidRuns: -1 },
      null
    ]) {
      expect(readReply([{ ...result, agreement }]).error).toMatch(/inconsistent sidecar agreement/);
    }
  });

  it("reports fatal errors and enforces one timeout across progress messages", () => {
    expect(readReply([{ type: "fatal", code: "model_load_failed", message: "missing model" }]).error)
      .toMatch(/model_load_failed.*missing model/);
    const timedOut = readReply([progress(1), progress(2), result], 150);
    expect(timedOut.error).toMatch(/did not answer within 300\.0 s/);
    expect(timedOut.waits).toEqual([300, 150]);
    expect(timedOut.remaining).toEqual([result]);
    expect(readReply([progress(1)], 301, 300.26).error).toMatch(/within 300\.3 s/);
  });
});
