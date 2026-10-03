import { describe, expect, it } from "vitest";
import { isStableBuild, labelFromEnv, worktreeLabelFor } from "./worktree-identity.mjs";

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

  it("does not let an inherited empty label unlabel a branch build", () => {
    for (const inherited of ["", "   "]) {
      const env = { CHEMDRAFT_WORKTREE_LABEL: inherited };
      expect(worktreeLabelFor({ command: "build", identity: identity("feature/x"), env })).toBe("chemdraw [feature/x]");
      expect(worktreeLabelFor({ command: "dev", identity: identity("main"), env })).toBe("chemdraw [main]");
    }
  });

  it("never treats dev as stable, even on main", () => {
    expect(isStableBuild({ command: "dev", branch: "main", env: { CHEMDRAFT_STABLE_BUILD: "1" } })).toBe(false);
    expect(worktreeLabelFor({ command: "dev", identity: identity("main"), env: {} })).toBe("chemdraw [main]");
  });
});

describe("labelFromEnv", () => {
  it("returns the empty string for a defined-empty label (stable build: no git fallback)", () => {
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: "" })).toBe("");
  });

  it("returns the empty string for a whitespace label", () => {
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: "   " })).toBe("");
  });

  it("returns undefined when the variable is not set", () => {
    expect(labelFromEnv({})).toBeUndefined();
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: undefined })).toBeUndefined();
  });

  it("returns the trimmed value otherwise", () => {
    expect(labelFromEnv({ CHEMDRAFT_WORKTREE_LABEL: "  chemdraw [x] " })).toBe("chemdraw [x]");
  });
});
