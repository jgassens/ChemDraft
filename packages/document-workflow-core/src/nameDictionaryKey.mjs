/** Exact dictionary keys shared by the offline builder and every reader. */
export const nameKey = name => name.toLowerCase()
  .replace(/[\s\u002d\u2010-\u2015\u2212\ufe63\uff0d]/g, "")
  // Preserve primed locants, regardless of pasted typography. Pair only after
  // folding single primes so mixed apostrophe variants also form double primes.
  .replace(/['’ʼ′‘`]/g, "′")
  .replace(/′′/g, "″")
  .replace(/[.•∙⋅]/g, "·");
