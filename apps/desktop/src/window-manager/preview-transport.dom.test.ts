// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  broadcastToolsetCustomizeMode,
  listenForPaletteCommandCancels,
  listenForPaletteCommandCommits,
  listenForPaletteCommandPreviews,
  listenForToolsetCustomizeMode,
  listenForToolsetLayoutEdits,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview,
  sendToolsetLayoutEdit
} from "./index";

describe("window-manager palette preview transport", () => {
  it("routes preview, commit, and cancel commands over DOM events outside native runtime", async () => {
    const preview = vi.fn();
    const commit = vi.fn();
    const cancel = vi.fn();
    const unlistenPreview = await listenForPaletteCommandPreviews(preview);
    const unlistenCommit = await listenForPaletteCommandCommits(commit);
    const unlistenCancel = await listenForPaletteCommandCancels(cancel);

    await sendPaletteCommandPreview("molecule.structure.bondLength:96");
    await sendPaletteCommandCommit("molecule.structure.bondLength:96");
    await sendPaletteCommandCancel("palette.preview.cancel");

    expect(preview).toHaveBeenCalledWith("molecule.structure.bondLength:96");
    expect(commit).toHaveBeenCalledWith("molecule.structure.bondLength:96");
    expect(cancel).toHaveBeenCalledWith("palette.preview.cancel");

    unlistenPreview();
    unlistenCommit();
    unlistenCancel();
  });

  it("round-trips a customize layout edit over DOM events (palette → main)", async () => {
    const handler = vi.fn();
    const unlisten = await listenForToolsetLayoutEdits(handler);

    await sendToolsetLayoutEdit({ toolsetId: "core.main", edit: { kind: "addSpacer", groupId: "core.main.selection", index: 0 } });
    await sendToolsetLayoutEdit({ toolsetId: "core.main", edit: { kind: "exitCustomize" } });

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenNthCalledWith(1, {
      toolsetId: "core.main",
      edit: { kind: "addSpacer", groupId: "core.main.selection", index: 0 }
    });
    expect(handler).toHaveBeenNthCalledWith(2, { toolsetId: "core.main", edit: { kind: "exitCustomize" } });

    unlisten();
  });

  it("round-trips a customize-mode broadcast (main → palettes)", async () => {
    const handler = vi.fn();
    const unlisten = await listenForToolsetCustomizeMode(handler);

    await broadcastToolsetCustomizeMode({ toolsetId: "core.main", active: true });

    expect(handler).toHaveBeenCalledWith({ toolsetId: "core.main", active: true });

    unlisten();
  });
});
