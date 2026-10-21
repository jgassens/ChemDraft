import { createViewportState } from "@chemdraft/viewport-engine";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_SESSION_VERSION,
  buildDocumentSessionEnvelope,
  buildDocumentTabsSession,
  documentIsBlank,
  documentSessionRestoreCandidates,
  parseDocumentSessionEnvelope,
  restoredDocumentFileState,
  restoredSavePathNotice,
  unrestoredTabContents,
  unrestoredTabDisplayName,
  unrestoredTabsNotice,
  shouldRestoreDocumentSession,
  strictSessionFlushRefusal
} from "./documentSession";

const payload = {
  contents: "<cdxml>doc</cdxml>",
  payloadHash: "hash-doc",
  filename: "Untitled.chemdraft"
};

describe("documentIsBlank", () => {
  it("describes kept drawings without referring to retired menu items", () => {
    expect(unrestoredTabsNotice(0)).toBe("");
    expect(unrestoredTabsNotice(1)).toBe("; 1 drawing is kept for later");
    expect(unrestoredTabsNotice(3)).toBe("; 3 drawings are kept for later");
  });

  it("is true only when every page has zero objects", () => {
    expect(documentIsBlank({ pages: [{ objects: [] }] })).toBe(true);
    expect(documentIsBlank({ pages: [{ objects: [] }, { objects: [] }] })).toBe(true);
    expect(documentIsBlank({ pages: [{ objects: [] }, { objects: [{}] }] })).toBe(false);
  });
});

describe("buildDocumentSessionEnvelope", () => {
  it("captures contents, file association, blankness, dirtiness, and timestamp", () => {
    const envelope = buildDocumentSessionEnvelope(
      payload,
      { path: "/tmp/aspirin.chemdraft", dirty: true },
      "aspirin.chemdraft",
      false,
      new Date("2026-07-12T10:00:00Z")
    );
    expect(envelope).toEqual({
      version: DOCUMENT_SESSION_VERSION,
      contents: "<cdxml>doc</cdxml>",
      payloadHash: "hash-doc",
      blank: false,
      path: "/tmp/aspirin.chemdraft",
      displayName: "aspirin.chemdraft",
      dirty: true,
      savedAt: "2026-07-12T10:00:00.000Z"
    });
  });

  it("omits the path key entirely for never-saved documents", () => {
    const envelope = buildDocumentSessionEnvelope(payload, { dirty: false }, "Untitled.chemdraft", true);
    expect("path" in envelope).toBe(false);
  });
});

describe("parseDocumentSessionEnvelope", () => {
  const valid = buildDocumentSessionEnvelope(
    payload,
    { path: "/tmp/a.chemdraft", dirty: false },
    "a.chemdraft",
    false,
    new Date("2026-07-12T10:00:00Z")
  );

  it("round-trips a built envelope through JSON", () => {
    expect(parseDocumentSessionEnvelope(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
  });

  it("rejects non-objects, wrong versions, and missing or mistyped fields", () => {
    expect(parseDocumentSessionEnvelope(undefined)).toBeUndefined();
    expect(parseDocumentSessionEnvelope("nope")).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...valid, version: 2 })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...valid, contents: "" })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...valid, contents: 7 })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...valid, dirty: "yes" })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...valid, path: 4 })).toBeUndefined();
    const { blank: _blank, ...missingBlank } = valid;
    expect(parseDocumentSessionEnvelope(missingBlank)).toBeUndefined();
    const { savedAt: _savedAt, ...missingSavedAt } = valid;
    expect(parseDocumentSessionEnvelope(missingSavedAt)).toBeUndefined();
  });

  it("drops unknown extra fields rather than carrying them forward", () => {
    const parsed = parseDocumentSessionEnvelope({ ...valid, futureField: true });
    expect(parsed).toEqual(valid);
  });
});

describe("shouldRestoreDocumentSession", () => {
  const base = buildDocumentSessionEnvelope(payload, { dirty: false }, "Untitled.chemdraft", false);

  it("skips a pristine blank session (no file, no edits, empty canvas)", () => {
    expect(shouldRestoreDocumentSession({ ...base, blank: true })).toBe(false);
  });

  it("restores a blank canvas that is an open saved file", () => {
    expect(shouldRestoreDocumentSession({ ...base, blank: true, path: "/tmp/empty.chemdraft" })).toBe(true);
  });

  it("restores a blank canvas that carries unsaved edits (user erased everything)", () => {
    expect(shouldRestoreDocumentSession({ ...base, blank: true, dirty: true })).toBe(true);
  });

  it("restores any non-blank document", () => {
    expect(shouldRestoreDocumentSession(base)).toBe(true);
  });
});

