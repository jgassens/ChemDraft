import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { openChemDraftPayload } from "@chemdraft/cdx-compat";
import { moleculeToMolfileV2000, moleculeToMolfileV3000, type MoleculeObject } from "@chemdraft/chem-core";
import { nativeBondOrderResolution } from "@chemdraft/layout-engine";
import { generateSmiles2DMolfile } from "../../rdkit-adapter/src/conformer";
import { installIsotopeTestEngine } from "../../chemdraft-cli/src/isotopes.testUtils";
import { isotopeInsertSmiles, isotopeReactions, expectIsotopeGraph } from
  "../../document-workflow-core/test/isotopeInsertFixtures";
import { buildSmilesDocument, canonicalSmiles, renderSmilesToAssets } from "../../chemdraft-cli/src/document";
import { createChemDraftMcpServer } from "./server";

// Observe the real builder results behind tools that return images rather than native graphs.
vi.mock("../../chemdraft-cli/src/document", async importOriginal => {
  const actual = await importOriginal<typeof import("../../chemdraft-cli/src/document")>();
  return { ...actual, buildSmilesDocument: vi.fn(actual.buildSmilesDocument),
    renderSmilesToAssets: vi.fn(actual.renderSmilesToAssets) };
});
vi.setConfig({ testTimeout: 60_000 });
let directory: string;
let client: Client;
let server: ReturnType<typeof createChemDraftMcpServer>;
beforeAll(async () => {
  installIsotopeTestEngine();
  directory = await mkdtemp(join(tmpdir(), "chemdraft-mcp-isotopes-"));
  server = createChemDraftMcpServer({ tempDirectory: () => directory });
  client = new Client({ name: "isotope-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
});
afterAll(async () => {
  await client?.close();
  await server?.close();
  await rm(directory, { recursive: true, force: true });
});
async function verify(molecule: MoleculeObject, smiles: string) {
  expectIsotopeGraph(molecule, await generateSmiles2DMolfile(smiles));
  for (const write of [moleculeToMolfileV2000, moleculeToMolfileV3000]) {
    const molfile = write(molecule, { fromDocFrame: true,
      kekuleBondOrders: nativeBondOrderResolution(molecule.atoms, molecule.bonds).kekuleOrders }).contents;
    expect(await canonicalSmiles(molfile, "MCP native graph")).toBe(await canonicalSmiles(smiles, "source"));
  }
}
async function call(name: string, args: Record<string, unknown>) {
  vi.mocked(buildSmilesDocument).mockClear();
  vi.mocked(renderSmilesToAssets).mockClear();
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  const builders = [...vi.mocked(buildSmilesDocument).mock.results,
    ...vi.mocked(renderSmilesToAssets).mock.results];
  expect(builders.length).toBeGreaterThan(0);
  for (const built of builders) {
    const value = await built.value;
    await verify(value.molecule, value.smiles);
  }
  return (result.content as { type: string; text?: string }[])
    .filter(block => block.type === "text").map(block => block.text!);
}

describe("MCP isotope preservation", () => {
  it.each(isotopeInsertSmiles)("builds, renders and exports %s", async smiles => {
    const built = await call("build_document", { smiles });
    const document = openChemDraftPayload(built[1]!).document!;
    await verify(document.pages[0]!.objects[0] as MoleculeObject, smiles);
    await call("render_structure", { smiles, format: "svg" });
    for (const format of ["mol", "sdf", "smi", "cdxml"]) {
      const blocks = await call("export_structure", { smiles, format });
      const contents = blocks[1]!;
      if (format === "cdxml") {
        const reopened = openChemDraftPayload(contents).document!;
        await verify(reopened.pages[0]!.objects[0] as MoleculeObject, smiles);
      } else {
        const structure = format === "smi" ? contents.trim().split(/\s/)[0]! : contents.split("> <")[0]!;
        expect(await canonicalSmiles(structure, "MCP export")).toBe(await canonicalSmiles(smiles, "source"));
      }
    }
  });
  it.each(isotopeReactions)("renders the worked reaction: $products", async reaction => {
    const blocks = await call("render_reaction", { ...reaction, format: "svg" });
    expect(JSON.parse(blocks[0]!)).toMatchObject({ ok: true, ...reaction });
    expect(vi.mocked(buildSmilesDocument)).toHaveBeenCalledTimes(3);
  });
});
