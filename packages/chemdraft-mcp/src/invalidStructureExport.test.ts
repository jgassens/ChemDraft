import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serializeDocument } from "@chemdraft/chem-core";
import { describe, expect, it, vi } from "vitest";
import { invalidCarbonDocument, invalidCarbonWarning } from "../../document-workflow-core/test/invalidStructureFixtures";
import { unrecognizedLabelDocument, unrecognizedLabelMolfileWarning, unrecognizedLabelSmilesWarning, unrecognizedLabelCdxmlWarning } from "../../document-workflow-core/test/unrecognizedLabelFixtures";
import * as documentWorkflow from "../../chemdraft-cli/src/document";
import { createChemDraftMcpServer } from "./server";

describe("MCP invalid native exports", () => {
  it("retains the shared Phe diagnostic in every export format", async () => {
    const server = createChemDraftMcpServer();
    const client = new Client({ name: "label-export-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { document, molecule } = unrecognizedLabelDocument();
    const built = { ...await documentWorkflow.buildSmilesDocument("CC"), document, molecule,
      identityMolfile: molecule.structure, sourceCanonicalSmiles: "*C", warnings: [] };
    const spy = vi.spyOn(documentWorkflow, "buildSmilesDocument").mockResolvedValue(built);
    const jsonResult = (result: { content: unknown }) => {
      const content = result.content as { type: string; text?: string }[];
      return JSON.parse(content.find(block => block.type === "text")!.text!);
    };
    try {
      for (const format of ["mol", "pdf", "cdxml"]) {
        const result = await client.callTool({ name: "export_structure", arguments: { smiles: "*C", format } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(jsonResult(result).warnings).toEqual([
          ...(format === "cdxml" ? [unrecognizedLabelCdxmlWarning()] : []), unrecognizedLabelMolfileWarning()
        ]);
      }
      for (const format of ["smi", "sdf"]) {
        const result = await client.callTool({ name: "export_structure", arguments: { smiles: "*C", format } });
        expect(result.isError).toBe(true);
        const content = result.content as { type: string; text?: string }[];
        expect(content.find(block => block.type === "text")?.text).toContain(unrecognizedLabelSmilesWarning());
      }
      for (const format of ["pdf", "svg", "png", "chemdraft"]) {
        const result = await client.callTool({ name: "render_document", arguments: {
          documentJson: serializeDocument(document), format
        } });
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(jsonResult(result).warnings).toEqual([
          unrecognizedLabelMolfileWarning(), ...(format === "chemdraft" ? [unrecognizedLabelCdxmlWarning()] : [])
        ]);
      }
    } finally { spy.mockRestore(); await client.close(); await server.close(); }
  }, 60_000);

  it.each([false, true])("returns the shared named warning and file (suppressed=%s)", async suppressed => {
    const server = createChemDraftMcpServer();
    const client = new Client({ name: "invalid-export-test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const result = await client.callTool({ name: "render_document", arguments: {
        documentJson: serializeDocument(invalidCarbonDocument(suppressed)), format: "chemdraft"
      } });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      const content = result.content as { type: string; text?: string }[];
      const json = JSON.parse(content.find(block => block.type === "text")!.text!);
      expect(json).toMatchObject({ ok: true, warnings: [invalidCarbonWarning], molecules: [{
        canonicalSmiles: null, chemistryStatus: "unverified", exportWarnings: [expect.objectContaining({ message: invalidCarbonWarning })]
      }] });
      expect(content.some(block => block.text?.includes("<CDXML"))).toBe(true);
    } finally { await client.close(); await server.close(); }
  });
});
