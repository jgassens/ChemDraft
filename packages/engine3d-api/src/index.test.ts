import { describe, expect, it } from "vitest";
import {
  Engine3DProtocolVersion,
  createEngine3DBondSignature,
  createEngine3DGraphSignature,
  createFakeEngine3DSession,
  formatEngine3DMessage,
  parseEngine3DMessageLine,
  validateEngine3DCommit,
  type Engine3DBeginDragRequest,
  type Engine3DCreateSessionRequest,
  type Engine3DEndDragRequest,
  type Engine3DEvent,
  type Engine3DSessionInput,
  type Engine3DSessionRequest,
  type Engine3DUpdateDragRequest
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
  ]),
  coords3dByAtomId: {
    a1: { x: 0, y: 0, z: 0 },
    a2: { x: 1.5, y: 0, z: 0.15 },
    a3: { x: 2.8, y: 0.4, z: -0.1 }
  }
};

function sessionRequest(type: Engine3DSessionRequest["type"], requestId: string): Engine3DSessionRequest {
  return {
    protocolVersion: Engine3DProtocolVersion,
    type,
    requestId,
    sessionId: "session_1"
  };
}

function beginDragRequest(requestId: string): Engine3DBeginDragRequest {
  return {
    protocolVersion: Engine3DProtocolVersion,
    type: "beginDrag",
    requestId,
    sessionId: "session_1",
    atomId: "a2"
  };
}

function updateDragRequest(requestId: string): Engine3DUpdateDragRequest {
  return {
    protocolVersion: Engine3DProtocolVersion,
    type: "updateDrag",
    requestId,
    sessionId: "session_1",
    atomId: "a2",
    target: { x: 3.2, y: -0.7, z: 0.9 }
  };
}

function endDragRequest(requestId: string): Engine3DEndDragRequest {
  return {
    protocolVersion: Engine3DProtocolVersion,
    type: "endDrag",
    requestId,
    sessionId: "session_1",
    atomId: "a2"
  };
}

function eventByType(messages: readonly unknown[], eventType: string): Engine3DEvent | undefined {
  return messages.find((message): message is Engine3DEvent =>
    typeof message === "object" &&
    message !== null &&
    (message as Engine3DEvent).type === "event" &&
    (message as Engine3DEvent).eventType === eventType
  );
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
    expect(parseEngine3DMessageLine(JSON.stringify({ protocolVersion: 2, type: "ping", requestId: "r" })))
      .toMatchObject({ ok: false, error: expect.stringContaining("missing sessionId") });
    expect(parseEngine3DMessageLine(JSON.stringify({ protocolVersion: 2, type: "ping", requestId: "r", sessionId: "s", pad: "x".repeat(80) }), 32))
      .toMatchObject({ ok: false, error: expect.stringContaining("exceeds") });
    // A line whose UTF-16 length is within budget (11) but whose UTF-8 byte length is not
    // (33 > 32) must still be rejected — the byte guard is authoritative, not the code-unit
    // count. Guards against a length-only fast path that would silently accept it.
    expect(parseEngine3DMessageLine("✓".repeat(11), 32))
      .toMatchObject({ ok: false, error: expect.stringContaining("exceeds") });
  });

  it("runs the fake headless-physics golden transcript", () => {
    const fake = createFakeEngine3DSession(SESSION_INPUT, "session_1");
    const createMessages = fake.send({
      protocolVersion: Engine3DProtocolVersion,
      type: "createSession",
      requestId: "req_1",
      input: SESSION_INPUT
    });
    const beginMessages = fake.send(beginDragRequest("req_2"));
    const dragMessages = fake.send(updateDragRequest("req_3"));
    const endMessages = fake.send(endDragRequest("req_4"));
    const commitMessages = fake.send(sessionRequest("commit", "req_5"));
    const disposeMessages = fake.send(sessionRequest("dispose", "req_6"));

    expect(createMessages.map((message) => message.type)).toEqual(["response", "event", "event"]);
    expect(eventByType(createMessages, "ready")).toMatchObject({
      capabilities: {
        headlessPhysics: true,
        worldSpaceDrag: true,
        frontendRendering: true
      }
    });
    expect(eventByType(createMessages, "coordinatesChanged")).toMatchObject({
      reason: "embed",
      coordinateRevision: 0
    });
    expect(eventByType(beginMessages, "selectionChanged")).toMatchObject({ selectedAtomIds: ["a2"] });
    expect(eventByType(dragMessages, "coordinatesChanged")).toMatchObject({
      reason: "drag",
      coordinateRevision: 1,
      coords3dByAtomId: expect.objectContaining({
        a2: { x: 3.2, y: -0.7, z: 0.9 }
      })
    });
    expect(eventByType(dragMessages, "energyChanged")).toMatchObject({ energy: -1.25 });
    expect(eventByType(endMessages, "coordinatesChanged")).toMatchObject({
      reason: "settle",
      coordinateRevision: 2
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
