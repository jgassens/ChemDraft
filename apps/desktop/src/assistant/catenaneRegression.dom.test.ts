// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { toEngineDocument, type BondRef, type MoleculeObject } from "@chemdraft/chem-core";
import { crossingPairKey, planPageSvgRender } from "@chemdraft/layout-engine";
import { exportDocumentToSvg } from "@chemdraft/export-engine";
import { exportDocumentToPdf } from "@chemdraft/export-engine/pdf";
import { MainWindow } from "../MainWindow";
import { openNativeDocument, normalizeCommittedDocument } from "../documentWorkflow";

type Point = { x: number; y: number };
type Line = [Point, Point];
type Matrix = [number, number, number, number, number, number];
const identity = (): Matrix => [1, 0, 0, 1, 0, 0];
const multiply = ([a,b,c,d,e,f]: Matrix, n: Matrix): Matrix =>
  [a*n[0]+c*n[1], b*n[0]+d*n[1], a*n[2]+c*n[3], b*n[2]+d*n[3], a*n[4]+c*n[5]+e, b*n[4]+d*n[5]+f];
const point = (m: Matrix, p: Point): Point => ({ x: m[0]*p.x+m[2]*p.y+m[4], y: m[1]*p.x+m[3]*p.y+m[5] });
function transform(value: string): Matrix {
  let matrix = identity();
  for (const match of value.matchAll(/(translate|rotate|scale)\(([^)]+)\)/g)) {
    const n = match[2]!.trim().split(/[ ,]+/).map(Number);
    let next: Matrix;
    if (match[1] === "translate") next = [1,0,0,1,n[0]!,n[1] ?? 0];
    else if (match[1] === "scale") next = [n[0]!,0,0,n[1] ?? n[0]!,0,0];
    else {
      const angle = n[0]! * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
      const x = n[1] ?? 0, y = n[2] ?? 0;
      next = [c,s,-s,c,x-c*x+s*y,y-s*x-c*y];
    }
    matrix = multiply(matrix, next);
  }
  return matrix;
}
function svgLines(root: Element): Map<string, Line[]> {
  const result = new Map<string, Line[]>();
  function visit(element: Element, matrix: Matrix, owner = "") {
    matrix = multiply(matrix, transform(element.getAttribute("transform") ?? ""));
    owner = element.getAttribute("data-object-id") ?? owner;
    if (element.matches("line[data-bond-order]")) {
      const key = JSON.stringify([owner, element.getAttribute("data-bond-id")]);
      const lines = result.get(key) ?? [];
      lines.push([point(matrix, { x: Number(element.getAttribute("x1")), y: Number(element.getAttribute("y1")) }),
        point(matrix, { x: Number(element.getAttribute("x2")), y: Number(element.getAttribute("y2")) })]);
      result.set(key, lines);
    }
    for (const child of element.children) visit(child, matrix, owner);
  }
  visit(root, identity());
  return result;
}
const near = (a: Point, b: Point, tolerance = 0.002) => Math.hypot(a.x-b.x,a.y-b.y) < tolerance;
const distanceToLine = (p: Point, [a,b]: Line) => {
  const dx=b.x-a.x, dy=b.y-a.y;
  const t=Math.max(0,Math.min(1,((p.x-a.x)*dx+(p.y-a.y)*dy)/(dx*dx+dy*dy)));
  return Math.hypot(p.x-a.x-t*dx,p.y-a.y-t*dy);
};

