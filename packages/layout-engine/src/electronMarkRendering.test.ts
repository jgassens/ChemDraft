import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createEmptyDocument, type ElectronMarkObject } from "@chemdraft/chem-core";
import { electronMarkHitCatcherAttributes, planPageSvgRender } from "./index";
import { legacyElectronMarkHashes } from "./electronMarkLegacy.fixture";

function markFor(key: string, rotation = 0): ElectronMarkObject {
  const [kind, rawCharge] = key.split(":");
  const charge = Number(rawCharge);
  return { id: "mark", type: "electron-mark", x: 100, y: 100, width: 18, height: 18, rotation, style: {},
    markKind: kind === "lone-pair" || kind === "radical-dot" ? kind : "charge",
    ...(charge ? { charge } : {}),
    ...(kind === "plain" ? { chargeStyle: "plain" as const } : {}),
    ...(kind === "radical-ion" ? { radical: true } : {}),
    anchor: { kind: "point", point: { x: 109, y: 109 } } };
}
const plan = (object: ElectronMarkObject, directElectronMarkEditing = false) =>
  planPageSvgRender({ ...createEmptyDocument({ title: "legacy" }).pages[0], objects: [object] }, { directElectronMarkEditing });

describe("electron-mark rendering preferences", () => {
  it.each(Object.entries(legacyElectronMarkHashes))("matches origin/main's entire default render plan for %s", (key, hashes) => {
    for (const [index, rotation] of [0, 37].entries()) {
      const object = markFor(key, rotation);
      const actual = plan(object);
      expect(createHash("sha256").update(JSON.stringify(actual)).digest("hex")).toBe(hashes[index]);
      expect(plan({ ...object, style: { strokeWidth: 1.5 } })).toEqual(actual);
    }
  });

  it("enables the revised radical-ion positions only with opt-in for default marks", () => {
    for (const charge of [-1, 1]) {
      const object = markFor(`radical-ion:${charge}`);
      const legacy = plan(object).fragments;
      expect(legacy.find(f => f.key.startsWith("charge-radical-"))?.attrs.cx).toBe(109 - 18 * 0.32 * 0.75);
      expect(legacy.find(f => f.key.startsWith("charge-bar-"))?.attrs.x1).toBe(109 + 18 * 0.32 * 0.45 - 18 * 0.32 * 0.85);
      expect(plan(object, true)).not.toEqual(plan(object));
    }
  });

  it.each(Object.keys(legacyElectronMarkHashes))("uses authored size/thickness in either preference mode for %s", key => {
    for (const size of [8, 18, 108]) for (const thickness of [0.5, 1.5, 5.5]) {
      if (size === 18 && thickness === 1.5) continue;
      const object = { ...markFor(key), width: size, height: size, style: { strokeWidth: thickness } };
      expect(plan(object)).toEqual(plan(object, true));
      const fragments = plan(object).fragments;
      if (key.startsWith("radical-ion:") && Math.abs(object.charge!) === 1) {
        const dot = fragments.find(f => f.key.startsWith("charge-radical-"))!;
        const bar = fragments.find(f => f.key.startsWith("charge-bar-"))!;
        expect(Number(dot.attrs.cx) + Number(dot.attrs.r)).toBeLessThan(Number(bar.attrs.x1) - thickness / 2);
      }
      if (object.markKind === "lone-pair") {
        const [a, b] = fragments;
        expect(Number(b.attrs.cx) - Number(a.attrs.cx)).toBeGreaterThan(Number(a.attrs.r) + Number(b.attrs.r));
      }
      if (object.markKind === "charge" && Math.abs(object.charge!) > 1) {
        expect(fragments.find(f => f.tag === "text")?.attrs["stroke-width"]).toBe(Math.max(0, thickness - 1.5) * 0.4);
      }
    }
  });

  it("uses the symbol's shared frame and pivot for a rotated direct-edit catcher", () => {
    const object = markFor("lone-pair:0", 37);
    expect(electronMarkHitCatcherAttributes(object)).toEqual({
      x: 100, y: 100, width: 18, height: 18, transform: "rotate(37 109 109)"
    });
    expect(plan(object).fragments[0].attrs.transform).toBe(electronMarkHitCatcherAttributes(object).transform);
  });
});
