import type { PageSvgElementFragment, PageSvgFragment } from "./index";

/** Flatten a planned SVG fragment tree into its element fragments, dropping text leaves. */
export function elementFragments(fragment: PageSvgFragment): PageSvgElementFragment[] {
  if (fragment.kind === "text") {
    return [];
  }
  return [fragment, ...fragment.children.flatMap(elementFragments)];
}
