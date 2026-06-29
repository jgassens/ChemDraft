import { describe, expect, it } from "vitest";
import {
  Engine3DProtocolVersion,
  createEngine3DBondSignature,
  createEngine3DGraphSignature,
  createFakeEngine3DSession,
  formatEngine3DMessage,
  parseEngine3DMessageLine,
  validateEngine3DCommit,
  type Engine3DCreateSessionRequest,
  type Engine3DPointerRequest,
  type Engine3DSessionRequest,
  type Engine3DSessionInput
} from "./index";

const SESSION_INPUT: Engine3DSessionInput = {
  molfile: "ethanol fixture",
  format: "molfile-v2000",
  atomIdByMolfileIndex: ["a1", "a2", "a3"],
  graphSignature: createEngine3DGraphSignature({
    atoms: [
      { id: "a1", element: "C" },
      { id: "a2", element: "C" },
      { id: "a3", element: "O" }
    ],
    bonds: [
      { fromAtomId: "a1", toAtomId: "a2", order: 1 },
      { fromAtomId: "a2", toAtomId: "a3", order: 1 }
    ]
  }),
  bondSignature: createEngine3DBondSignature([
    { fromAtomId: "a1", toAtomId: "a2", order: 1 },
    { fromAtomId: "a2", toAtomId: "a3", order: 1 }
  ])
};

function sessionRequest(type: Engine3DSessionRequest["type"], requestId: string): Engine3DSessionRequest {
  return {
    protocolVersion: Engine3DProtocolVersion,
    type,
    requestId,
    sessionId: "session_1"
  };
}

function pointerRequest(requestId: string, event: Engine3DPointerRequest["event"]): Engine3DPointerRequest {
  return {
    protocolVersion: Engine3DProtocolVersion,
    type: "pointer",
    requestId,
    sessionId: "session_1",
    event
  };
}

describe("Engine 3D protocol", () => {
  it("round-trips one NDJSON message per line", () => {
    const message: Engine3DCreateSessionRequest = {
      protocolVersion: Engine3DProtocolVersion,
      type: "createSession",
      requestId: "req_1",
      input: SESSION_INPUT
    };

    const parsed = parseEngine3DMessageLine(formatEngine3DMessage(message));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.message).toMatchObject({ type: "createSession", requestId: "req_1" });
    }
  });

  it("rejects malformed, oversized, unsupported, and missing-session messages", () => {
    expect(parseEngine3DMessageLine("{")).toMatchObject({ ok: false });
    expect(parseEngine3DMessageLine(JSON.stringify({ protocolVersion: 999, type: "ping", requestId: "r", sessionId: "s" })))
      .toMatchObject({ ok: false, error: expect.stringContaining("Unsupported") });
    expect(parseEngine3DMessageLine(JSON.stringify({ protocolVersion: 1, type: "ping", requestId: "r" })))
      .toMatchObject({ ok: false, error: expect.stringContaining("missing sessionId") });
    expect(parseEngine3DMessageLine(JSON.stringify({ protocolVersion: 1, type: "ping", requestId: "r", sessionId: "s", pad: "x".repeat(80) }), 32))
      .toMatchObject({ ok: false, error: expect.stringContaining("exceeds") });
  });

  it("runs the fake golden transcript", () => {
    const fake = createFakeEngine3DSession(SESSION_INPUT, "session_1");
    const createMessages = fake.send({
      protocolVersion: Engine3DProtocolVersion,
      type: "createSession",
      requestId: "req_1",
      input: SESSION_INPUT
    });
    const showMessages = fake.send(sessionRequest("showViewport", "req_2"));
    const optimizeMessages = fake.send(sessionRequest("startAutoOptimize", "req_3"));
    const dragMessages = fake.send(pointerRequest("req_4", { kind: "move", atomId: "a2", x: 12, y: -8, buttons: 1 }));
    const commitMessages = fake.send(sessionRequest("commit", "req_5"));
    const disposeMessages = fake.send(sessionRequest("dispose", "req_6"));

    expect(createMessages.map((message) => message.type)).toEqual(["response", "event"]);
    expect(showMessages.find((message) => message.type === "event")).toMatchObject({ eventType: "viewportShown" });
    expect(optimizeMessages.find((message) => message.type === "event")).toMatchObject({ eventType: "energyChanged" });
    expect(dragMessages.find((message) => message.type === "event")).toMatchObject({
      eventType: "coordinatesChanged",
      coordinateRevision: 1
    });
    expect(commitMessages[0]).toMatchObject({ type: "response", ok: true });
    expect(disposeMessages.find((message) => message.type === "event")).toMatchObject({ eventType: "closed" });
  });

  it("rejects sidecar commits that mutate graph identity or atom identity", () => {
    const fake = createFakeEngine3DSession(SESSION_INPUT, "session_1");
    const valid = validateEngine3DCommit(SESSION_INPUT, fake.commit());
    expect(valid).toEqual({ ok: true, errors: [] });

    const invalid = validateEngine3DCommit(SESSION_INPUT, {
      ...fake.commit(),
      graphSignature: "changed",
      bondSignature: "changed",
      coords3dByAtomId: {
        a1: { x: 0, y: 0, z: 0 },
        a2: { x: 1, y: 0, z: 0 },
        extra: { x: 2, y: 0, z: 0 }
      }
    });

    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toEqual([
      "Graph signature changed.",
      "Bond signature changed.",
      'Missing coordinates for atom "a3".',
      'Unexpected coordinates for atom "extra".'
    ]);
  });
});
