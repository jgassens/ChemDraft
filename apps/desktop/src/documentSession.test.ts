import { createViewportState } from "@chemdraft/viewport-engine";
import { describe, expect, it } from "vitest";
import {
  DOCUMENT_SESSION_VERSION,
  buildDocumentSessionEnvelope,
  buildDocumentTabsSession,
  documentIsBlank,
  documentSessionRestoreCandidates,
  parseDocumentSessionEnvelope,
  unrestoredTabContents,
  unrestoredTabDisplayName,
  shouldRestoreDocumentSession,
  strictSessionFlushRefusal
} from "./documentSession";

const payload = {
  contents: "<cdxml>doc</cdxml>",
  payloadHash: "hash-doc",
  filename: "Untitled.chemdraft"
};

describe("documentIsBlank", () => {
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
    expect(unrestoredTabDisplayName(null, 2)).toBe("Unrestored tab 3");
    expect(unrestoredTabDisplayName({ displayName: " " }, 0)).toBe("Unrestored tab 1");
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
    expect(parseDocumentSessionEnvelope({ ...session, tabs: [corrupt] })).toBeUndefined();
    expect(parseDocumentSessionEnvelope({ ...session, activeTabIndex: 0, tabs: [session] })).toBeUndefined();
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
    expect(strictSessionFlushRefusal({ ...open, saveEnabled: false, blank: true })).toBeUndefined();
    expect(strictSessionFlushRefusal({ ...open, saveEnabled: false, fileState: { path: "C:/a.cdxml", dirty: false } }))
      .toBeUndefined();
  });
});
