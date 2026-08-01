/**
 * A placeholder must look like a placeholder.
 *
 * `examples/plugins/` mixes two kinds of directory: real plugins, and named-but-unbuilt targets. A
 * directory called `opsin-name-to-structure` reads as "ChemDraft can turn a name into a structure"
 * whether or not anything is behind it — and PLANS.md did in fact end up asserting exactly that about
 * a directory holding one README. That is the same failure the corpus tag check exists for: a gap that
 * reads as coverage.
 *
 * So the rule is mechanical rather than remembered. Every directory is one or the other, and says
 * which in its own README's first line. Adding a real plugin, or filling a placeholder in, means
 * updating the list below — which is the point: it makes the transition deliberate and reviewable
 * instead of something a reader has to infer from whether `src/` happens to exist.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const EXAMPLES = new URL("../../examples/plugins/", import.meta.url).pathname;

/**
 * The plugins that actually exist. Everything else under `examples/plugins/` must be a placeholder.
 *
 * Kept as a literal rather than derived from the filesystem, because a list derived from "does it
 * have a package.json" would pass no matter what is there — it would assert the filesystem against
 * itself. This is the claim a human made and a test can now hold them to.
 */
const REAL_PLUGINS = ["mass-fragment-demo", "molscribe-ocsr"];

const directories = readdirSync(EXAMPLES, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

describe("examples/plugins is honest about what is built", () => {
  it("finds the directories the plan describes", () => {
    expect(directories.length).toBeGreaterThan(0);
    for (const name of REAL_PLUGINS) expect(directories).toContain(name);
  });

  it.each(directories)("%s is either a real plugin or a declared placeholder", (name) => {
    const root = join(EXAMPLES, name);
    const readmePath = join(root, "README.md");
    expect(existsSync(readmePath), `${name} has no README`).toBe(true);

    const heading = readFileSync(readmePath, "utf8").split("\n")[0] ?? "";
    const declaresPlaceholder = /placeholder/i.test(heading);

    if (REAL_PLUGINS.includes(name)) {
      // A real plugin carries a package and a manifest, and must NOT call itself a placeholder.
      expect(existsSync(join(root, "package.json")), `${name} has no package.json`).toBe(true);
      expect(existsSync(join(root, "src")), `${name} has no src/`).toBe(true);
      expect(declaresPlaceholder, `${name} is listed as real but its README says placeholder`).toBe(false);
      return;
    }

    // A placeholder says so in its heading, and ships no code that could be mistaken for an
    // implementation. The heading is the check because that is the line a reader actually sees.
    expect(declaresPlaceholder, `${name} is not in REAL_PLUGINS, so its README heading must say it is a placeholder`).toBe(true);
    expect(existsSync(join(root, "src")), `${name} declares itself a placeholder but ships src/`).toBe(false);
  });
});
