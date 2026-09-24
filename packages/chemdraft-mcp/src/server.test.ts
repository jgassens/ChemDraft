import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";

import {
  createChemDraftMcpServer,
  type ChemDraftMcpDependencies,
  type CliCommand
} from "./server";

const connections: Array<{ client: Client; server: ReturnType<typeof createChemDraftMcpServer> }> = [];

const temporaryDirectories: string[] = [];

async function connect(dependencies: ChemDraftMcpDependencies = {}) {
  const server = createChemDraftMcpServer(dependencies);
  const client = new Client({ name: "chemdraft-mcp-test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  connections.push({ client, server });
  return client;
}

function imageBytes(content: unknown): Buffer {
  if (!Array.isArray(content)) throw new Error("Expected MCP content blocks.");
  const image = content.find((block): block is { type: "image"; data: string } =>
    typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "image" &&
    typeof (block as { data?: unknown }).data === "string"
  );
  if (!image) throw new Error("Expected an MCP image block.");
  return Buffer.from(image.data, "base64");
}

function textBlocks(content: unknown): string[] {
  if (!Array.isArray(content)) throw new Error("Expected MCP content blocks.");
  return content.flatMap((block) =>
    typeof block === "object" && block !== null &&
    (block as { type?: unknown }).type === "text" &&
    typeof (block as { text?: unknown }).text === "string"
      ? [(block as { text: string }).text]
      : []
  );
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
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
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
        products: expect.any(Object),
        format: expect.any(Object),
        background: expect.any(Object)
      }
    });
    expect(result.tools.find((tool) => tool.name === "render_structure")!.inputSchema).toMatchObject({
      properties: {
        padding: expect.any(Object),
        bondLength: expect.any(Object)
      }
    });
    expect(result.tools.find((tool) => tool.name === "render_grid")!.inputSchema).toMatchObject({
      properties: {
        format: expect.any(Object),
        padding: expect.any(Object),
        gutter: expect.any(Object),
        background: expect.any(Object)
      }
    });
    expect(result.tools.find((tool) => tool.name === "predict_nmr")!.inputSchema).toMatchObject({
      properties: {
        statistic: expect.any(Object),
        ignoreLabileHydrogens: expect.any(Object)
      }
    });
    expect(result.tools.find((tool) => tool.name === "name_to_structure")!.inputSchema).toMatchObject({
      properties: { allowAmbiguous: expect.any(Object) }
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

  it("forwards the newly exposed options using the CLI's exact flag names", async () => {
    const calls: Partial<Record<"render" | "grid" | "reaction" | "nmr" | "name", string[]>> = {};
    const capture = (name: keyof typeof calls): CliCommand => async (argv, io) => {
      calls[name] = [...argv];
      io.stdout(JSON.stringify({ name, ok: true }));
      return 0;
    };
    const client = await connect({
      commands: {
        render: capture("render"),
        grid: capture("grid"),
        reaction: capture("reaction"),
        nmr: capture("nmr"),
        name: capture("name")
      }
    });

    await client.callTool({
      name: "render_structure",
      arguments: { smiles: "CCO", padding: 9, bondLength: 31 }
    });
    await client.callTool({
      name: "render_grid",
      arguments: {
        items: [{ name: "ethanol", smiles: "CCO" }],
        format: "svg",
        padding: 7,
        gutter: 11,
        background: "transparent"
      }
    });
    await client.callTool({
      name: "render_reaction",
      arguments: {
        reactants: ["CCO"],
        agents: [],
        products: ["CC=O"],
        format: "svg",
        background: "transparent"
      }
    });
    await client.callTool({
      name: "predict_nmr",
      arguments: { smiles: "CCO", statistic: "mean", ignoreLabileHydrogens: true }
    });
    await client.callTool({
      name: "name_to_structure",
      arguments: { name: "aspirin", allowAmbiguous: true }
    });

    expect(calls.render).toEqual(expect.arrayContaining(["--padding", "9", "--bond-length", "31"]));
    expect(calls.grid).toEqual(expect.arrayContaining([
      "--padding", "7", "--gutter", "11", "--background", "transparent"
    ]));
    expect(calls.grid?.find((value) => value.endsWith(".svg"))).toBeDefined();
    expect(calls.reaction).toEqual(expect.arrayContaining(["--background", "transparent"]));
    expect(calls.reaction?.find((value) => value.endsWith(".svg"))).toBeDefined();
    expect(calls.nmr).toEqual(expect.arrayContaining(["--statistic", "mean", "--ignore-labile"]));
    expect(calls.name).toContain("--allow-ambiguous");
  });

  it("isolates concurrent enantiomer renders in separate per-call directories", async () => {
    const client = await connect();
    const left = "C[C@H](N)C(=O)O";
    const right = "C[C@@H](N)C(=O)O";
    const [leftResult, rightResult] = await Promise.all([
      client.callTool({ name: "render_structure", arguments: { smiles: left } }),
      client.callTool({ name: "render_structure", arguments: { smiles: right } })
    ]);
    const leftReference = await client.callTool({
      name: "render_structure",
      arguments: { smiles: left }
    });
    const rightReference = await client.callTool({
      name: "render_structure",
      arguments: { smiles: right }
    });

    expect(leftResult.isError).not.toBe(true);
    expect(rightResult.isError).not.toBe(true);
    expect(imageBytes(leftResult.content)).toEqual(imageBytes(leftReference.content));
    expect(imageBytes(rightResult.content)).toEqual(imageBytes(rightReference.content));
    expect(imageBytes(leftResult.content)).not.toEqual(imageBytes(rightResult.content));

    const leftPath = (jsonPayload(leftResult.content).files as string[])[0]!;
    const rightPath = (jsonPayload(rightResult.content).files as string[])[0]!;
    expect(dirname(leftPath)).not.toBe(dirname(rightPath));
  }, 60_000);

  it("serializes two concurrent tool calls and lets both succeed", async () => {
    let active = 0;
    let maximumActive = 0;
    const stereo: CliCommand = async (argv, io) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      io.stdout(JSON.stringify({ ok: true, smiles: argv[1] }));
      active -= 1;
      return 0;
    };
    const client = await connect({ commands: { stereo } });
    const [alanine, ethanol] = await Promise.all([
      client.callTool({ name: "check_stereo", arguments: { smiles: "C[C@H](N)C(=O)O" } }),
      client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } })
    ]);
    expect(alanine.isError).not.toBe(true);
    expect(ethanol.isError).not.toBe(true);
    expect(maximumActive).toBe(1);
  });

  it("retries default temp-root creation after an injected mkdtemp failure", async () => {
    let attempts = 0;
    const flakyMkdtemp = (async (prefix: string) => {
      attempts += 1;
      if (attempts === 1) throw new Error("injected mkdtemp failure");
      return mkdtemp(prefix);
    }) as typeof mkdtemp;
    const client = await connect({ mkdtemp: flakyMkdtemp });

    const first = await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });
    const second = await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });
    expect(first.isError).toBe(true);
    expect(textBlocks(first.content).join("\n")).toContain("injected mkdtemp failure");
    expect(second.isError).not.toBe(true);
    expect(attempts).toBe(3); // failed root, successful root, then the successful call directory
  }, 60_000);

  it("removes per-call directories older than 24 hours at startup and at most once a minute", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chemdraft-mcp-retention-test-"));
    temporaryDirectories.push(sandbox);
    const serverRoot = join(sandbox, "chemdraft-mcp", "server-root");
    const oldCall = join(serverRoot, "call-old");
    const recentCall = join(serverRoot, "call-recent");
    await mkdir(oldCall, { recursive: true });
    await mkdir(recentCall, { recursive: true });
    let now = Date.now();
    await utimes(oldCall, new Date(now - 25 * 60 * 60 * 1000), new Date(now - 25 * 60 * 60 * 1000));
    await utimes(recentCall, new Date(now - 23 * 60 * 60 * 1000), new Date(now - 23 * 60 * 60 * 1000));
    const injectedMkdtemp = (async (prefix: string) =>
      prefix.endsWith("server-") ? serverRoot : mkdtemp(prefix)) as typeof mkdtemp;
    const client = await connect({
      mkdtemp: injectedMkdtemp,
      now: () => now,
      tempDirectory: () => sandbox
    });

    const first = await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });
    expect(first.isError).not.toBe(true);
    await expect(access(oldCall)).rejects.toThrow();
    await expect(access(recentCall)).resolves.toBeUndefined();

    const newlyOldCall = join(serverRoot, "call-newly-old");
    await mkdir(newlyOldCall);
    await utimes(
      newlyOldCall,
      new Date(now - 25 * 60 * 60 * 1000),
      new Date(now - 25 * 60 * 60 * 1000)
    );
    await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });
    await expect(access(newlyOldCall)).resolves.toBeUndefined();
    now += 60_001;
    await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });
    await expect(access(newlyOldCall)).rejects.toThrow();
  }, 60_000);

  it("keeps tool calls successful when cleanup entries disappear", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chemdraft-mcp-cleanup-race-test-"));
    temporaryDirectories.push(sandbox);
    const parent = join(sandbox, "chemdraft-mcp");
    const readdirRaceRoot = join(parent, "server-readdir-race");
    const statRaceRoot = join(parent, "server-stat-race");
    await mkdir(readdirRaceRoot, { recursive: true });
    await mkdir(join(statRaceRoot, "call-stat-race"), { recursive: true });
    const missing = Object.assign(new Error("injected cleanup race"), { code: "ENOENT" });
    const injectedReaddir = (async (path, options) => {
      if (path === readdirRaceRoot) throw missing;
      return readdir(path, options as never);
    }) as typeof readdir;
    const injectedStat = (async (path, options) => {
      if (path === join(statRaceRoot, "call-stat-race")) throw missing;
      return stat(path, options);
    }) as typeof stat;
    const stereo: CliCommand = async (_argv, io) => {
      io.stdout(JSON.stringify({ ok: true, smiles: "CCO" }));
      return 0;
    };
    const client = await connect({
      readdir: injectedReaddir,
      stat: injectedStat,
      tempDirectory: () => sandbox,
      commands: { stereo }
    });

    const result = await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });

    expect(result.isError).not.toBe(true);
    expect(jsonPayload(result.content)).toMatchObject({ ok: true, smiles: "CCO" });
  }, 60_000);

  it("removes old empty server roots but never its own root", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "chemdraft-mcp-empty-root-test-"));
    temporaryDirectories.push(sandbox);
    const parent = join(sandbox, "chemdraft-mcp");
    const oldEmptyRoot = join(parent, "server-old-empty");
    const currentRoot = join(parent, "server-current");
    await mkdir(oldEmptyRoot, { recursive: true });
    await mkdir(currentRoot, { recursive: true });
    const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await utimes(oldEmptyRoot, oldTime, oldTime);
    await utimes(currentRoot, oldTime, oldTime);
    const injectedMkdtemp = (async (prefix: string) =>
      prefix.endsWith("server-") ? currentRoot : mkdtemp(prefix)) as typeof mkdtemp;
    const stereo: CliCommand = async (_argv, io) => {
      io.stdout(JSON.stringify({ ok: true, smiles: "CCO" }));
      return 0;
    };
    const client = await connect({
      mkdtemp: injectedMkdtemp,
      tempDirectory: () => sandbox,
      commands: { stereo }
    });

    const result = await client.callTool({ name: "check_stereo", arguments: { smiles: "CCO" } });

    expect(result.isError).not.toBe(true);
    await expect(access(oldEmptyRoot)).rejects.toThrow();
    await expect(access(currentRoot)).resolves.toBeUndefined();
  }, 60_000);

  it("returns rendered SVG markup inline along with its output path", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "render_structure",
      arguments: { smiles: "CC(=O)Oc1ccccc1C(=O)O", format: "svg" }
    });
    expect(result.isError).not.toBe(true);
    expect((jsonPayload(result.content).files as string[])[0]).toMatch(/\.svg$/);
    expect(textBlocks(result.content).some((text) => text.includes("<svg"))).toBe(true);
  }, 60_000);

  it("returns grid and reaction SVG markup inline", async () => {
    const client = await connect();
    const [grid, reaction] = await Promise.all([
      client.callTool({
        name: "render_grid",
        arguments: {
          items: [{ name: "aspirin", smiles: "CC(=O)Oc1ccccc1C(=O)O" }],
          format: "svg",
          padding: 8
        }
      }),
      client.callTool({
        name: "render_reaction",
        arguments: { reactants: ["CCO"], products: ["CC=O"], format: "svg" }
      })
    ]);
    for (const result of [grid, reaction]) {
      expect(result.isError).not.toBe(true);
      expect(textBlocks(result.content).some((text) => text.includes("<svg"))).toBe(true);
    }
  }, 60_000);

  it.each(["cdxml", "mol", "sdf", "smi"] as const)(
    "returns %s export contents inline along with the path",
    async (format) => {
      const client = await connect();
      const result = await client.callTool({
        name: "export_structure",
        arguments: { smiles: "CC(=O)Oc1ccccc1C(=O)O", format }
      });
      expect(result.isError).not.toBe(true);
      expect(jsonPayload(result.content).out).toMatch(new RegExp(`\\.${format}$`));
      expect(textBlocks(result.content).length).toBeGreaterThan(1);
    },
    60_000
  );

  it("returns PDF exports as embedded resources along with the path", async () => {
    const client = await connect();
    const result = await client.callTool({
      name: "export_structure",
      arguments: { smiles: "CCO", format: "pdf" }
    });
    expect(result.isError).not.toBe(true);
    expect(jsonPayload(result.content).out).toMatch(/\.pdf$/);
    expect(result.content).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "resource",
        resource: expect.objectContaining({ mimeType: "application/pdf", blob: expect.any(String) })
      })
    ]));
  }, 60_000);

  it("rejects a returned file payload larger than 5 MB with actionable guidance", async () => {
    const client = await connect({
      readFile: (async () => Buffer.alloc(5 * 1024 * 1024 + 1)) as unknown as typeof readFile
    });
    const result = await client.callTool({
      name: "render_structure",
      arguments: { smiles: "CCO" }
    });
    expect(result.isError).toBe(true);
    expect(textBlocks(result.content).join("\n")).toContain("smaller width");
  }, 60_000);

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