describe.each(["/Users/chemist/drawing.chemdraft", "D:\\drawings\\drawing.chemdraft", "/Users/chemist/drawing.cdxml"])("restored file access: %s", (path) => {
  const session = buildDocumentSessionEnvelope(payload, { path, dirty: true }, "drawing.chemdraft", false);

  it("preserves a named tab's path for Save without requiring Save As", () => {
    const restored = restoredDocumentFileState(parseDocumentSessionEnvelope(session, true)!);
    expect(restored).toEqual({ path, dirty: true });
    expect(restoredSavePathNotice(restored)).toBeUndefined();
  });

  it("preserves content and file association when native access fails, explaining Save As", () => {
    const parsed = parseDocumentSessionEnvelope({ ...session, restoreSavePathError: "the saved file is unavailable" }, true)!;
    expect(parsed.contents).toBe(payload.contents);
    const restored = restoredDocumentFileState(parsed);
    expect(restored).toMatchObject({ path, dirty: true, restoreSavePathError: "the saved file is unavailable" });
    expect(restoredSavePathNotice(restored)).toContain("Choose a location with Save As");
    expect(restoredSavePathNotice(restored)).toContain(path);
    // Persist original association, but access must be checked afresh by Rust on the next launch.
    expect(buildDocumentSessionEnvelope(payload, restored, session.displayName, false)).not.toHaveProperty("restoreSavePathError");
  });
});

describe("multi-document session extension", () => {
  const blank = buildDocumentSessionEnvelope(payload, { dirty: false }, "Untitled", true);
  const session = buildDocumentTabsSession([blank, { ...blank, dirty: true }, blank], 1);

  it("offers carried tabs for retry as raw envelopes and retains malformed metadata", () => {
    const raw = { ...blank, view: { future: true }, futureField: { rescue: true } };
    const failed = { displayName: "Old tab", contents: "unknown format", version: 99 };
    const parsed = parseDocumentSessionEnvelope({ ...session, tabs: [raw], activeTabIndex: 0, unrestoredTabs: [failed] })!;
    expect(documentSessionRestoreCandidates(parsed)).toEqual([raw, failed]);
    expect(documentSessionRestoreCandidates(parsed)[0]).toBe(raw);
    expect(documentSessionRestoreCandidates(parseDocumentSessionEnvelope({ ...blank, unrestoredTabs: [failed] })!)).toEqual([
      { ...blank, unrestoredTabs: [failed] }, failed
    ]);
  });

  it("rescues saved text without requiring a readable envelope, and never substitutes missing data", () => {
    const raw = { displayName: "Old format.cdxml", contents: "exact original text", version: 99 };
    expect(unrestoredTabContents(raw)).toBe("exact original text");
    expect(unrestoredTabDisplayName(raw, 0)).toBe("Old format.cdxml");
    expect(unrestoredTabDisplayName(null, 2)).toBe("Kept drawing 3");
    expect(unrestoredTabDisplayName({ displayName: " " }, 0)).toBe("Kept drawing 1");
    expect(() => unrestoredTabContents({ contents: 4 })).toThrow("remains in the session");
  });

  it("retains blank tabs and the active index while preserving the version-1 active envelope", () => {
    expect(parseDocumentSessionEnvelope(JSON.parse(JSON.stringify(session)))).toEqual(session);
    expect(session.contents).toBe(session.tabs![1]!.contents);
    expect(shouldRestoreDocumentSession(buildDocumentTabsSession([blank, blank], 0))).toBe(true);
  });

  it("defaults malformed cosmetic metadata and clamps scale and negative scroll without losing tabs", () => {
    const viewport = createViewportState();
    const parsed = parseDocumentSessionEnvelope(buildDocumentTabsSession([
      { ...blank, view: { viewport: { ...viewport, scale: viewport.maxZoom + 0.001 }, scrollLeft: -2, scrollTop: -3 } },
      { ...blank, view: { viewport: { ...viewport, scale: viewport.minZoom - 0.001 }, scrollLeft: 0, scrollTop: 0 } },
      { ...blank, view: {} as never, openWarnings: { warnings: 7 } as never }
    ], 0))!;
    expect(parsed.tabs).toHaveLength(3);
    expect(parsed.tabs![0]!.view).toEqual({ viewport: { ...viewport, scale: viewport.maxZoom }, scrollLeft: 0, scrollTop: 0 });
    expect(parsed.tabs![1]!.view!.viewport.scale).toBe(viewport.minZoom);
    expect(parsed.tabs![2]!.view).toBeUndefined();
    expect(parsed.tabs![2]!.openWarnings).toBeUndefined();
  });

  it("does not restore a sole pristine blank Untitled tab", () => {
    expect(shouldRestoreDocumentSession(buildDocumentTabsSession([{ ...blank, pristine: true }], 0))).toBe(false);
    expect(shouldRestoreDocumentSession(buildDocumentTabsSession([{ ...blank, pristine: false }], 0))).toBe(true);
  });

  it("rejects invalid session structure, but retains invalid tabs while restoring readable siblings", () => {
    expect(parseDocumentSessionEnvelope({ ...session, activeTabIndex: 3 })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...session, activeTabIndex: -1 })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...session, activeTabIndex: 0.5 })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...session, tabs: [] })).toBeUndefined();
    const corrupt = { ...blank, contents: "", futureField: { recoverMe: true } };
    const recovered = parseDocumentSessionEnvelope({ ...session, activeTabIndex: 1, tabs: [blank, corrupt, { ...blank, dirty: true }] })!;
    expect(recovered.tabs).toEqual([blank, { ...blank, dirty: true }]);
    expect(recovered.unrestoredTabs).toEqual([corrupt]);
    expect(parseDocumentSessionEnvelope(JSON.parse(JSON.stringify(recovered)))!.unrestoredTabs).toEqual([corrupt]);
    expect(parseDocumentSessionEnvelope({ ...session, activeTabIndex: 0, tabs: [corrupt] })!.unrestoredTabs).toEqual([corrupt]);
    expect(parseDocumentSessionEnvelope({ ...session, activeTabIndex: 0, tabs: [session] })!.unrestoredTabs).toEqual([session]);
  });

  describe.each(["macos", "windows"] as const)("unreadable child envelopes on %s", (platform) => {
    const path = platform === "macos" ? "/tmp/drawing.chemdraft" : "C:\\drawings\\drawing.chemdraft";
    const originalContents = "{\r\n  \"drawing\": \"α 🧪\"\r\n}\t\n";
    const unsupported = { ...blank, version: 99, path, contents: originalContents, future: { data: [1, 2] } };
    const malformed = { ...unsupported, version: 1, dirty: "unknown" };
    const previouslyKept = { ...unsupported, displayName: "Previously kept" };

    it.each(["unsupported versions", "bad shapes"])("keeps every child with %s when none is readable", (kind) => {
      const children = kind === "unsupported versions" ? [unsupported, { ...unsupported }] : [malformed, null];
      const parsed = parseDocumentSessionEnvelope({ ...session, tabs: children, activeTabIndex: 1 })!;
      expect(parsed).toEqual({ version: 1, tabs: [], activeTabIndex: 0, unrestoredTabs: children });
      expect(shouldRestoreDocumentSession(parsed)).toBe(true);
      const candidates = documentSessionRestoreCandidates(parsed);
      expect(candidates).toEqual(children);
      expect(candidates[0]).toBe(children[0]);
      expect(unrestoredTabContents(candidates[0])).toBe(originalContents);
      const autosaved = { ...buildDocumentTabsSession([blank], 0), unrestoredTabs: candidates };
      expect(parseDocumentSessionEnvelope(JSON.parse(JSON.stringify(autosaved)))!.unrestoredTabs).toEqual(children);
    });

    it.each([false, true])("includes previously kept tabs with unreadable children (readable sibling: %s)", (readableSibling) => {
      const rawTabs = readableSibling ? [unsupported, blank, malformed] : [unsupported, malformed];
      const parsed = parseDocumentSessionEnvelope({ ...session, tabs: rawTabs, activeTabIndex: 1,
        unrestoredTabs: [previouslyKept] })!;
      expect(parsed.tabs).toEqual(readableSibling ? [blank] : []);
      expect(parsed.unrestoredTabs).toEqual([previouslyKept, unsupported, malformed]);
      const candidates = documentSessionRestoreCandidates(parsed);
      expect(candidates).toEqual([...(readableSibling ? [blank] : []), previouslyKept, unsupported, malformed]);
      expect(candidates.at(-1)).toBe(malformed);
    });

    it("does not depend on a readable active-document mirror in a structurally valid outer session", () => {
      const parsed = parseDocumentSessionEnvelope({ version: 1, tabs: [unsupported], activeTabIndex: 0 })!;
      expect(documentSessionRestoreCandidates(parsed)).toEqual([unsupported]);
    });

    it("still rejects an unreadable outer session even when it carries recoverable children", () => {
      expect(parseDocumentSessionEnvelope({ ...session, version: 99, tabs: [unsupported], activeTabIndex: 0,
        unrestoredTabs: [previouslyKept] })).toBeUndefined();
      expect(parseDocumentSessionEnvelope("{bad JSON")).toBeUndefined();
    });
  });
});