it("keeps both saved 30-ring crossings and every canvas/SVG/PDF gap at the intersecting bonds", async () => {
  const opened = openNativeDocument(readFileSync("packages/cdx-compat/src/fixtures/c5-catenane.chemdraft", "utf8"));
  expect(opened.document).toBeDefined();
  const nativeDocument = normalizeCommittedDocument(toEngineDocument(opened.document!));
  const page = nativeDocument.pages[0]!;
  const molecules = page.objects as MoleculeObject[];
  expect(molecules.map(m => [m.atoms.length,m.bonds.length,m.rotation])).toEqual([[30,30,0],[30,30,90]]);
  const plan = planPageSvgRender(page);
  expect(page.crossings).toHaveLength(2); // Four reciprocal CDXML CrossingBonds attributes.
  expect(plan.crossings).toHaveLength(2);
  for (const saved of page.crossings) {
    const resolved = plan.crossings.find(c => c.key === crossingPairKey(saved.bonds))!;
    expect(resolved.hasOverride).toBe(true);
    for (const ref of saved.bonds) {
      const m = molecules.find(m => m.id === ref.objectId)!;
      const b = m.bonds.find(b => b.id === ref.bondId)!;
      const matrix = transform(`rotate(${m.rotation} ${m.x+m.width/2} ${m.y+m.height/2})`);
      const line = [b.fromAtomId,b.toAtomId].map(id => point(matrix,m.atoms.find(a => a.id === id)!)) as Line;
      expect(distanceToLine(resolved.point,line)).toBeLessThan(1e-8);
    }
  }

  const parse = (svg: string) => new DOMParser().parseFromString(svg,"image/svg+xml").documentElement;
  const exported = svgLines(parse(exportDocumentToSvg(nativeDocument).contents));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);
  vi.stubGlobal("ResizeObserver",class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal("requestAnimationFrame",() => 0);
  vi.stubGlobal("cancelAnimationFrame",() => {});
  vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(null);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(createElement(MainWindow,{ initialDocument:nativeDocument,
      initialPaletteMode:"hidden",nativePalette:true,initialRulersVisible:false,initialCrosshairsVisible:false })));
    const canvas = new Map<string, Line[]>();
    for (const m of molecules) {
      const frame = container.querySelector<HTMLElement>(`.native-molecule-object[data-object-id="${m.id}"]`)!;
      expect(frame.style.transform).toBe(m.rotation ? `rotate(${m.rotation}deg)` : "");
      const visual = frame.querySelector("[data-native-molecule-overlay-visual]")!;
      // Reconstruct the actual HTML frame rotation and local SVG viewport in page coordinates.
      const actual = parse(`<svg xmlns="http://www.w3.org/2000/svg"><g data-object-id="${m.id}" transform="rotate(${m.rotation} ${m.x+m.width/2} ${m.y+m.height/2}) translate(${m.x} ${m.y})">${visual.outerHTML}</g></svg>`);
      for (const [key,lines] of svgLines(actual)) canvas.set(key,lines);
    }
    expect([...canvas.keys()].sort()).toEqual([...exported.keys()].sort());
    for (const [key,lines] of exported) {
      const actual = canvas.get(key)!;
      expect(actual.length).toBe(lines.length);
      lines.forEach((line,i) => line.forEach((p,j) => expect(near(p,actual[i]![j]!)).toBe(true)));
    }
    // Every changed stroke is an underpass; every underpass is empty at its actual intersection.
    const backKey = (ref: BondRef) => JSON.stringify([ref.objectId,ref.bondId]);
    for (const m of molecules) {
      const alone = svgLines(parse(exportDocumentToSvg({ ...nativeDocument,pages:[{ ...page,objects:[m],crossings:[] }] }).contents));
      for (const b of m.bonds) {
        const key = backKey({objectId:m.id,bondId:b.id});
        const crossing = plan.crossings.find(c => backKey(c.back) === key);
        if (!crossing) expect(exported.get(key)).toEqual(alone.get(key));
        else for (const line of exported.get(key)!) expect(distanceToLine(crossing.point,line)).toBeGreaterThan(crossing.clearancePx/2-0.01);
      }
    }
    const pdf = await exportDocumentToPdf(nativeDocument,{compress:false});
    const pdfLines = pdfStrokeLines(Buffer.from(pdf.bytes).toString("latin1"),page.height);
    const svgInk = [...exported.values()].flat();
    expect(pdfLines).toHaveLength(svgInk.length);
    for (const line of svgInk) expect(pdfLines.some(actual => near(actual[0],line[0]) && near(actual[1],line[1]))).toBe(true);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});

// Decode painted PDF line paths independently of svg2pdf; undo PDF's points/y-up frame.
function pdfStrokeLines(source: string, pageHeight: number): Line[] {
  let matrix = identity(), path: Point[] = [];
  const stack: Matrix[] = [], lines: Line[] = [];
  for (const stream of source.matchAll(/stream\n([\s\S]*?)\nendstream/g)) for (const row of stream[1]!.split("\n")) {
    const parts = row.trim().split(/\s+/), op = parts.pop(), n = parts.map(Number);
    if (op === "q") stack.push([...matrix]);
    else if (op === "Q") matrix = stack.pop()!;
    else if (op === "cm") matrix = multiply(matrix,n as Matrix);
    else if (op === "m" || op === "l") path.push(point(matrix,{x:n[0]!,y:n[1]!}));
    else if (op === "S") {
      if (path.length === 2) lines.push(path.map(p => ({x:p.x/0.75,y:pageHeight-p.y/0.75})) as Line);
      path=[];
    } else if (["n","f","f*","B","B*"].includes(op ?? "")) path=[];
  }
  return lines;
}
