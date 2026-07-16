import { describe, expect, it } from "vitest";
import {
  DOCUMENT_SESSION_VERSION,
  buildDocumentSessionEnvelope,
  documentIsBlank,
  parseDocumentSessionEnvelope,
  shouldRestoreDocumentSession
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
