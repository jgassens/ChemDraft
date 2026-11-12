export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function verifySourceCommit(plist, commit) {
  if (!COMMIT_PATTERN.test(plist.ChemDraftSourceCommit ?? "")) throw new Error("ChemDraftSourceCommit: missing or invalid full source commit");
  if (commit !== undefined && plist.ChemDraftSourceCommit !== commit) throw new Error(`ChemDraftSourceCommit: expected ${commit}, found ${plist.ChemDraftSourceCommit}`);
}
