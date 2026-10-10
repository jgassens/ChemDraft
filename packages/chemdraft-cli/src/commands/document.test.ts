import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import type { ChemDraftDocument, MoleculeObject } from "@chemdraft/chem-core";
import { nativeMoleculeRings } from "@chemdraft/layout-engine";
import { buildSmilesDocument, renderSmilesToAssets } from "../document";
import { MAX_DOCUMENT_BYTES, validateDocumentOutputPath } from "../documentInput";
import { runCli } from "../cli";
import type { CliIo } from "../output";

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "chemdraft-document-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });
async function run(args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const io: CliIo = { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) };
  const code = await runCli(args, io);
  return { code, stdout, stderr, result: stdout.length ? JSON.parse(stdout[0]!) : undefined };
}

describe("native document agent commands", () => {
  it("builds a fused bicyclic with input atom indices, ids, page size and centers inside each ring", async () => {
    const out = join(directory, "decalin.json");
    const result = await run(["document", "--smiles", "C1CCC2CCCCC2C1", "--out", out]);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.stdout).toHaveLength(1);
    const native = openChemDraftPayload(await readFile(out, "utf8")).document!;
    expect(native.schema).toBe("chemdraft.document.v1");
    expect(result.result.pages[0]).toMatchObject({ width: native.pages[0]!.width, height: native.pages[0]!.height });
    const molecule = native.pages[0]!.objects[0] as MoleculeObject;
    const inventory = result.result.molecules[0];
    expect(inventory.atoms.map((atom: { inputAtomIndex: number }) => atom.inputAtomIndex)).toEqual([0,1,2,3,4,5,6,7,8,9]);
    expect(inventory.objectId).toBe(molecule.id);
    expect(inventory.bonds.map((bond: { id: string }) => bond.id)).toEqual(molecule.bonds.map((bond) => bond.id));
    expect(inventory.rings).toHaveLength(2);
    for (const ring of nativeMoleculeRings(molecule)) {
      expect(inventory.rings).toContainEqual({ ringKey: ring.ringKey, atomIds: [...ring.atomIds],
        bondIds: [...ring.bondIds], center: ring.center, size: 6 });
      // These rings are convex: every edge has the same signed cross product about the center.
      const signs = ring.points.map((point, index) => {
        const next = ring.points[(index + 1) % ring.points.length]!;
        return Math.sign((next.x-point.x)*(ring.center.y-point.y)-(next.y-point.y)*(ring.center.x-point.x));
      });
      expect(new Set(signs).size).toBe(1);
      expect(signs[0]).not.toBe(0);
    }
  }, 60_000);

  it("builds batches with portable paths and rejects unsafe or duplicate names", async () => {
    const batch = join(directory, "jobs.json");
    await writeFile(batch, JSON.stringify([{ name: "Decalin figure", smiles: "C1CCC2CCCCC2C1" }, { name: "ethanol", smiles: "CCO" }]));
    const result = await run(["document", "--batch", batch, "--out-dir", join(directory, "batch figures")]);
    expect(result.code).toBe(0);
    expect(result.stdout).toHaveLength(2);
    expect(JSON.parse(result.stdout[0]!).document).toBe(join(directory, "batch figures", "Decalin figure.json"));
    for (const names of [["../bad"], ["bad\\name"], ["Same", "same"]]) {
      await writeFile(batch, JSON.stringify(names.map((name) => ({ name, smiles: "CCO" }))));
      expect((await run(["document", "--batch", batch, "--out-dir", directory])).code).toBe(2);
    }
    expect(() => validateDocumentOutputPath("C:\\Figures\\safe figure.svg")).not.toThrow();
    for (const path of ["C:\\Figures\\..\\bad.svg", "../bad.svg", "CON.svg", ".hidden.svg", "bad:name.svg"]) {
      expect(() => validateDocumentOutputPath(path)).toThrow();
    }
  });

  it("records the existing explicit hydrogen behavior without changing depiction", async () => {
    const result = await run(["document", "--smiles", "[H]OC([H])([H])C", "--out", join(directory, "hydrogens.json")]);
    expect(result.code).toBe(0);
    expect(result.result.molecules[0].atoms.map((atom: { element: string }) => atom.element)).toEqual(["O", "C", "C"]);
    expect(result.result.molecules[0].atoms.map((atom: { inputAtomIndex: number }) => atom.inputAtomIndex)).toEqual([1, 2, 5]);
  });

  it.each([
    ["C[Si](C)(C)C", [0, 1, 2, 3, 4]],
    ["c1cc[nH]c1", [0, 1, 2, 3, 4]],
    ["c1cc[se]c1", [0, 1, 2, 3, 4]],
    ["ClCBr", [0, 1, 2]],
    ["CCO.O", [0, 1, 2, 3]],
    ["C%12CCCCC%12", [0, 1, 2, 3, 4, 5]]
  ])("maps SMILES atom tokens exactly for %s", async (smiles, expected) => {
    const result = await run(["document", "--smiles", smiles, "--out",
      join(directory, `mapping-${smiles.replace(/[^A-Za-z0-9_-]/g, "_")}.json`)]);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.result.molecules[0].atoms.map((atom: { inputAtomIndex: number | null }) => atom.inputAtomIndex)).toEqual(expected);
  });

  it("leaves wildcard atom input mapping unverified and warns", async () => {
    const result = await run(["document", "--smiles", "*", "--out", join(directory, "wildcard.json")]);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.result.molecules[0].atoms.map((atom: { inputAtomIndex: number | null }) => atom.inputAtomIndex)).toEqual([null]);
    expect(result.result.warnings).toContain("Input atom mapping unavailable; inputAtomIndex is null for unmapped atoms.");
  });

  it("renders an unmodified JSON document with render's chemistry and writes/reopens a native envelope", async () => {
    const smiles = "C[C@H](O)C(=O)O";
    const input = join(directory, "round-trip.json");
    const built = await buildSmilesDocument(smiles);
    const rendered = await renderSmilesToAssets(smiles);
    await writeFile(input, JSON.stringify(built.document));
    const result = await run(["render-document", "--document", input, "--out", join(directory, "round-trip.svg")]);
    expect(result.code, result.stderr.join("\n")).toBe(0);
    expect(result.result.molecules[0]).toMatchObject({ canonicalSmiles: built.sourceCanonicalSmiles,
      stereoCenters: rendered.stereoCenters, unspecifiedStereoCenters: rendered.unspecifiedStereoCenters,
      unspecifiedDoubleBonds: rendered.unspecifiedDoubleBonds });
    const envelope = join(directory, "round-trip.chemdraft");
    expect((await run(["render-document", "--document", input, "--out", envelope])).code).toBe(0);
    const saved = await readFile(envelope, "utf8");
    expect(saved).toContain("<CDXML");
    expect(openChemDraftPayload(saved)).toMatchObject({ source: "native-payload", document: built.document });
    const reopened = await run(["render-document", "--document", envelope, "--out", join(directory, "reopened.png")]);
    expect(reopened.code).toBe(0);
    expect(reopened.result.molecules[0].canonicalSmiles).toBe(built.sourceCanonicalSmiles);
  }, 60_000);

  it("renders ring fill, bold bond, ring letter, rough molecule/art strokes and export warnings in both and PDF", async () => {
    const built = structuredClone(await buildSmilesDocument("C1CCC2CCCCC2C1"));
    const molecule = built.document.pages[0]!.objects[0] as MoleculeObject;
    const ring = nativeMoleculeRings(molecule)[0]!;
    molecule.style.ringStyles = { [ring.ringKey]: { fillColor: "#ffcc66", fillOpacity: 0.4 } };
    molecule.bonds[0]!.display = { bondStyle: "bold" };
    molecule.style.visualEffects = [{ kind: "sketch", seed: 42, roughness: 1.3 }];
    built.document.pages[0]!.objects.push({ id: "ring-letter", type: "text", text: "A", spans: [],
      x: ring.center.x, y: ring.center.y, width: 16, height: 20, rotation: 0, style: { fontSizePx: 18 } });
    built.document.pages[0]!.objects.push({ id: "sketch-art", type: "graphic", graphicKind: "rect", data: {},
      x: 500, y: 500, width: 30, height: 30, rotation: 0,
      style: { strokeColor: "#123456", effect: "reflection", visualEffects: [{ kind: "sketch", seed: 13 }] } });
    built.document.pages[0]!.objects.push({ id: "fallback-art", type: "graphic", graphicKind: "unknown", data: {},
      x: 550, y: 500, width: 20, height: 20, rotation: 0, style: { effect: "reflection" } });
    const input = join(directory, "styled.json");
    await writeFile(input, JSON.stringify(built.document));
    const svgPath = join(directory, "styled.svg");
    const result = await run(["render-document", "--document", input, "--out", svgPath,
      "--format", "both", "--width", "240", "--padding", "30", "--background", "transparent"]);
    expect(result.code, JSON.stringify(result)).toBe(0);
    const svg = await readFile(svgPath, "utf8");
    expect(svg).toContain('fill="#ffcc66"');
    expect(svg).toContain('fill-opacity="0.4"');
    expect(svg).toContain('data-molecule-fill-ring="true"');
    expect(svg).toContain('data-molecule-effect="sketch"');
    expect(svg).toContain('data-graphic-effect="sketch"');
    expect(svg).toMatch(/<path[^>]*data-molecule-effect="sketch"[^>]*d="M/);
    expect(svg).toContain('data-object-id="ring-letter"');
    expect(svg).toContain(">A<");
    const bold = svg.match(/<line[^>]*data-bond-style="bold"[^>]*stroke-width="([\d.]+)"/);
    const ordinary = svg.match(/<line[^>]*data-bond-id="b1"[^>]*stroke-width="([\d.]+)"/);
    expect(bold).not.toBeNull();
    expect(Number(bold![1])).toBeGreaterThan(Number(ordinary![1]));
    const png = await readFile(join(directory, "styled.png"));
    expect(png.readUInt32BE(16)).toBe(240);
    expect(result.result.molecules[0].canonicalSmiles).toBe(built.sourceCanonicalSmiles);
    expect(result.result.exportWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "export.svg.graphic_fallback", objectId: "fallback-art" }),
      expect.objectContaining({ code: "export.svg.graphic_effect_approximation", objectId: "sketch-art" })
    ]));
    expect(result.result.molecules[0].exportWarnings).toBeInstanceOf(Array);
    const envelope = join(directory, "styled.chemdraft");
    expect((await run(["render-document", "--document", input, "--out", envelope])).code).toBe(0);
    const reopenedPath = join(directory, "styled-reopened.svg");
    expect((await run(["render-document", "--document", envelope, "--out", reopenedPath])).code).toBe(0);
    const reopenedSvg = await readFile(reopenedPath, "utf8");
    expect(reopenedSvg).toContain('fill="#ffcc66"');
    expect(reopenedSvg).toContain('data-object-id="ring-letter"');
    expect(reopenedSvg).toContain(">A<");
    expect(reopenedSvg).toContain('data-molecule-effect="sketch"');
    expect(reopenedSvg).toContain('data-graphic-effect="sketch"');
    const pdf = join(directory, "styled.pdf");
    expect((await run(["render-document", "--document", input, "--out", pdf])).code).toBe(0);
    expect((await readFile(pdf)).subarray(0, 4).toString()).toBe("%PDF");
    // Exercise the real Node/tsx dependency loader: Vite's test transform hides CJS/ESM interop.
    const processOut = join(directory, "styled-process.svg");
    const processResult = spawnSync(process.execPath, ["--import", "tsx",
      fileURLToPath(new URL("../cli.ts", import.meta.url)), "render-document",
      "--document", input, "--out", processOut, "--format", "both"
    ], { encoding: "utf8" });
    expect(processResult.status, processResult.stderr + processResult.stdout).toBe(0);
    expect(JSON.parse(processResult.stdout.trim())).toMatchObject({ ok: true, molecules: [
      expect.objectContaining({ canonicalSmiles: built.sourceCanonicalSmiles })
    ] });
    expect(await readFile(processOut, "utf8")).toContain('data-molecule-effect="sketch"');
  }, 60_000);

  it("computes identifiers from edited atoms rather than the stale stored structure", async () => {
    const built = structuredClone(await buildSmilesDocument("CCO"));
    (built.document.pages[0]!.objects[0] as MoleculeObject).atoms[2]!.element = "N";
    const input = join(directory, "changed.json");
    await writeFile(input, JSON.stringify(built.document));
    const result = await run(["render-document", "--document", input, "--out", join(directory, "changed.svg")]);
    expect(result.code).toBe(0);
    expect(result.result.molecules[0].canonicalSmiles).toBe("CCN");
  });

  it("reads a Me display label as its atoms and an unrecognized label as one warned placeholder", async () => {
    const built = structuredClone(await buildSmilesDocument("CC"));
    (built.document.pages[0]!.objects[0] as MoleculeObject).atoms[0]!.element = "Me";
    const input = join(directory, "me-label.json");
    await writeFile(input, JSON.stringify(built.document));
    const result = await run(["render-document", "--document", input, "--out", join(directory, "me-label.svg")]);
    expect(result.code).toBe(0);
    // The label replaces the drawn atom, so C–Me is ethane, written out with no placeholder and no loss.
    expect(result.result.molecules[0].canonicalSmiles).toBe("CC");
    expect(result.result.exportWarnings.filter((warning: { code: string }) => warning.code === "export.molfile_loss")).toHaveLength(0);

    // Case matters: "ME" is no abbreviation, so it stays a dummy atom with exactly one loss warning.
    (built.document.pages[0]!.objects[0] as MoleculeObject).atoms[0]!.element = "ME";
    const unknownInput = join(directory, "me-upper-label.json");
    await writeFile(unknownInput, JSON.stringify(built.document));
    const unknown = await run(["render-document", "--document", unknownInput, "--out", join(directory, "me-upper-label.svg")]);
    expect(unknown.code).toBe(0);
    expect(unknown.result.molecules[0].canonicalSmiles).toContain("*");
    expect(unknown.result.exportWarnings.filter((warning: { code: string }) => warning.code === "export.molfile_loss")).toHaveLength(1);
  });

  it("warns that SVG uses only the first page but preserves all pages in ChemDraft", async () => {
    const built = structuredClone(await buildSmilesDocument("CCO"));
    const firstPage = built.document.pages[0]!;
    built.document.pages.push({ ...structuredClone(firstPage), id: "page-2" });
    const input = join(directory, "two-pages.json");
    await writeFile(input, JSON.stringify(built.document));
    const svg = await run(["render-document", "--document", input, "--out", join(directory, "two-pages.svg")]);
    expect(svg.code).toBe(0);
    expect(svg.result.exportWarnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "export.first_page_only" })
    ]));
    const native = await run(["render-document", "--document", input, "--out", join(directory, "two-pages.chemdraft")]);
    expect(native.code).toBe(0);
    expect(native.result.exportWarnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "export.first_page_only" })
    ]));
  });

  it.each(["CC=CC", "C/C=C/C", "c1ccccc1", "[Na+].[O-]C(=O)C", "N->[Pt+2](<-N)(Cl)Cl"])(
    "preserves source chemistry and stereo counts for an unmodified %s document", async (smiles) => {
      const built = await buildSmilesDocument(smiles);
      const input = join(directory, "identity.json");
      await writeFile(input, JSON.stringify(built.document));
      const result = await run(["render-document", "--document", input, "--out", join(directory, "identity.svg")]);
      expect(result.code, JSON.stringify(result)).toBe(0);
      expect(result.result.molecules[0]).toMatchObject({ canonicalSmiles: built.sourceCanonicalSmiles,
        stereoCenters: built.stereoCenters, unspecifiedStereoCenters: built.unspecifiedStereoCenters,
        unspecifiedDoubleBonds: built.unspecifiedDoubleBonds });
    }
  );

  it("fails a document with an unknown bond order instead of claiming a chemical identity", async () => {
    const built = structuredClone(await buildSmilesDocument("CCO"));
    (built.document.pages[0]!.objects[0] as MoleculeObject).bonds[0]!.order = "unknown";
    const input = join(directory, "unknown-bond.json");
    await writeFile(input, JSON.stringify(built.document));
    const result = await run(["render-document", "--document", input, "--out", join(directory, "unknown-bond.svg")]);
    expect(result.code).toBe(1);
    expect(result.result.ok).toBe(false);
  });

  it("rejects malformed/schema-invalid/oversized documents, limits, and unsafe outputs with exit 2", async () => {
    const built = await buildSmilesDocument("CCO");
    const input = join(directory, "invalid.json");
    const check = async (contents: string | ChemDraftDocument) => {
      await writeFile(input, typeof contents === "string" ? contents : JSON.stringify(contents));
      const result = await run(["render-document", "--document", input, "--out", join(directory, "invalid.svg")]);
      expect(result.code, JSON.stringify(result)).toBe(2);
      expect(result.stdout).toHaveLength(0);
    };
    await check("{oops");
    await check({ ...built.document, unexpected: true } as ChemDraftDocument);
    await check(" ".repeat(MAX_DOCUMENT_BYTES + 1));
    const crowded = structuredClone(built.document);
    crowded.pages[0]!.objects = Array.from({ length: 2001 }, (_, i) => ({ ...built.molecule, id: `mol-${i}` }));
    await check(crowded);
    const heavy = structuredClone(built.document);
    (heavy.pages[0]!.objects[0] as MoleculeObject).atoms = Array.from({ length: 501 }, (_, i) => ({ ...built.molecule.atoms[0]!, id: `a${i}` }));
    await check(heavy);
    await writeFile(input, JSON.stringify(built.document));
    const bothPdf = await run(["render-document", "--document", input, "--out", join(directory, "conflict.pdf"), "--format", "both"]);
    expect(bothPdf.code).toBe(2);
    expect(bothPdf.stderr.join("\n")).toContain("--format both conflicts with the --out extension .pdf.");
    const bothChemDraft = await run(["render-document", "--document", input, "--out", join(directory, "conflict.chemdraft"), "--format", "both"]);
    expect(bothChemDraft.code).toBe(2);
    expect(bothChemDraft.stderr.join("\n")).toContain("--format both conflicts with the --out extension .chemdraft.");
    expect((await run(["render-document", "--document", input, "--out", `${directory}${sep}..${sep}unsafe.svg`])).code).toBe(2);
    expect((await run(["document", "--smiles", "CCO", "--out", join(directory, ".hidden.json")])).code).toBe(2);
    const failed = await run(["document", "--smiles", "invalid", "--out", join(directory, "bad-smiles.json")]);
    expect(failed.code).toBe(1);
    expect(failed.result.ok).toBe(false);
  });
});
