import { describe, expect, it } from "vitest";
import { canonicalCommandId, isRenamedCommandId, renamedCommandId } from "./renamedCommands";

describe("renamed command ids", () => {
  it("still redirects a real alias", () => {
    expect(canonicalCommandId("tool.reactionArrow")).toBe("tool.art.reactionArrow");
    expect(isRenamedCommandId("tool.reactionArrow")).toBe(true);
    expect(renamedCommandId("tool.retroArrow")).toBe("tool.art.retroArrow");
  });

  it("passes an unrenamed id straight through", () => {
    expect(canonicalCommandId("tool.bond")).toBe("tool.bond");
    expect(isRenamedCommandId("tool.bond")).toBe(false);
    expect(renamedCommandId("tool.bond")).toBeUndefined();
  });

  it("does not resolve Object.prototype members as renamed commands", () => {
    // A bracket read on an object literal sees inherited members, so these returned functions and
    // Object.prototype itself — past the `?? id` guard and typed as string. Persisted layout state
    // is just ids from disk, so `__proto__` as a hidden-command id was rewritten to a non-string
    // before schema validation, and the gallery dropped any command sharing one of these names.
    for (const inherited of ["constructor", "toString", "hasOwnProperty", "valueOf", "__proto__"]) {
      expect({ id: inherited, renamed: isRenamedCommandId(inherited) })
        .toEqual({ id: inherited, renamed: false });
      expect(canonicalCommandId(inherited)).toBe(inherited);
      expect(renamedCommandId(inherited)).toBeUndefined();
      expect(typeof canonicalCommandId(inherited)).toBe("string");
    }
  });
});
