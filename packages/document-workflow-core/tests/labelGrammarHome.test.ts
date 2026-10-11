// The atom-label grammar has one implementation, in layout-engine (labelGrammar.ts), so the drawn
// label and the chemistry read a label the same way. This package re-exports it under the same
// names; these are the very same functions and tables, never a copy that could drift.

import { describe, expect, it } from "vitest";
import * as layout from "@chemdraft/layout-engine";

import * as core from "../src/index";

describe("the atom-label grammar's one home", () => {
  it.each([
    "nativeAtomLabelReading",
    "nativeAtomValence",
    "nativeLabelGroupAttachment",
    "nativeLabelReadingDependsOnBondSide",
    "nativeSingleHeavyElementLabelValence"
  ] as const)("%s is layout-engine's own, re-exported", (name) => {
    expect(core[name]).toBeDefined();
    expect(core[name]).toBe(layout[name]);
  });
});
