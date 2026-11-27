import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("documents art-library among the document-workflow-core dependencies", () => {
  const readme = readFileSync(new URL("../../document-workflow-core/README.md", import.meta.url), "utf8");
  expect(readme).toMatch(/^- Dependencies limited to[^\n]*(?:\n  [^\n]*)*`@chemdraft\/art-library`/m);
});
