/** Segoe UI lacks these glyphs in Windows task dialogs; › is present in every Windows UI font. */
export const WINDOWS_UI_GLYPH_REPLACEMENTS: Record<string, string> = {
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

  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/`([^`\n]+)`/g, (_match, code: string) => protect(code))
    .replace(
      /\[([^\]]+)\]\(([^\s)]+)\)/g,
      (_match, text: string, url: string) => `${text} (${protect(url)})`
    )
    .replace(/(?<!\w)(\*\*|__)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/(?<!\w)(\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/^(?: {0,3})#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(/[▸▹▶►]/g, (glyph) => WINDOWS_UI_GLYPH_REPLACEMENTS[glyph])
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\uE000(\d+)\uE001/g, (token, index: string) => protectedLiterals[Number(index)] ?? token)
    .trim();
}
