import type { DocumentPage } from "./schemas";

/** A whole-page order names bystanders too. Only scoped objects may move through that
 * order: the subsequence of unselected IDs must be identical, including multiplicities.
 * setObjectOrder is a pure permutation; callers still gate every content/crossing write
 * separately and verify normalization preserves unselected content. */
export function unselectedObjectOrderChange(
  page: DocumentPage, objectIds: readonly string[], scope: ReadonlySet<string>
): string | undefined {
  const before = page.objects.map(object => object.id).filter(id => !scope.has(id));
  const after = objectIds.filter(id => !scope.has(id));
  for (let i = 0; i < Math.max(before.length, after.length); i++) {
    if (before[i] !== after[i]) return before[i] ?? after[i];
  }
  return undefined;
}
