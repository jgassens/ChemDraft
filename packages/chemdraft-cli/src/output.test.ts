import { describe, expect, it } from "vitest";

import {
  CliUsageError,
  handleCliError,
  parseNamedSmilesJob
} from "./output";

describe("shared CLI output helpers", () => {
  it("validates the common named-SMILES job shape", () => {
    expect(parseNamedSmilesJob({ name: "ethanol", smiles: "CCO" }, 0))
      .toEqual({ name: "ethanol", smiles: "CCO" });
    expect(() => parseNamedSmilesJob({ name: "broken" }, 2))
      .toThrow('Batch job 3 must contain string "name" and "smiles" fields');
  });

  it("emits the shared silent-pnpm usage route and exit policy", () => {
    const stderr: string[] = [];
    const io = { stdout: () => undefined, stderr: (line: string) => stderr.push(line) };
    expect(handleCliError(new CliUsageError("bad option"), io, "render")).toBe(2);
    expect(stderr).toEqual([
      "Error: bad option",
      "Run pnpm -s chemdraft render --help for usage."
    ]);
    expect(handleCliError(new Error("engine failed"), io, "render")).toBe(1);
  });
});
