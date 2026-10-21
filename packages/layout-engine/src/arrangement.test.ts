import { describe, expect, it } from "vitest";
import { ArrangementLayouts, planObjectArrangement, type ArrangementItem } from "./arrangement";
import { textVisualBoundsForArrangement } from "./index";
import type { TextObject } from "@chemdraft/chem-core";

function fixtures(count: number): ArrangementItem[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `compound-${i}`,
    bounds: { x: (i * 97) % 300, y: (i * 113) % 350, width: 30 + (i * 71) % 210, height: 24 + (i * 53) % 150 }
  }));
}
function requirePlan(items: ArrangementItem[], layout: typeof ArrangementLayouts[number], gap = 48) {
  const plan = planObjectArrangement(items, layout, { gap });
  if (!plan.ok) throw new Error(plan.reason);
  return plan;
}
function centers(items: ArrangementItem[]) {
  return items.map(({ bounds: b }) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 }));
}
function expectClearance(items: ArrangementItem[], gap: number) {
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i].bounds, b = items[j].bounds;
      const clearanceX = Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width));
      const clearanceY = Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height));
      expect(Math.max(clearanceX, clearanceY)).toBeGreaterThanOrEqual(gap - 1e-7);
    }
  }
}

describe("size-aware object arrangement", () => {
  it.each([0, 90, -90, 180, 45])("measures a caption rotated by %i degrees around its rendering pivot", rotation => {
    const caption: TextObject = { id: "caption", type: "text", text: "Caption", spans: [],
      x: 120, y: 290, width: 400, height: 20, rotation, style: {} };
    const bounds = textVisualBoundsForArrangement(caption);
    const expectedWidth = rotation === 90 || rotation === -90 ? 20 : rotation === 45 ? 420 / Math.sqrt(2) : 400;
    const expectedHeight = rotation === 90 || rotation === -90 ? 400 : rotation === 45 ? 420 / Math.sqrt(2) : 20;
    expect(bounds.width).toBeCloseTo(expectedWidth);
    expect(bounds.height).toBeCloseTo(expectedHeight);
    expect(bounds.x).toBeCloseTo(320 - expectedWidth / 2);
    expect(bounds.y).toBeCloseTo(300 - expectedHeight / 2);
    expect(caption).toMatchObject({ x: 120, y: 290, width: 400, height: 20, rotation });
  });
  it.each(["circle","oval"] as const)("places asymmetric visual anchors on the %s while clearing the full substituent frames",layout=>{
    const items=fixtures(5).map((item,i)=>({...item,anchor:{x:item.bounds.x+item.bounds.width*(0.2+i*0.12),y:item.bounds.y+item.bounds.height*0.8}}));
    const plan=requirePlan(items,layout);
    expectClearance(plan.placements,48);
    for (const placement of plan.placements) {
      const anchor=placement.anchor!,cycle=plan.cycle!;
      expect(((anchor.x-cycle.center.x)/cycle.radiusX)**2+((anchor.y-cycle.center.y)/cycle.radiusY)**2).toBeCloseTo(1);
      const original=items.find(item=>item.id===placement.id)!;
      expect(anchor.x).toBeCloseTo(original.anchor.x+placement.dx);
      expect(anchor.y).toBeCloseTo(original.anchor.y+placement.dy);
    }
    for (const placement of requirePlan(plan.placements,layout).placements) {
      expect(placement.dx).toBeCloseTo(0);expect(placement.dy).toBeCloseTo(0);
    }
  });
  it.each(["row","column","grid"] as const)("aligns asymmetric anchors in a %s with full-frame clearance",layout=>{
    const items=fixtures(6).map((item,i)=>({...item,anchor:{x:item.bounds.x+item.bounds.width*(0.2+i*0.1),y:item.bounds.y+item.bounds.height*(0.3+i*0.1)}}));
    const plan=requirePlan(items,layout);expectClearance(plan.placements,48);
    if (layout==="row") expect(new Set(plan.placements.map(p=>p.anchor!.y.toFixed(6))).size).toBe(1);
    if (layout==="column") expect(new Set(plan.placements.map(p=>p.anchor!.x.toFixed(6))).size).toBe(1);
    if (layout==="grid") {
      for (const row of [plan.placements.slice(0,3),plan.placements.slice(3)]) expect(new Set(row.map(p=>p.anchor!.y.toFixed(6))).size).toBe(1);
    }
    for (const placement of requirePlan(plan.placements,layout).placements) {
      expect(placement.dx).toBeCloseTo(0);expect(placement.dy).toBeCloseTo(0);
    }
  });
  for (const layout of ArrangementLayouts) {
    it.each([2, 3, 6, 7, 12, 30])(`${layout}: clears every pair of %i unequal items without resizing`, (count) => {
      const items = fixtures(count);
      const plan = requirePlan(items, layout);
      expectClearance(plan.placements, 48);
      for (const placement of plan.placements) {
        const original = items.find((item) => item.id === placement.id)!;
        expect(placement.bounds.width).toBe(original.bounds.width);
        expect(placement.bounds.height).toBe(original.bounds.height);
      }
      const repeated = requirePlan(plan.placements, layout);
      for (const placement of repeated.placements) {
        expect(placement.dx).toBeCloseTo(0, 7);
        expect(placement.dy).toBeCloseTo(0, 7);
      }
    });
  }
  it.each([3, 6, 7, 12])("places %i circle centers at equal angles on one radius", (count) => {
    const points = centers(requirePlan(fixtures(count), "circle").placements);
    const center = {
      x: points.reduce((sum, p) => sum + p.x, 0) / count,
      y: points.reduce((sum, p) => sum + p.y, 0) / count
    };
    const radius = Math.hypot(points[0].x - center.x, points[0].y - center.y);
    points.forEach((p, i) => {
      const theta = -Math.PI / 2 + Math.PI * 2 * i / count;
      expect(p.x).toBeCloseTo(center.x + radius * Math.cos(theta), 7);
      expect(p.y).toBeCloseTo(center.y + radius * Math.sin(theta), 7);
    });
  });
  it("preserves clockwise spatial order despite arbitrary input order", () => {
    const items = ["top", "right", "bottom", "left"].map((id, i) => ({
      id, bounds: { x: 300 + 150 * Math.cos(-Math.PI / 2 + i * Math.PI / 2),
        y: 300 + 150 * Math.sin(-Math.PI / 2 + i * Math.PI / 2), width: 40, height: 40 }
    }));
    expect(requirePlan([items[2], items[0], items[3], items[1]], "circle").placements.map((p) => p.id))
      .toEqual(["top", "right", "bottom", "left"]);
  });
  it.each(["row", "column"] as const)("%s has exact equal edge gaps and a common center line", (layout) => {
    const plan = requirePlan(fixtures(6), layout, 36);
    const points = centers(plan.placements);
    for (let i = 1; i < plan.placements.length; i++) {
      const a = plan.placements[i - 1].bounds, b = plan.placements[i].bounds;
      expect(layout === "row" ? b.x - (a.x + a.width) : b.y - (a.y + a.height)).toBeCloseTo(36, 7);
      expect(layout === "row" ? points[i].y : points[i].x).toBeCloseTo(layout === "row" ? points[0].y : points[0].x, 7);
    }
  });
  it("shifts a layout onto the page as a whole and refuses oversized layouts", () => {
    const items = fixtures(6).map((item) => ({ ...item, bounds: { ...item.bounds, x: -200, y: -100 } }));
    const page = { x: 0, y: 0, width: 1000, height: 1000 };
    const plan = planObjectArrangement(items, "circle", { pageBounds: page });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.bounds.x).toBeGreaterThanOrEqual(0);
      expect(plan.bounds.y).toBeGreaterThanOrEqual(0);
      expect(plan.bounds.x + plan.bounds.width).toBeLessThanOrEqual(page.width);
      expect(plan.bounds.y + plan.bounds.height).toBeLessThanOrEqual(page.height);
    }
    expect(planObjectArrangement(items, "circle", { pageBounds: { ...page, width: 50 } })).toEqual({ ok: false, reason: "page" });
  });
  it.each(["row", "column"] as const)("tightens default %s gaps to fit, preserving anchors, sizes and order", layout => {
    const items = [70, 85, 65].map((size, i) => {
      const bounds = { x: i * 100, y: i * 90, width: layout === "row" ? size : 50, height: layout === "column" ? size : 50 };
      return { id: `fit-${i}`, bounds, anchor: { x: bounds.x + bounds.width * 0.3, y: bounds.y + bounds.height * 0.7 } };
    });
    const page = { x: 10, y: 20, width: layout === "row" ? 260 : 350, height: layout === "column" ? 260 : 350 };
    const plan = planObjectArrangement(items, layout, { pageBounds: page });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.placements.map(p => p.id)).toEqual(items.map(item => item.id));
    expectClearance(plan.placements, 20);
    for (let i = 0; i < items.length; i++) {
      const placed = plan.placements[i];
      expect(placed.bounds.width).toBe(items[i].bounds.width);
      expect(placed.bounds.height).toBe(items[i].bounds.height);
      expect(placed.anchor!.x).toBeCloseTo(items[i].anchor.x + placed.dx);
      expect(placed.anchor!.y).toBeCloseTo(items[i].anchor.y + placed.dy);
      expect(layout === "row" ? placed.anchor!.y : placed.anchor!.x)
        .toBeCloseTo(layout === "row" ? plan.placements[0].anchor!.y : plan.placements[0].anchor!.x);
    }
    expect(plan.bounds.x).toBeGreaterThanOrEqual(page.x);
    expect(plan.bounds.y).toBeGreaterThanOrEqual(page.y);
    expect(plan.bounds.x + plan.bounds.width).toBeLessThanOrEqual(page.x + page.width);
    expect(plan.bounds.y + plan.bounds.height).toBeLessThanOrEqual(page.y + page.height);
    const repeat = planObjectArrangement(plan.placements, layout, { pageBounds: page });
    if (!repeat.ok) throw new Error(repeat.reason);
    expect(repeat.placements.every(p => Math.abs(p.dx) < 1e-7 && Math.abs(p.dy) < 1e-7)).toBe(true);
    expect(planObjectArrangement(items, layout, { pageBounds: page, gap: 48 })).toEqual({ ok: false, reason: "page" });
    const generous = planObjectArrangement(items, layout, { pageBounds: { ...page, width: 500, height: 500 } });
    if (!generous.ok) throw new Error(generous.reason);
    expectClearance(generous.placements, 48);
  });
  it.each(["row", "column"] as const)("keeps at least 12 pixels of clearance in a fitted %s and refuses impossible pages", layout => {
    const items = [70, 85, 65].map((size, i) => ({ id: `minimum-${i}`, bounds: {
      x: i * 100, y: i * 90, width: layout === "row" ? size : 50, height: layout === "column" ? size : 50
    } }));
    const page = { x: 0, y: 0, width: layout === "row" ? 244 : 350, height: layout === "column" ? 244 : 350 };
    const plan = planObjectArrangement(items, layout, { pageBounds: page });
    if (!plan.ok) throw new Error(plan.reason);
    expectClearance(plan.placements, 12);
    const tooShort = { ...page, ...(layout === "row" ? { width: 243 } : { height: 243 }) };
    expect(planObjectArrangement(items, layout, { pageBounds: tooShort })).toEqual({ ok: false, reason: "page" });
    const tooNarrow = { ...page, ...(layout === "row" ? { height: 49 } : { width: 49 }) };
    expect(planObjectArrangement(items, layout, { pageBounds: tooNarrow })).toEqual({ ok: false, reason: "page" });
  });
  it("handles a partial last grid row and an explicit column count", () => {
    const plan = planObjectArrangement(fixtures(7), "grid", { columns: 2 });
    expect(plan.ok).toBe(true);
    if (plan.ok) expectClearance(plan.placements, 48);
  });
  it.each(["left", "center", "right"] as const)("aligns five compounds' last grid row %s, including unequal sizes", (gridAlignment) => {
    const items = fixtures(5).map((item, i) => ({ ...item, bounds: { ...item.bounds, x: (i % 3) * 250, y: Math.floor(i / 3) * 250 } }));
    const plan = planObjectArrangement(items, "grid", { gridAlignment });
    if (!plan.ok) throw new Error(plan.reason);
    const span = (entries: typeof plan.placements) => ({
      left: Math.min(...entries.map((item) => item.bounds.x)),
      right: Math.max(...entries.map((item) => item.bounds.x + item.bounds.width))
    });
    const top = span(plan.placements.slice(0, 3)), bottom = span(plan.placements.slice(3));
    if (gridAlignment === "left") expect(bottom.left).toBeCloseTo(top.left, 7);
    else if (gridAlignment === "right") expect(bottom.right).toBeCloseTo(top.right, 7);
    else expect((bottom.left + bottom.right) / 2).toBeCloseTo((top.left + top.right) / 2, 7);
    expectClearance(plan.placements, 48);
    const repeated = planObjectArrangement(plan.placements, "grid", { gridAlignment });
    if (!repeated.ok) throw new Error(repeated.reason);
    expect(repeated.placements.every((item) => Math.abs(item.dx) < 1e-7 && Math.abs(item.dy) < 1e-7)).toBe(true);
  });
  it("rejects invalid inputs before producing any moves", () => {
    expect(planObjectArrangement([], "circle")).toEqual({ ok: false, reason: "selection" });
    expect(planObjectArrangement(fixtures(1), "grid")).toEqual({ ok: false, reason: "selection" });
    for (const gap of [-1, NaN, Infinity]) expect(planObjectArrangement(fixtures(3), "circle", { gap }).ok).toBe(false);
    expect(planObjectArrangement(fixtures(3), "grid", { columns: 0 }).ok).toBe(false);
    expect(planObjectArrangement([{ id: "a", bounds: { x: NaN, y: 0, width: 1, height: 1 } }, fixtures(1)[0]], "circle").ok).toBe(false);
  });
});
