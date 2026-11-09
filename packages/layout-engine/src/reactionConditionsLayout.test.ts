import { expect, it } from "vitest";
import { createEmptyDocument, type ArrowObject, type TextObject } from "@chemdraft/chem-core";
import { reactionConditionsPlacement } from "./reactionConditionsLayout";
import { arrowAttachmentPoint } from "./arrowAttachmentFrames";

it("places horizontal conditions above and below a shaft without importing the public entry point", () => {
  const page = createEmptyDocument().pages[0];
  const base = { rotation: 0, style: {} };
  const arrow: ArrowObject = { ...base, id: "arrow", type: "reaction-arrow", x: 200, y: 200, width: 200, height: 0,
    arrowKind: "forward", labels: [], start: { kind: "point", point: { x: 200, y: 200 } }, end: { kind: "point", point: { x: 400, y: 200 } } };
  const label: TextObject = { ...base, id: "label", type: "text", x: 0, y: 0, width: 80, height: 24, text: "THF", spans: [] };
  page.objects = [arrow];
  for (const side of ["above", "below"] as const) {
    const placement = reactionConditionsPlacement(page, arrow, label, side)!;
    expect(placement).toBeDefined();
    const center = arrowAttachmentPoint(placement.frame, placement.offset);
    expect(center.x).toBe(300);
    expect(side === "above" ? center.y < 188 : center.y > 212).toBe(true);
  }
});
