import { describe, expect, it } from "vitest";
import { isStableBuild, worktreeLabelFor } from "./worktree-identity.mjs";

const identity = (branch: string) => ({ branch, label: `chemdraw [${branch}]` });

describe("worktreeLabelFor", () => {
  it("labels a build on main with the empty string, even over an inherited label", () => {
    expect(isStableBuild({ command: "build", branch: "main", env: {} })).toBe(true);
    expect(worktreeLabelFor({ command: "build", identity: identity("main"), env: {} })).toBe("");
    expect(
      worktreeLabelFor({ command: "build", identity: identity("main"), env: { CHEMDRAFT_WORKTREE_LABEL: "leaked [x]" } })
    ).toBe("");
  });

  it("treats CHEMDRAFT_STABLE_BUILD=1 on a release branch as stable", () => {
    const env = { CHEMDRAFT_STABLE_BUILD: "1" };
    expect(isStableBuild({ command: "build", branch: "release/0.3.7", env })).toBe(true);
    expect(worktreeLabelFor({ command: "build", identity: identity("release/0.3.7"), env })).toBe("");
  });

  it("keeps the identity label on a feature-branch build", () => {
    expect(isStableBuild({ command: "build", branch: "feature/x", env: {} })).toBe(false);
    expect(worktreeLabelFor({ command: "build", identity: identity("feature/x"), env: {} })).toBe("chemdraw [feature/x]");
  });

  it("prefers an env label on a feature-branch build", () => {
    expect(
      worktreeLabelFor({ command: "build", identity: identity("feature/x"), env: { CHEMDRAFT_WORKTREE_LABEL: "mine" } })
    ).toBe("mine");
  });

  it("never treats dev as stable, even on main", () => {
    expect(isStableBuild({ command: "dev", branch: "main", env: { CHEMDRAFT_STABLE_BUILD: "1" } })).toBe(false);
    expect(worktreeLabelFor({ command: "dev", identity: identity("main"), env: {} })).toBe("chemdraw [main]");
  });
});
