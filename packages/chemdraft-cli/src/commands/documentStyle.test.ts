import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSDOM } from "jsdom";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { buildSmilesDocument, canonicalSmiles, currentMoleculeIdentityMolfile, renderSmilesToAssets } from "../document";
import { runRenderCommand } from "./render";
import { runGridCommand } from "./grid";
import { runReactionCommand } from "./reaction";
import { runDocumentCommand } from "./document";
import { runRenderDocumentCommand } from "./renderDocument";
import type { CliIo } from "../output";

const structures = [
  { name: "methane", smiles: "C" },
  { name: "aspirin", smiles: "CC(=O)Oc1ccccc1C(=O)O" },
  { name: "strychnine", smiles: "O=C1C[C@H]2OCC=C3CN4CC[C@@]56[C@@H]4C[C@@H]3[C@@H]2[C@@H]6N1c1ccccc15" }
];
let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "document-style-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function capture() {
  const lines: string[] = [], errors: string[] = [];
  const io: CliIo = { stdout: (line) => lines.push(line), stderr: (line) => errors.push(line) };
  return { io, lines, errors, result: () => JSON.parse(lines.at(-1)!) as Record<string, unknown> };
}

/** Apply every ancestor transform, including the physical root scale, to a point. */
function point(element: Element, x: number, y: number): [number, number] {
  for (let node: Element | null = element; node; node = node.parentElement) {
    const transforms = [...(node.getAttribute("transform") ?? "").matchAll(/(translate|scale|rotate)\(([^)]+)\)/g)].reverse();
    for (const transform of transforms) {
      const [a = 0, b, c] = transform[2]!.split(/[ ,]+/).map(Number);
      if (transform[1] === "translate") { x += a; y += b ?? 0; }
      if (transform[1] === "scale") { x *= a; y *= b ?? a; }
      if (transform[1] === "rotate") {
        const cx = b ?? 0, cy = c ?? 0, angle = a * Math.PI / 180;
        const dx = x - cx, dy = y - cy;
        x = cx + dx * Math.cos(angle) - dy * Math.sin(angle);
        y = cy + dx * Math.sin(angle) + dy * Math.cos(angle);
      }
    }
  }
  return [x, y];
}
function scale(element: Element) {
  const a = point(element, 0, 0), b = point(element, 1, 0);
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}
function median(values: number[]) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; }

function measure(svg: string) {
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  try {
    const root = dom.window.document.documentElement;
    const box = root.getAttribute("viewBox")!.split(/\s+/).map(Number);
    for (const [index, name] of ["width", "height"].entries()) {
      expect(root.getAttribute(name)).toMatch(/pt$/);
      expect(parseFloat(root.getAttribute(name)!)).toBe(box[index + 2]);
    }
    const bonds: number[] = [], strokes: number[] = [];
    // Only single, unclipped C–C bonds measure the full atom-to-atom bond length. Bonds
    // ending at labels, secondary double strokes and crossing gaps intentionally have shorter ink.
    for (const molecule of root.querySelectorAll("[data-chem-primitive]")) {
      const objectId = molecule.getAttribute("data-object-id");
      const labels = [...root.querySelectorAll("[data-atom-label]")].filter((label) => label.getAttribute("data-object-id") === objectId || label.closest("[data-object-id]")?.getAttribute("data-object-id") === objectId).map((label) => point(label, 0, 0));
      const groups = molecule.hasAttribute("data-bond-layer-id") ? [molecule] : [...molecule.querySelectorAll("[data-bond-layer-id]")];
      for (const group of groups) {
        const lines = group.querySelectorAll("line[stroke-width]");
        for (const line of lines) strokes.push(Number(line.getAttribute("stroke-width")) * scale(line));
        if (lines.length !== 1 || group.querySelector("polygon, path")) continue;
        const line = lines[0]!;
        const a = point(line, Number(line.getAttribute("x1")), Number(line.getAttribute("y1")));
        const b = point(line, Number(line.getAttribute("x2")), Number(line.getAttribute("y2")));
        if (labels.some((label) => Math.min(Math.hypot(a[0] - label[0], a[1] - label[1]), Math.hypot(b[0] - label[0], b[1] - label[1])) < 10)) continue;
        bonds.push(Math.hypot(a[0] - b[0], a[1] - b[1]));
      }
    }
    if ([...root.querySelectorAll("[data-bond-count]")].some((node) => Number(node.getAttribute("data-bond-count")) > 0)) {
      expect(bonds.length).toBeGreaterThan(0);
      expect(strokes.length).toBeGreaterThan(0);
    }
    if (bonds.length) expect(Math.abs(median(bonds) - 14.4)).toBeLessThan(14.4 * 0.02);
    for (const stroke of strokes) expect(Math.abs(stroke - 1.134)).toBeLessThan(1.134 * 0.01);
    const fonts = [...root.querySelectorAll("[data-atom-label]")].map((label) => {
      expect(label.getAttribute("font-family")).toBe("Arial");
      const size = Number(label.getAttribute("font-size")) * scale(label);
      expect(size).toBeCloseTo(10, 2); return size;
    });
    // Caption and conditions text share the physical text preset.
    for (const text of root.querySelectorAll("text[font-family]")) {
      expect(text.getAttribute("font-family")).toBe("Arial");
      expect(Number(text.getAttribute("font-size")) * scale(text)).toBeCloseTo(10, 2);
    }
    const measured = { widthPt: box[2]!, heightPt: box[3]!, bondPt: bonds.length ? median(bonds) : null,
      strokePt: strokes.length ? median(strokes) : null, fontPt: fonts.length ? median(fonts) : null };
    console.log(JSON.stringify(measured));
    return measured;
  } finally { dom.window.close(); }
}

