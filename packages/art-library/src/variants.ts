/** Parses the subject stem and variant ID from a name--variant.svg path. */
export function parseVariantFilename(path: string): { stem: string; variant: string } | undefined {
  const filename = path.split("/").pop() ?? "";
  const match = /^(.*?)--([a-z0-9]+(?:-[a-z0-9]+)*)\.svg$/i.exec(filename);
  if (!match?.[1] || !match[2]) return undefined;
  return { stem: match[1], variant: match[2].toLowerCase() };
}

/** Turns a filename stem into a display name. */
export function prettifyStem(stem: string): string {
  const words = stem.replace(/[-_]+/g, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : words;
}

/** Turns a variant ID into a title-cased display label. */
export function variantLabel(variant: string): string {
  return variant.split(/[-_\s]+/).filter(Boolean)
    .map(word => word[0]!.toUpperCase() + word.slice(1))
    .join(" ");
}