describe("strict session flush (before the updater's installer ends the process)", () => {
  const open = { hydrated: true, saveEnabled: true, blank: false, fileState: { dirty: true } };

  it("proceeds when saving is open", () => {
    expect(strictSessionFlushRefusal(open)).toBeUndefined();
  });

  it("refuses when autosave is off and the drawing has unsaved work", () => {
    expect(strictSessionFlushRefusal({ ...open, saveEnabled: false })).toMatch(/autosave is off/);
    expect(strictSessionFlushRefusal({ ...open, saveEnabled: false, fileState: { path: "C:/a.cdxml", dirty: true } }))
      .toMatch(/File ▸ Save/);
  });

  it("refuses while the last session is still loading", () => {
    expect(strictSessionFlushRefusal({ ...open, hydrated: false, saveEnabled: false })).toMatch(/still loading/);
  });

  it("proceeds when skipping the write loses nothing: a blank canvas, or a saved file with no edits", () => {
    expect(strictSessionFlushRefusal({ ...open, saveEnabled: false, blank: true, fileState: { dirty: false } })).toBeUndefined();
    expect(strictSessionFlushRefusal({ ...open, saveEnabled: false, fileState: { path: "C:/a.cdxml", dirty: false } }))
      .toBeUndefined();
  });
});
