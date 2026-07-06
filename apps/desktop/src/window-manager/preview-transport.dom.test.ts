// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  listenForPaletteCommandCancels,
  listenForPaletteCommandCommits,
  listenForPaletteCommandPreviews,
  sendPaletteCommandCancel,
  sendPaletteCommandCommit,
  sendPaletteCommandPreview
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
});
