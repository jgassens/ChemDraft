import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const directory = resolve(fileURLToPath(new URL(".", import.meta.url)));
type StressExpect = {
  structures?: unknown;
  reaction?: {
    reactants?: unknown;
    products?: unknown;
    products_any_of?: unknown;
    intermediates?: unknown;
  };
  answer_regex?: string[];
  answer_forbid_regex?: string[];
};

type StressCase = {
  id: string;
  category: string;
  split: string;
  prompt: string;
  rubric: unknown[];
  expect: StressExpect;
};

type StressCaseDocument = { cases: StressCase[] };

const cases: StressCaseDocument = JSON.parse(readFileSync(resolve(directory, "cases.json"), "utf8"));
const lock: { references: { caseId: string; referenceIndex: number }[] } = JSON.parse(readFileSync(resolve(directory, "references.lock.json"), "utf8"));

function referenceKeys(document: StressCaseDocument): string[] {
  return document.cases.flatMap((testCase) => {
    let index = 0;
    const count = (entries: unknown) => Array.isArray(entries) ? entries.map(() => `${testCase.id}:${index++}`) : [];
    const reaction = testCase.expect.reaction;
    return [
      ...count(testCase.expect.structures),
      ...count(reaction?.reactants), ...count(reaction?.products), ...count(reaction?.products_any_of), ...count(reaction?.intermediates)
    ];
  }).sort();
}

function compileAnswerRegex(pattern: string): RegExp {
  return pattern.startsWith("(?i)")
    ? new RegExp(pattern.slice("(?i)".length), "i")
    : new RegExp(pattern);
}

describe("agent-skill stress cases", () => {
  it("is a well-formed, balanced fixed test set", () => {
    expect(cases.cases.length).toBeGreaterThanOrEqual(60);
    expect(cases.cases.length).toBeLessThanOrEqual(80);
    expect(new Set(cases.cases.map((testCase) => testCase.id)).size).toBe(cases.cases.length);
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
        expect(() => compileAnswerRegex(pattern)).not.toThrow();
      }
    }
  });

  it("locks exactly the reference set and keeps a versioned scoring rule", () => {
    expect(lock.references.map((entry: { caseId: string; referenceIndex: number }) => `${entry.caseId}:${entry.referenceIndex}`).sort())
      .toEqual(referenceKeys(cases));
    expect(readFileSync(resolve(directory, "SCORING.md"), "utf8")).toContain("SCORING_VERSION");
    expect(readFileSync(resolve(directory, "SCORING.md"), "utf8")).toContain('Cases whose `expect` has `mechanism: true` (R04, R05, R07, R12) or `answer_key: true` (D02, the key part) are judged by the visual check only; their automatic result is A8 plus any other listed check.');
    expect(readFileSync(resolve(directory, "runner/README.md"), "utf8")).toContain('A live probe on 2026-10-22 with Claude Code 2.1.x');
  });
});
