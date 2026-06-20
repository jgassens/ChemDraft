import { describe, expect, it } from "vitest";
import {
  clipboardPayloadFromDataTransfer,
  normalizeClipboardWriteTextItems,
  writeClipboardDataTransfer
} from "./clipboard";

describe("desktop clipboard bridge", () => {
  it("extracts text items from paste event clipboard data", () => {
    const payload = clipboardPayloadFromDataTransfer({
      types: ["text/html", "text/plain", "public.svg-image"],
      getData: (type: string) => {
        if (type === "text/plain") {
          return "pasted text";
        }

        if (type === "public.svg-image") {
          return "<svg />";
        }

        return "";
      }
    } as unknown as DataTransfer);

    expect(payload).toEqual({
      types: ["text/html", "text/plain", "public.svg-image"],
      textItems: [
        { type: "text/plain", text: "pasted text" },
        { type: "public.svg-image", text: "<svg />" }
      ]
    });
  });

  it("normalizes clipboard write items without keeping duplicate or empty types", () => {
    expect(normalizeClipboardWriteTextItems([
      { type: " application/vnd.chemdraft.selection+json ", text: "{}" },
      { type: "text/plain", text: "{}" },
      { type: "text/plain", text: "duplicate" },
      { type: "", text: "missing type" },
      { type: "text/html", text: "" }
    ])).toEqual([
      { type: "application/vnd.chemdraft.selection+json", text: "{}" },
      { type: "text/plain", text: "{}" }
    ]);
  });

  it("writes all ChemDraft clipboard flavors into copy event data", () => {
    const writes: Record<string, string> = {};
    const wrote = writeClipboardDataTransfer({
      setData: (type: string, text: string) => {
        writes[type] = text;
      }
    } as unknown as DataTransfer, [
      { type: "application/vnd.chemdraft.selection+json", text: "selection-json" },
      { type: "text/plain", text: "selection-json" }
    ]);

    expect(wrote).toBe(true);
    expect(writes).toEqual({
      "application/vnd.chemdraft.selection+json": "selection-json",
      "text/plain": "selection-json"
    });
  });

  it("reports failed copy event writes instead of pretending success", () => {
    const wrote = writeClipboardDataTransfer({
      setData: () => {
        throw new Error("clipboard is locked");
      }
    } as unknown as DataTransfer, [
      { type: "text/plain", text: "selection-json" }
    ]);

    expect(wrote).toBe(false);
  });
});