async function verifyIdentity(document: ChemDraftDocument) {
  for (const molecule of document.pages[0]!.objects.filter((object): object is MoleculeObject => object.type === "molecule")) {
    const current = await currentMoleculeIdentityMolfile(molecule);
    expect(await canonicalSmiles(current.contents, "output")).toBe(await canonicalSmiles(molecule.structure, "input"));
  }
}

async function verifySvgIdentity(svg: string, inputs: string[]) {
  const dom = new JSDOM(svg, { contentType: "image/svg+xml" });
  try {
    const sources = new Map<string, string>();
    // XML parsers normalize attribute newlines to spaces. Read the CTAB from the source
    // and decode its entities as text, preserving the original molfile line boundaries.
    for (const match of svg.matchAll(/data-object-id="([^"]+)"[^>]*data-structure="([^"]*)"/g)) {
      const decoded = dom.window.document.createElement("identity");
      decoded.innerHTML = match[2]!;
      sources.set(match[1]!, decoded.textContent!);
    }
    const actual = await Promise.all([...sources.values()].map((molfile) => canonicalSmiles(molfile, "SVG")));
    const expected = await Promise.all(inputs.map((smiles) => canonicalSmiles(smiles, "input")));
    expect(actual.sort()).toEqual(expected.sort());
  } finally { dom.window.close(); }
}

