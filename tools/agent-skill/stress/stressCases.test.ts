import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = resolve(fileURLToPath(new URL(".", import.meta.url)));
const cases = JSON.parse(readFileSync(resolve(directory, "cases.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(directory, "references.lock.json"), "utf8"));

function referenceKeys(document: typeof cases): string[] {
  return document.cases.flatMap((testCase: { id: string; expect: Record<string, unknown> }) => {
    let index = 0;
    const count = (entries: unknown) => Array.isArray(entries) ? entries.map(() => `${testCase.id}:${index++}`) : [];
    const reaction = testCase.expect.reaction as Record<string, unknown> | undefined;
    return [
      ...count(testCase.expect.structures),
      ...count(reaction?.reactants), ...count(reaction?.products), ...count(reaction?.products_any_of), ...count(reaction?.intermediates)
    ];
  }).sort();
}

describe("agent-skill stress cases", () => {
  it("is a well-formed, balanced fixed test set", () => {
    expect(cases.cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.cases.length).toBeLessThanOrEqual(80);
    expect(new Set(cases.cases.map((testCase: { id: string }) => testCase.id)).size).toBe(cases.cases.length);
    const categories = new Map<string, typeof cases.cases>();
    for (const testCase of cases.cases) categories.set(testCase.category, [...(categories.get(testCase.category) ?? []), testCase]);
    for (const category of categories.values()) {
      const heldout = category.filter((testCase) => testCase.split === "heldout").length;
      expect(heldout).toBeGreaterThan(0);
      expect(category.length - heldout).toBeGreaterThan(0);
      expect(heldout / category.length).toBeGreaterThanOrEqual(0.25);
      expect(heldout / category.length).toBeLessThanOrEqual(0.45);
    }
  });

  it("requires a prompt, rubric, and valid answer regular expressions", () => {
    for (const testCase of cases.cases) {
      expect(testCase.prompt.trim()).not.toBe("");
      expect(testCase.rubric.length).toBeGreaterThan(0);
      for (const pattern of [...(testCase.expect.answer_regex ?? []), ...(testCase.expect.answer_forbid_regex ?? [])]) {
        expect(() => new RegExp(pattern)).not.toThrow();
      }
    }
  });

  it("locks exactly the reference set and keeps a versioned scoring rule", () => {
    expect(lock.references.map((entry: { caseId: string; referenceIndex: number }) => `${entry.caseId}:${entry.referenceIndex}`).sort())
      .toEqual(referenceKeys(cases));
    expect(readFileSync(resolve(directory, "SCORING.md"), "utf8")).toContain("SCORING_VERSION");
  });
});
