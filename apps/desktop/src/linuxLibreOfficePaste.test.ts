import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { guardClipboardPayload, inspectClipboardPayload, type ClipboardReadPayload } from "@chemdraft/clipboard-adapter";
import { tableClipboardPasteDecision } from "./tableClipboardWiring";

// What the Linux reader (`linux_clipboard.rs`) returned for LibreOffice 26.8 copies on X11 once it
// keeps the UTF-8 text under `text/plain` (GitHub #304). Before, a Writer copy had no `text/plain`
// item, and the paste took the RTF source offered as `text/richtext`.
const linuxRead = (name: string): ClipboardReadPayload =>
  JSON.parse(readFileSync(`packages/fixtures/clipboard-linux/libreoffice-26.8/${name}.json`, "utf8"));
const decide = (payload: ClipboardReadPayload) =>
  tableClipboardPasteDecision(guardClipboardPayload(payload), html => new JSDOM(html).window.document, inspectClipboardPayload);

describe("LibreOffice paste on Linux", () => {
  it("pastes Writer text as its text, not the RTF source beside it", () => {
    const read = linuxRead("writer-text");
    expect(read.textItems.find(item => item.type === "text/richtext")?.text).toMatch(/^\{\\rtf1/);
    expect(decide(read)).toMatchObject({ kind: "existing", payload: { kind: "plain-text", text: "Hello benzene" } });
  });

  it("pastes a SMILES typed in Writer as that text", () => {
    expect(decide(linuxRead("writer-smiles"))).toMatchObject({
      kind: "existing", payload: { kind: "plain-text", text: "c1ccc(O)cc1" }
    });
  });

  it("pastes tab-separated Writer text as a table, as the macOS and Windows names do", () => {
    const read = linuxRead("writer-tabs");
    const rows = [["Name", "MW"], ["benzene", "78.11"]];
    expect(decide(read)).toMatchObject({ kind: "table", result: { ok: true, source: "tsv", spec: { rows } } });
    const plain = read.textItems.find(item => item.type === "text/plain")!.text;
    const html = read.textItems.find(item => item.type === "text/html")!.text;
    for (const [plainType, htmlType] of [["public.utf8-plain-text", "public.html"], ["text/plain", "text/html"]]) {
      const textItems = [{ type: htmlType, text: html }, { type: plainType, text: plain }];
      expect(decide({ types: textItems.map(item => item.type), textItems }))
        .toMatchObject({ kind: "table", result: { ok: true, source: "tsv", spec: { rows } } });
    }
  });

  it("refuses Writer prose with one tabbed line as a table, as the macOS and Windows names do", () => {
    const read = linuxRead("writer-ragged");
    const refused = { kind: "table", result: { ok: false, reason: expect.stringContaining("at least two rows") } };
    expect(decide(read)).toMatchObject(refused);
    const plain = read.textItems.find(item => item.type === "text/plain")!.text;
    const html = read.textItems.find(item => item.type === "text/html")!.text;
    for (const [plainType, htmlType] of [["public.utf8-plain-text", "public.html"], ["text/plain", "text/html"]]) {
      const textItems = [{ type: htmlType, text: html }, { type: plainType, text: plain }];
      expect(decide({ types: textItems.map(item => item.type), textItems })).toMatchObject(refused);
    }
  });

  it("keeps Calc cells a table read from their HTML", () => {
    expect(decide(linuxRead("calc"))).toMatchObject({
      kind: "table",
      result: { ok: true, source: "html", spec: { headerRows: [["Compound", "MW"]], rows: [["benzene", "78.11"]] } }
    });
  });
});
