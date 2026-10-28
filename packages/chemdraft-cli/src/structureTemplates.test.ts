import { describe, expect, it } from "vitest";
import { DocumentStylePreset } from "@chemdraft/chem-core";
import { resolveStructureTemplateName } from "@chemdraft/document-workflow-core";
import { buildSmilesDocument } from "./document";
import { runRenderCommand } from "./commands/render";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runNameCommand } from "./commands/name";
import { runDocumentCommand } from "./commands/document";
import { runExportCommand } from "./commands/export";
import { renderGrid } from "./commands/grid";
import { renderReactionScheme } from "./commands/reaction";

describe("headless template layout substitution", () => {
  const template = resolveStructureTemplateName("beta-cyclodextrin")!;
  it("renders an exact isomeric match using the original layout at default size", async () => {
    const built = await buildSmilesDocument(template.smiles);
    expect(built.layout).toBe(`template:${template.id}`);
    const atoms = new Map(built.molecule.atoms.map(atom => [atom.id, atom]));
    const lengths = built.molecule.bonds.map(bond => {
      const a = atoms.get(bond.fromAtomId)!, b = atoms.get(bond.toAtomId)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    });
    expect(lengths.reduce((a, b) => a + b, 0) / lengths.length)
      .toBeCloseTo(DocumentStylePreset.drawing.bondLengthPx, 6);
  }, 60_000);
  it.each([
    ["stereo-different", template.smiles.replace("@@", "@")],
    ["stereo-free", template.smiles.replaceAll("@", "")]
  ])("does not substitute %s input", async (_label, smiles) => {
    expect((await buildSmilesDocument(smiles)).layout).toBeUndefined();
  }, 60_000);
  it("reports the layout in render and name --render JSON Lines", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chemdraft-template-"));
    const lines: string[] = [];
    const io = { stdout: (line: string) => lines.push(line), stderr: () => {} };
    try {
      expect(await runRenderCommand(["--smiles", template.smiles, "--out", join(dir, "cd.svg")], io)).toBe(0);
      expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: true, layout: `template:${template.id}` });
      expect(await runNameCommand(["--name", "β-CD", "--render", join(dir, "cd.png")], io,
        { opsinPaths: { javaPath: join(dir, "absent"), jarPath: join(dir, "absent.jar") } })).toBe(0);
      expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: true, source: "template", layout: `template:${template.id}` });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
  it("shares template layouts across native documents, exports, grids and reactions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "chemdraft-template-paths-"));
    const lines: string[] = [];
    const io = { stdout: (line: string) => lines.push(line), stderr: () => {} };
    try {
      for (const [run, file] of [[runDocumentCommand, "cd.json"], [runExportCommand, "cd.mol"]] as const) {
        expect(await run(["--smiles", template.smiles, "--out", join(dir, file)], io)).toBe(0);
        expect(JSON.parse(lines.pop()!)).toMatchObject({ ok: true, layout: `template:${template.id}` });
      }
      const grid = await renderGrid([{ name: "cd", smiles: template.smiles }], {
        columns: 1, gutter: 32, labels: "none", background: "white", padding: 24, width: 400
      }, io);
      expect(grid.cells[0]?.layout).toBe(`template:${template.id}`);
      const reaction = await renderReactionScheme({ reactants: [template.smiles], agents: [], products: ["CC"] });
      expect(reaction.layouts[0]).toMatchObject({ smiles: template.smiles, layout: `template:${template.id}` });
      expect(reaction.layouts[1]?.layout).toBeUndefined();
    } finally { await rm(dir, { recursive: true, force: true }); }
  }, 60_000);
});
