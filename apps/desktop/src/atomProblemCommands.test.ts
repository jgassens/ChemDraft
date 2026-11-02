import { expect, it, vi } from "vitest";
import { atomProblem } from "@chemdraft/document-workflow-core";
import { atomProblemSnapshot } from "./atomProblemCommands";
import { DialogCoordinator } from "./dialogs/DialogCoordinator";
import { parseDialogMessage, type DialogMessage } from "./dialogs/dialogProtocol";
import { problemDocument, problemMolecule } from "./testSupport/atomProblemFixtures";

vi.mock("@chemdraft/document-workflow-core", async original => ({
  ...await original<typeof import("@chemdraft/document-workflow-core")>(), atomProblem: vi.fn()
}));

it.each(["漢🙂", '🙂漢"\n\\'])("opens long non-ASCII problem text within the serialized UTF-8 budget (%s)", async text => {
  const source = problemDocument();
  source.title = text.repeat(300);
  const explanation = text.repeat(1000);
  const atom = problemMolecule("C").atoms[0]!;
  vi.mocked(atomProblem).mockReturnValue({ explanation, state: {} as NonNullable<ReturnType<typeof atomProblem>>["state"],
    fixes: [{ action: "hydrogens", label: "Set explicit hydrogens to 1", atom },
      { action: "charge", label: "Set formal charge to +1", atom },
      { action: "ignore", label: "Ignore warning", atom }] });
  const data = atomProblemSnapshot(source, { objectId: "problem_molecule", atomId: "a0" }, Number.MAX_SAFE_INTEGER);
  const open = vi.fn(async (message: DialogMessage) => {
    expect(parseDialogMessage(message)).toEqual(message);
    expect(new TextEncoder().encode(JSON.stringify(message)).length).toBeLessThanOrEqual(3400);
    return { hostId: "host", windowLabel: "dialog-main-atomProblem-1" };
  });
  const coordinator = new DialogCoordinator({ open, subscribe: async () => () => {}, publish: vi.fn(), close: vi.fn() },
    { applyPageSize: vi.fn(), onError: vi.fn() });
  try {
    await coordinator.openAtomProblem("t".repeat(128), data);
    expect(open).toHaveBeenCalledOnce();
    const message = open.mock.calls[0]![0];
    // Also cover maximum valid identifiers/revision, rather than only generated UUIDs.
    const largestEnvelope = { ...message, sessionId: "s".repeat(128), requestId: "r".repeat(128), snapshotRevision: Number.MAX_SAFE_INTEGER };
    expect(parseDialogMessage(largestEnvelope)).toEqual(largestEnvelope);
    expect(new TextEncoder().encode(JSON.stringify(largestEnvelope)).length).toBeLessThanOrEqual(3400);
    expect(data.title.length).toBeLessThanOrEqual(256);
    expect(data.explanation.length).toBeLessThanOrEqual(1024);
    for (const [clipped, full] of [[data.title, source.title], [data.explanation, explanation]]) {
      expect(clipped!.length).toBeGreaterThan(0);
      expect(full!.startsWith(clipped!)).toBe(true);
      expect(clipped).not.toMatch(/[\uD800-\uDBFF]$/u);
    }
  } finally { await coordinator.dispose(); }
});

