import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { serializeDocument } from "@chemdraft/chem-core";
import { describe, expect, it } from "vitest";
import { invalidCarbonDocument, invalidCarbonWarning } from "../../document-workflow-core/test/invalidStructureFixtures";
import { createChemDraftMcpServer } from "./server";

describe("MCP invalid native exports", () => {
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
