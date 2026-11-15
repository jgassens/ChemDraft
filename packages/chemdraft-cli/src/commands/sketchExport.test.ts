import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createEmptyDocument } from "@chemdraft/chem-core";
import { runRenderDocumentCommand } from "./renderDocument";

it("prepares the bundled font when CLI/MCP render-document receives a saved Sketch document", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sketch-export-"));
  try {
    const document = createEmptyDocument();
    document.pages[0]!.objects = [{ id: "text", type: "text", x: 100, y: 100, width: 100, height: 30,
      rotation: 0, text: "OH ⇌", spans: [], style: { fontFamily: "'Patrick Hand', Arial, Helvetica, sans-serif" } }];
    const input = join(directory, "sketch.chemdraft"), output = join(directory, "sketch.svg");
    await writeFile(input, JSON.stringify(document));
    const messages: string[] = [];
    const result = await runRenderDocumentCommand(["--document", input, "--out", output], {
      stdout: line => messages.push(line), stderr: line => messages.push(line)
    });
    expect(result, messages.join("\n")).toBe(0);
    const svg = await readFile(output, "utf8");
    expect(svg).toContain("@font-face");
    expect(svg).toContain("OH ⇌");
    expect(svg).toContain("&apos;Patrick Hand&apos;, Arial, Helvetica, sans-serif");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
