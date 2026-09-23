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

function jsonPayload(content: unknown): Record<string, unknown> {
  if (!Array.isArray(content)) throw new Error("Expected MCP content blocks.");
  const text = content.find((block): block is { type: "text"; text: string } =>
    typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
  );
  if (!text) throw new Error("Expected an MCP JSON text block.");
  return JSON.parse(text.text) as Record<string, unknown>;
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
    const reaction = result.tools.find((tool) => tool.name === "render_reaction")!;
    expect(reaction.inputSchema).toMatchObject({
      properties: {
        reactionSmiles: expect.any(Object),
        reactants: expect.any(Object),
        agents: expect.any(Object),
        products: expect.any(Object)
      }
    });
    expect(result.tools.find((tool) => tool.name === "analyze_structure")!.description)
      .toContain("not-requested");
    expect(result.tools.find((tool) => tool.name === "check_stereo")!.description)
      .toContain("E/Z");
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

  it("reports E double-bond stereochemistry", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "check_stereo",
      arguments: { smiles: "C/C=C/C" }
    });
    expect(result.isError).not.toBe(true);
    expect(jsonPayload(result.content)).toMatchObject({
      doubleBonds: [{ bondIndex: 1, descriptor: "E" }]
    });
  });

  it("preserves array-supplied salts and reports the agent display text", async () => {
    const client = await connect();
    const salt = "[Na+].[O-]C(=O)C";
    const result = await client.callTool({
      name: "render_reaction",
      arguments: {
        reactants: [salt],
        agents: ["OS(=O)(=O)O"],
        products: ["CC(=O)O"]
      }
    });
    expect(result.isError).not.toBe(true);
    expect(jsonPayload(result.content)).toMatchObject({
      reactants: [salt],
      agentTexts: [{ text: "H2SO4", source: "formula" }]
    });
  }, 120_000);

  it("keeps not-requested analysis fields distinct in MCP output", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "analyze_structure",
      arguments: { smiles: "CCO", methods: ["rdkit.composition"] }
    });
    expect(result.isError).not.toBe(true);
    expect(jsonPayload(result.content)).toMatchObject({
      summary: { logP: { value: null, status: "not-requested" } }
    });
  }, 120_000);

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
