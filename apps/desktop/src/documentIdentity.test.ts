import { describe, expect, it } from "vitest";
import { createDocumentTabId, documentWindowId, DocumentIdentities, isDocumentWindowId } from "./documentIdentity";

const uuid = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

describe("document identities", () => {
  it("accepts document label syntax and refuses utilities and malformed labels", () => {
    for (const label of ["main", "doc-example"]) expect(isDocumentWindowId(label)).toBe(true);
    for (const label of ["doc-", "doc-../main", "toolset-core-main", "dialog-main-export-1",
      "plugin-panel-example", "runtime", "preferences", null]) expect(isDocumentWindowId(label)).toBe(false);
  });
  it("creates unique UUID tab ids", () => {
    const ids = Array.from({ length: 100 }, createDocumentTabId);
    expect(new Set(ids).size).toBe(ids.length);
    ids.forEach(id => expect(id).toMatch(uuid));
  });

  it("resolves the migrated main window and explicit document routes", () => {
    expect(documentWindowId("")).toBe("main");
    expect(documentWindowId("?agentBridge=1")).toBe("main");
    expect(documentWindowId("?window=doc&id=doc-123")).toBe("doc-123");
    expect(documentWindowId("?window=dialog&id=other")).toBe("main");
  });

  it("keys revisions by stable tab id and separates windows, tabs and revisions", () => {
    const a = createDocumentTabId(), b = createDocumentTabId();
    const main = new DocumentIdentities("main");
    const other = new DocumentIdentities("doc-other");
    const initial = main.key(a);
    expect(initial).toBe(`main:${a}:0`);
    expect(main.key(a)).toBe(initial); // ordinary edits do not change the key
    const keys = [initial, main.key(b), other.key(a)];
    main.advance(b); // switch to B
    keys.push(main.key(b));
    main.advance(a); // switch back to A: an old invocation must still be refused
    keys.push(main.key(a));
    main.advance(a); // replace A's document without changing its tab id
    keys.push(main.key(a));
    expect(main.key(a)).toBe(`main:${a}:2`);
    expect(main.key(b)).toBe(`main:${b}:1`);
    expect(new Set(keys).size).toBe(keys.length);
    main.remove(b);
    expect(main.key(a)).toBe(`main:${a}:2`);
  });
});
