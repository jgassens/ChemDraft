import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { atomLabelHaloWidthPx, planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import { resetRdkitForTesting } from "@chemdraft/rdkit-adapter";

import {
  renderReactionScheme,
  runReactionCommand,
  type RenderedReactionScheme
} from "./reaction";

vi.setConfig({ testTimeout: 60_000 });

let outputDirectory: string;

beforeAll(async () => {
  outputDirectory = await mkdtemp(join(tmpdir(), "chemdraft-reaction-cli-"));
});

afterAll(async () => {
  resetRdkitForTesting();
  await rm(outputDirectory, { recursive: true, force: true });
});

function expectInsideViewBox(
  rendered: RenderedReactionScheme,
  x: number,
  y: number,
  label: string
): void {
  const { viewBox } = rendered;
  expect(x, `${label} x`).toBeGreaterThanOrEqual(viewBox.x - 0.001);
  expect(y, `${label} y`).toBeGreaterThanOrEqual(viewBox.y - 0.001);
  expect(x, `${label} x`).toBeLessThanOrEqual(viewBox.x + viewBox.width + 0.001);
  expect(y, `${label} y`).toBeLessThanOrEqual(viewBox.y + viewBox.height + 0.001);
}

function expectSchemeInsideViewBox(rendered: RenderedReactionScheme): void {
  for (const object of rendered.document.pages[0]?.objects ?? []) {
    expectInsideViewBox(rendered, object.x, object.y, `${object.id} top-left`);
    expectInsideViewBox(
      rendered,
      object.x + object.width,
      object.y + object.height,
      `${object.id} bottom-right`
    );
    if (object.type === "molecule") {
      for (const atom of object.atoms) {
        expectInsideViewBox(rendered, atom.x, atom.y, `${object.id}/${atom.id}`);
      }
      for (const label of planMoleculeAtomLabels(object)) {
        const halo = label.backgroundVisible ? atomLabelHaloWidthPx(label.drawingStyle) / 2 : 0;
        expectInsideViewBox(
          rendered,
          label.anchor.x + label.layout.bounds.x - halo,
          label.anchor.y + label.layout.bounds.y - halo,
          `${object.id}/${label.label} label top-left`
        );
        expectInsideViewBox(
          rendered,
          label.anchor.x + label.layout.bounds.x + label.layout.bounds.width + halo,
          label.anchor.y + label.layout.bounds.y + label.layout.bounds.height + halo,
          `${object.id}/${label.label} label bottom-right`
        );
      }
    }
    if (object.type === "reaction-arrow") {
      if (object.start.kind === "point" && object.start.point) {
        expectInsideViewBox(rendered, object.start.point.x, object.start.point.y, "arrow start");
      }
      if (object.end.kind === "point" && object.end.point) {
        expectInsideViewBox(rendered, object.end.point.x, object.end.point.y, "arrow end");
      }
    }
  }
}

describe("chemdraft reaction", () => {
  it("renders esterification as one cropped scheme with molecule, arrow, plus, and condition objects", async () => {
    const rendered = await renderReactionScheme(
      "CC(=O)O.OCC>OS(=O)(=O)O>CC(=O)OCC",
      { conditions: "heat" }
    );
    const objects = rendered.document.pages[0]!.objects;

    expect(objects.filter((object) => object.type === "molecule")).toHaveLength(3);
    expect(objects.filter((object) => object.type === "reaction-arrow")).toHaveLength(1);
    expect(objects.filter((object) => object.type === "text" && object.text === "+")).toHaveLength(1);
    expect(objects.filter((object) =>
      object.type === "text" && object.text === "H2SO4, heat"
    )).toHaveLength(1);
    expect(rendered.svg).toContain("H2SO4, heat");
    expect(rendered.agentTexts).toEqual([{
      smiles: "OS(=O)(=O)O",
      text: "H2SO4",
      source: "formula",
      hillFormula: "H2O4S"
    }]);
    expectSchemeInsideViewBox(rendered);
  });

  it("keeps ionic charge on agent formulas and writes carbon-free formulas in conventional order", async () => {
    const rendered = await renderReactionScheme(
      "CC(=O)O.OCC>[O-]S(=O)(=O)O.Cl.[OH-].[Na+].[NH4+].[O-]S(=O)(=O)[O-].Br.F.N>CC(=O)OCC"
    );
    expect(rendered.agentTexts.map((agent) => [agent.smiles, agent.text, agent.hillFormula])).toEqual([
      ["[O-]S(=O)(=O)O", "HSO4⁻", "HO4S"],
      ["Cl", "HCl", "ClH"],
      ["[OH-]", "OH⁻", "HO"],
      ["[Na+]", "Na⁺", "Na"],
      ["[NH4+]", "NH4⁺", "H4N"],
      ["[O-]S(=O)(=O)[O-]", "SO4²⁻", "O4S"],
      ["Br", "HBr", "BrH"],
      ["F", "HF", "FH"],
      ["N", "NH3", "H3N"]
    ]);
    expect(rendered.agentTexts.every((agent) => agent.source === "formula")).toBe(true);
    expect(rendered.svg).toContain("HSO4⁻, HCl, OH⁻, Na⁺, NH4⁺, SO4²⁻, HBr, HF, NH3");
  }, 60_000);

  it("labels the reviewer's bisulfate and HCl agents with charge and H-first order", async () => {
    const rendered = await renderReactionScheme("CC(=O)O.OCC>[O-]S(=O)(=O)O.Cl>CC(=O)OCC");
    expect(rendered.agentTexts.map((agent) => agent.text)).toEqual(["HSO4⁻", "HCl"]);
  }, 60_000);

  it("writes inorganic salts cation-first while retaining conventional anion order", async () => {
    const agents = [
      "[Na+].[BH4-]",
      "O=C([O-])[O-].[K+].[K+]",
      "[Na+].[OH-]",
      "[Na]O",
      "[Na+].[C-]#N",
      "[Li+].[AlH4-]",
      "[Na+].O=C([O-])O",
      "[K+].[O-][Mn](=O)(=O)=O",
      "O=S(=O)([O-])[O-].[Na+].[Na+]",
      "[NH4+].[Cl-]",
      "CCN(CC)CC",
      "Cl",
      "OS(=O)(=O)O",
      "O=S(=O)(O)[O-]",
      "O=S(=O)([O-])[O-]",
      "[Na+]"
    ];
    const rendered = await renderReactionScheme({
      reactants: ["CCO"],
      agents,
      products: ["CC=O"]
    });

    expect(rendered.agentTexts.map((agent) => agent.text)).toEqual([
      "NaBH4", "K2CO3", "NaOH", "NaOH", "NaCN", "LiAlH4", "NaHCO3", "KMnO4",
      "Na2SO4", "NH4Cl", "C6H15N", "HCl", "H2SO4", "HSO4⁻", "SO4²⁻", "Na⁺"
    ]);
  });

  it("places retrosynthesis targets left of the arrow and precursors right", async () => {
    const rendered = await renderReactionScheme("CCO>>CC=O", { arrow: "retrosynthesis" });
    const objects = rendered.document.pages[0]!.objects;
    const arrow = objects.find((object) => object.type === "reaction-arrow");
    const molecules = objects.filter((object) => object.type === "molecule");
    const product = molecules.find((molecule) => molecule.bonds.some((bond) => bond.order === "double"));
    const reactant = molecules.find((molecule) => molecule.bonds.every((bond) => bond.order !== "double"));
    const minX = (molecule: NonNullable<typeof product>) => Math.min(...molecule.atoms.map((atom) => atom.x));

    expect(arrow?.start.kind).toBe("point");
    expect(arrow?.end.kind).toBe("point");
    expect(product).toBeDefined();
    expect(reactant).toBeDefined();
    expect(minX(product!)).toBeLessThan(arrow!.start.point!.x);
    expect(minX(reactant!)).toBeGreaterThan(arrow!.end.point!.x);
  });

  it("fails invalid and radical agents by naming the agent SMILES", async () => {
    for (const agent of ["not-a-smiles", "[CH3]"]) {
      const stdout: string[] = [];
      const code = await runReactionCommand(
        ["--reactant", "CCO", "--agent", agent, "--product", "CC=O", "--out", join(outputDirectory, `${agent === "[CH3]" ? "radical" : "bad"}-agent.svg`)],
        { stdout: (line) => stdout.push(line), stderr: () => undefined }
      );
      expect(code).toBe(1);
      expect(stdout).toHaveLength(1);
      expect(JSON.parse(stdout[0]!).error).toContain(agent);
    }
  });

  it("rejects out-of-range reaction widths before rendering batch jobs", async () => {
    const jobsPath = join(outputDirectory, "too-wide-reaction.json");
    await writeFile(jobsPath, JSON.stringify([
      { name: "too-wide", rxn: "CCO>>CC=O", width: 5000 }
    ]));
    const stdout: string[] = [];
    const code = await runReactionCommand(
      ["--batch", jobsPath, "--out-dir", join(outputDirectory, "too-wide-reactions")],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );
    expect(code).toBe(2);
    expect(stdout).toEqual([]);
  });

  it("keeps a charged product's complete label boxes inside the reaction viewBox", async () => {
    const rendered = await renderReactionScheme("CCO>>[NH3+]CCCCCCCCC[NH3+]");
    expect(rendered.svg).toContain("NH3+");
    expectSchemeInsideViewBox(rendered);
  });

  it("preserves a dot-joined salt as one molecule object with repeated role flags", async () => {
    const salt = "[Na+].[O-]C(=O)C";
    const rendered = await renderReactionScheme({
      reactants: [salt],
      agents: [],
      products: ["CC(=O)O"]
    });
    const molecules = rendered.document.pages[0]!.objects.filter((object) => object.type === "molecule");
    expect(rendered.reactants).toEqual([salt]);
    expect(molecules).toHaveLength(2);
    expect(molecules[0]!.atoms).toHaveLength(5);

    const output = join(outputDirectory, "salt.svg");
    const stdout: string[] = [];
    expect(await runReactionCommand([
      "--reactant", salt,
      "--product", "CC(=O)O",
      "--out", output
    ], { stdout: (line) => stdout.push(line), stderr: () => undefined })).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ reactants: [salt], products: ["CC(=O)O"] });
  });

  it("uses the requested equilibrium arrow kind", async () => {
    const output = join(outputDirectory, "equilibrium.svg");
    const stdout: string[] = [];
    const code = await runReactionCommand(
      ["--rxn", "CCO>>CC=O", "--out", output, "--arrow", "equilibrium"],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );

    expect(code).toBe(0);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: true, arrow: "equilibrium", out: output });
    expect(await readFile(output, "utf8")).toContain('data-arrow-kind="equilibrium"');
  });

  it("uses a 1000 px default width for PNG reaction schemes", async () => {
    const output = join(outputDirectory, "default-width.png");
    expect(await runReactionCommand(
      ["--rxn", "CCO>>CC=O", "--out", output],
      { stdout: () => undefined, stderr: () => undefined }
    )).toBe(0);
    const png = await readFile(output);
    const width = png.readUInt32BE(16);
    expect(width).toBe(1000);
  });

  it("returns exit 2 when reaction SMILES does not have two separators", async () => {
    const stderr: string[] = [];
    const code = await runReactionCommand(
      ["--rxn", "CCO", "--out", join(outputDirectory, "invalid.svg")],
      { stdout: () => undefined, stderr: (line) => stderr.push(line) }
    );

    expect(code).toBe(2);
    expect(stderr.join("\n")).toContain('exactly two ">" separators');
  });

  it("fails a radical component without a stack trace and names its SMILES", async () => {
    const stdout: string[] = [];
    const code = await runReactionCommand(
      ["--rxn", "[CH3]>>C", "--out", join(outputDirectory, "radical.svg")],
      { stdout: (line) => stdout.push(line), stderr: () => undefined }
    );

    expect(code).toBe(1);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({ ok: false });
    expect(JSON.parse(stdout[0]!).error).toContain('[CH3]');
    expect(JSON.parse(stdout[0]!).error).not.toContain("\n    at ");
  });

  it("places a plus text object between multiple products", async () => {
    const rendered = await renderReactionScheme("CCO>>CC=O.O");
    const plusSigns = rendered.document.pages[0]!.objects.filter((object) =>
      object.type === "text" && object.text === "+"
    );

    expect(rendered.products).toEqual(["CC=O", "O"]);
    expect(plusSigns).toHaveLength(1);
  });
});
