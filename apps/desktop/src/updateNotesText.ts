/** Segoe UI lacks these glyphs in Windows task dialogs; › is present in every Windows UI font. */
const WINDOWS_UI_GLYPH_REPLACEMENTS: Record<string, string> = {
  "▸": "›",
  "▹": "›",
  "▶": "›",
  "►": "›"
};

export function updateNotesPlainText(markdown: string): string {
  const protectedLiterals: string[] = [];
  const protect = (literal: string) => {
    const token = `\uE000${protectedLiterals.length}\uE001`;
    protectedLiterals.push(literal);
    return token;
  };
  const restore = (literal: string): string => literal.replace(
    /\uE000(\d+)\uE001/g,
    (token, index: string) => restore(protectedLiterals[Number(index)] ?? token)
  );

  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/^```[^\n]*\n([\s\S]*?)^```[ \t]*(?:\n|$)/gm, (_match, code: string) => protect(code))
    .replace(/\\([*_#\-\[\]()\\`])/g, (_match, character: string) => protect(character))
    .replace(/`([^`\n]+)`/g, (_match, code: string) => protect(code))
    .replace(
      /\[([^\]]+)\]\(([^\s)]+)\)/g,
      (_match, text: string, url: string) => `${text} (${protect(url)})`
    )
    .replace(/<((?:https?):\/\/[^>\s]+)>/g, (_match, url: string) => protect(url))
    .replace(/^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/gm, "")
    .replace(/(?<![\p{L}\p{N}_])(\*\*|__)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, "$2")
    .replace(/(?<![\p{L}\p{N}_])(\*|_)(?=\S)(.+?)(?<=\S)\1(?![\p{L}\p{N}_])/gu, "$2")
    .replace(/^(?: {0,3})#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\uE000(\d+)\uE001/g, (token, index: string) => restore(protectedLiterals[Number(index)] ?? token))
    .replace(/[▸▹▶►]/g, (glyph) => WINDOWS_UI_GLYPH_REPLACEMENTS[glyph])
    .trim();
}
