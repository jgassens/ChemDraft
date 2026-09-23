import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import { createChemDraftMcpServer } from "./server";

const connections: Array<{ client: Client; server: ReturnType<typeof createChemDraftMcpServer> }> = [];

async function connect() {
  const server = createChemDraftMcpServer();
  const client = new Client({ name: "chemdraft-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

afterEach(async () => {
  await Promise.all(connections.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
});

describe("ChemDraft MCP server", () => {
  it("lists all eight ChemDraft CLI tools", async () => {
    const client = await connect();
    const result = await client.listTools();
    expect(result.tools.map((tool) => tool.name).sort()).toEqual([
      "analyze_structure",
      "check_stereo",
      "export_structure",
      "name_to_structure",
      "predict_nmr",
      "render_grid",
      "render_reaction",
      "render_structure"
    ]);
  });

  it("renders aspirin with an MCP image block", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "render_structure",
      arguments: { smiles: "CC(=O)Oc1ccccc1C(=O)O" }
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('"type":"image"');
    expect(JSON.stringify(result.content)).toContain('"mimeType":"image/png"');
  });

  it("reports L-alanine as S", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "check_stereo",
      arguments: { smiles: "C[C@H](N)C(=O)O" }
    });
    expect(result.isError).not.toBe(true);
    expect(JSON.stringify(result.content)).toContain('\\"descriptor\\":\\"S\\"');
  });

  it("surfaces bad-SMILES CLI errors as MCP errors", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "render_structure",
      arguments: { smiles: "not a smiles" }
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("not a smiles");
  });
});
