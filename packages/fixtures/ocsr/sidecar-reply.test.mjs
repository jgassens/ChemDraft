import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = fileURLToPath(new URL(".", import.meta.url));
const expected = JSON.parse(readFileSync(new URL("expected.json", import.meta.url), "utf8"))
  .fixtures[0].expectedSmiles;
const id = "brevetoxin-a / file";
const progress = (run, runsPlanned = 5) => ({ id, type: "progress", stage: "reading", run, runsPlanned });
// The supplied failure log captures stderr votes, not stdout replies. Reconstruct the flat
// protocol-2 result using its 900 px winner, confidence and 4/5 agreement (one invalid reading).
const result = {
  id, type: "result", smiles: expected, molfile: "", atoms: [], bonds: [],
  confidence: 0.7516801099946047,
  agreement: { runs: 5, agreeing: 4, invalidRuns: 1, scalesPx: [800, 900, 1000, 1100, 1200] },
  elapsedMs: 1000
};

// Exercise the Python reader with only the standard library; no installed engine is needed.
function readReply(messages, step = 1) {
  const child = spawnSync(process.platform === "win32" ? "python" : "python3", ["-I", "-B", "-c", `
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
        answer = {"reply": read_result(read, ${JSON.stringify(id)}, 300)}
    except SystemExit as problem:
        answer = {"error": str(problem)}
answer["waits"] = waits
answer["remaining"] = list(messages)
print(json.dumps(answer))
`, here], { input: JSON.stringify({ messages, step }), encoding: "utf8" });
  assert.ifError(child.error);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("reads the logged 4/5 winner after all progress, leaving the next reply queued", () => {
  const next = { ...result, id: "brevetoxin-a / retina-2x-on-white" };
  const actual = readReply([1, 2, 3, 4, 5].map((run) => progress(run)).concat(result, next));
  assert.deepEqual(actual.reply, result);
  assert.deepEqual(actual.remaining, [next]);
  assert.deepEqual(actual.waits, [300, 299, 298, 297, 296, 295]);
});

test("accepts a widening vote and a result with no progress", () => {
  assert.deepEqual(readReply([progress(5), progress(6, 15), result]).reply, result);
  assert.deepEqual(readReply([result]).reply, result);
});

test("preserves wrong structures and genuine failures for the existing pass rules", () => {
  const wrong = { ...result, smiles: "CCO" };
  assert.deepEqual(readReply([progress(1), wrong]).reply, wrong);
  for (const code of ["recognition_failed", "invalid_image"]) {
    const failure = { id, type: "error", code, message: "The engine could not read a valid structure." };
    assert.deepEqual(readReply([progress(1), failure]).reply, failure);
    assert.deepEqual(readReply([{ ...failure, id: null }]).reply, { ...failure, id: null });
  }
});

test("rejects mismatched requests, unexpected messages and malformed progress", () => {
  for (const message of [progress(1), result, { id, type: "error", code: "recognition_failed" }]) {
    assert.match(readReply([{ ...message, id: "another case" }]).error, /another case.*waiting for/);
  }
  assert.match(readReply([{ type: "ready" }]).error, /unexpected sidecar message/);
  assert.match(readReply([progress(0)]).error, /inconsistent sidecar progress/);
  assert.match(readReply([progress(6)]).error, /inconsistent sidecar progress/);
});

test("reports fatal errors and enforces one timeout across progress messages", () => {
  assert.match(readReply([{ type: "fatal", code: "model_load_failed", message: "missing model" }]).error,
    /model_load_failed.*missing model/);
  const timedOut = readReply([progress(1), progress(2), result], 150);
  assert.match(timedOut.error, /did not answer within 300 s/);
  assert.deepEqual(timedOut.waits, [300, 150]);
  assert.deepEqual(timedOut.remaining, [result]);
});
