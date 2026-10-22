import { beforeEach, describe, expect, it, vi } from "vitest";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
import { takeDocumentTabTransfer } from "./index";

const metadata = { transferId: "transfer-1", tabId: "tab-1", chunkCount: 1 };
beforeEach(() => { invoke.mockReset(); });

describe("chunked document transfer receipt", () => {
  it("returns null without requesting chunks when no transfer is waiting", async () => {
    invoke.mockResolvedValue(null);
    expect(await takeDocumentTabTransfer()).toBeNull();
    expect(invoke).toHaveBeenCalledExactlyOnceWith("take_document_tab_transfer");
  });

  it("reassembles the actual wrapper's sequential replies without accepting the transfer", async () => {
    const snapshot = { title: "Drawing \u{1f600}", history: ["old", "present"], text: "x".repeat(5000) };
    const json = JSON.stringify(snapshot);
    const chunks = Array.from({ length: Math.ceil(json.length / 1000) }, (_, index) => json.slice(index * 1000, (index + 1) * 1000));
    let inFlight = false;
    invoke.mockImplementation(async (command: string, args?: { transferId: string; index: number }) => {
      if (command === "take_document_tab_transfer") return { ...metadata, chunkCount: chunks.length };
      expect(command).toBe("document_tab_transfer_chunk");
      expect(inFlight).toBe(false);
      inFlight = true;
      await Promise.resolve();
      inFlight = false;
      expect(args?.transferId).toBe(metadata.transferId);
      return chunks[args!.index];
    });
    expect(await takeDocumentTabTransfer()).toEqual({ transferId: metadata.transferId, tabId: metadata.tabId, snapshot });
    expect(invoke.mock.calls.slice(1).map(([, args]) => args.index)).toEqual(chunks.map((_, index) => index));
  });

  it.each([undefined, {}, [], { ...metadata, chunkCount: 0 }, { ...metadata, chunkCount: -1 },
    { ...metadata, chunkCount: 65537 }, { ...metadata, chunkCount: 1.5 }, { ...metadata, chunkCount: NaN },
    { ...metadata, chunkCount: "1" }, { ...metadata, transferId: "" }, { ...metadata, tabId: 5 }
  ])("rejects invalid metadata before reading chunks: %j", async value => {
    invoke.mockResolvedValue(value);
    await expect(takeDocumentTabTransfer()).rejects.toThrow("Invalid document transfer metadata");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it.each([null, {}, 5, "", "x".repeat(1025), "\u{1f600}".repeat(1025)])("rejects an invalid chunk", async chunk => {
    invoke.mockResolvedValueOnce(metadata).mockResolvedValueOnce(chunk);
    await expect(takeDocumentTabTransfer()).rejects.toThrow("Invalid document transfer chunk");
  });

  it("accepts a full 1024 Unicode character chunk even when it uses surrogate pairs", async () => {
    const text = "\u{1f600}".repeat(1024);
    invoke.mockResolvedValueOnce({ ...metadata, chunkCount: 3 })
      .mockResolvedValueOnce('"').mockResolvedValueOnce(text).mockResolvedValueOnce('"');
    expect((await takeDocumentTabTransfer())?.snapshot).toBe(text);
  });

  it("rejects aggregate UTF-8 data over 64 MB before parsing or accepting it", async () => {
    const chunk = "\u{1f600}".repeat(1024);
    invoke.mockImplementation(async (command: string) => command === "take_document_tab_transfer"
      ? { ...metadata, chunkCount: 65536 } : chunk);
    await expect(takeDocumentTabTransfer()).rejects.toThrow("exceeds the transfer size limit");
    expect(invoke).toHaveBeenCalledTimes(16386); // metadata + 16385 four-KB chunks
  });

  it("rejects incomplete JSON and propagates an authorization/cancellation error", async () => {
    invoke.mockResolvedValueOnce(metadata).mockResolvedValueOnce('{"missing":');
    await expect(takeDocumentTabTransfer()).rejects.toThrow("invalid JSON");
    invoke.mockResolvedValueOnce(metadata).mockRejectedValueOnce(new Error("Transfer was cancelled"));
    await expect(takeDocumentTabTransfer()).rejects.toThrow("Transfer was cancelled");
  });
});
