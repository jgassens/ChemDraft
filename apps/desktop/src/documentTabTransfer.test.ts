import { describe, expect, it } from "vitest";
import { createDocumentHistory } from "@chemdraft/chem-core";
import { createPhase4Document } from "./documentWorkflow";
import { createViewportState } from "@chemdraft/viewport-engine";
import { transferHistoryDocuments, validateTabTransfer } from "./documentTabTransfer";

function snapshot() {
  const history = createDocumentHistory(createPhase4Document("Current"));
  history.past = [createPhase4Document("Before")];
  history.future = [createPhase4Document("After")];
  return { version: 1 as const, title: "Moved", pristine: false, undoLabels: ["Before", "Edit", null],
    state: { history, file: { path: "C:\\drawings\\a.chemdraft", dirty: true }, viewport: createViewportState(),
      scrollLeft: 13, scrollTop: 29, parts: [], status: "Edited" } };
}

describe("live tab transfer", () => {
  it("preserves all history positions, file state and view through native JSON transport", () => {
    const original = snapshot();
    const decoded = JSON.parse(JSON.stringify(original));
    const moved = validateTabTransfer<typeof original.state>(decoded);
    expect(moved).toEqual(original);
    expect(moved).toBe(decoded);
    expect(transferHistoryDocuments(moved.state.history).map((document) => document.title)).toEqual(["Before", "Current", "After"]);
  });
  it("refuses incomplete history labels rather than silently losing undo metadata", () => {
    const value = snapshot(); value.undoLabels.pop();
    expect(() => validateTabTransfer(value)).toThrow("history is incomplete");
  });
  it("refuses an invalid historical drawing before destination acceptance", () => {
    const value = snapshot();
    value.state.history.past[0] = { broken: true } as never;
    expect(() => validateTabTransfer(value)).toThrow();
  });
});