describe("fixed-scale document figures", () => {
  it("renders small and large structures, a grid and a reaction at one physical scale", async () => {
    const sizes = [];
    for (const structure of structures) {
      const out = join(directory, `${structure.name}.svg`), captureIo = capture();
      expect(await runRenderCommand(["--smiles", structure.smiles, "--out", out, "--format", "svg", "--style", "document"], captureIo.io), captureIo.errors.join("\n")).toBe(0);
      expect(captureIo.result().style).toBe("document");
      console.log(structure.name);
      const svg = await readFile(out, "utf8");
      sizes.push(measure(svg));
      await verifySvgIdentity(svg, [structure.smiles]);
      const built = await buildSmilesDocument(structure.smiles, { style: "document" });
      expect(await canonicalSmiles(built.identityMolfile, "output")).toBe(await canonicalSmiles(structure.smiles, "input"));
      await verifyIdentity(built.document);
    }
    expect(sizes[0]!.widthPt * sizes[0]!.heightPt).toBeLessThan(sizes[2]!.widthPt * sizes[2]!.heightPt / 4);
    const batch = join(directory, "batch.json"), grid = join(directory, "grid.svg");
    await writeFile(batch, JSON.stringify(structures));
    const gridIo = capture();
    expect(await runGridCommand(["--batch", batch, "--out", grid, "--style", "document"], gridIo.io), gridIo.errors.join("\n")).toBe(0);
    console.log("grid"); measure(await readFile(grid, "utf8"));
    await verifySvgIdentity(await readFile(grid, "utf8"), structures.map((structure) => structure.smiles));
    const reaction = join(directory, "reaction.svg"), reactionIo = capture();
    expect(await runReactionCommand(["--rxn", "CCO.CC(=O)O>>CCOC(C)=O", "--conditions", "room temperature", "--out", reaction, "--style", "document"], reactionIo.io), reactionIo.errors.join("\n")).toBe(0);
    console.log("reaction"); measure(await readFile(reaction, "utf8"));
    await verifySvgIdentity(await readFile(reaction, "utf8"), ["CCO", "CC(=O)O", "CCOC(C)=O"]);
  }, 60_000);

  it("keeps unspecified alkene stereochemistry through native rescaling", async () => {
    const built = await buildSmilesDocument("CC=CCC", { bondLength: 40 });
    const native = join(directory, "unknown-alkene.json"), out = join(directory, "unknown-alkene.svg");
    await writeFile(native, JSON.stringify(built.document));
    const result = capture();
    expect(await runRenderDocumentCommand(["--document", native, "--out", out, "--style", "document"], result.io), result.errors.join("\n")).toBe(0);
    expect((result.result().molecules as { unspecifiedDoubleBonds: number }[])[0]!.unspecifiedDoubleBonds).toBe(1);
    await verifySvgIdentity(await readFile(out, "utf8"), ["CC=CCC"]);
  }, 60_000);

  it("preserves natural scale through native document build/render and rasterizes by DPI", async () => {
    const native = join(directory, "native.json"), svg = join(directory, "native.svg"), builtIo = capture();
    expect(await runDocumentCommand(["--smiles", structures[1]!.smiles, "--out", native, "--style", "document"], builtIo.io)).toBe(0);
    const renderIo = capture();
    expect(await runRenderDocumentCommand(["--document", native, "--out", svg, "--style", "document"], renderIo.io), renderIo.errors.join("\n")).toBe(0);
    expect(builtIo.result().widthPt).toBeCloseTo(Number(renderIo.result().widthPt), 6);
    expect(builtIo.result().heightPt).toBeCloseTo(Number(renderIo.result().heightPt), 6);
    const rendered = await renderSmilesToAssets(structures[1]!.smiles, { style: "document", dpi: 300 });
    expect(measure(await readFile(svg, "utf8"))).toEqual(measure(rendered.svg));
    expect(rendered.png[0]).toBe(137);
    expect(Buffer.from(rendered.png).readUInt32BE(16)).toBeCloseTo(rendered.viewBox.width * 300 / 72, -0.1);
    const out = join(directory, "physical.png"), pngIo = capture();
    expect(await runRenderCommand(["--smiles", "CC", "--out", out, "--style", "document", "--dpi", "600"], pngIo.io)).toBe(0);
    expect(pngIo.result()).toMatchObject({ style: "document", dpi: 600, widthPt: expect.any(Number), heightPt: expect.any(Number) });
  }, 60_000);

  it.each([
    ["--style", "document", "--width", "600"],
    ["--style", "document", "--bond-length", "22"],
    ["--style", "document", "--padding", "4"],
    ["--dpi", "300"], ["--style", "unknown"],
    ["--style", "document", "--dpi", "71"], ["--style", "document", "--dpi", "1201"]
  ])("rejects conflicting or invalid arguments %s", async (...flags) => {
    for (const command of [runRenderCommand, runGridCommand, runReactionCommand, runRenderDocumentCommand, runDocumentCommand]) {
      const captureIo = capture();
      expect(await command(flags, captureIo.io)).toBe(2);
      expect(captureIo.errors[0]).toMatch(/--style|--dpi/);
    }
  });
});
