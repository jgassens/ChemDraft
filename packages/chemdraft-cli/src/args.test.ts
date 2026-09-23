import { describe, expect, it } from "vitest";

import {
  booleanOption,
  integerOption,
  numericOption,
  parseOptions,
  repeatedOption,
  stringOption
} from "./args";

describe("parseOptions", () => {
  it("parses value, boolean, repeated, and positional arguments", () => {
    const parsed = parseOptions(
      ["--out", "result.svg", "--verbose", "--tag", "first", "--tag", "second", "input"],
      {
        "--out": { kind: "value" },
        "--verbose": { kind: "boolean" },
        "--tag": { kind: "value", repeated: true }
      }
    );

    expect(stringOption(parsed, "--out")).toBe("result.svg");
    expect(booleanOption(parsed, "--verbose")).toBe(true);
    expect(repeatedOption(parsed, "--tag")).toEqual(["first", "second"]);
    expect(parsed.positionals).toEqual(["input"]);
  });

  it("rejects a value flag without a value", () => {
    expect(() => parseOptions(["--out"], { "--out": { kind: "value" } }))
      .toThrow("--out requires a value");
  });

  it("parses shared finite numeric and integer options", () => {
    expect(numericOption("0", "--padding", true)).toBe(0);
    expect(numericOption("2.5", "--width")).toBe(2.5);
    expect(integerOption("3", "--columns")).toBe(3);
    expect(() => numericOption("NaN", "--width")).toThrow("finite number");
    expect(() => integerOption("1.5", "--columns")).toThrow("positive integer");
  });
});
