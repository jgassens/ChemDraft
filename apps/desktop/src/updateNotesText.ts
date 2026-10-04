/** Segoe UI lacks these glyphs in Windows task dialogs; › is present in every Windows UI font. */
export const WINDOWS_UI_GLYPH_REPLACEMENTS: Record<string, string> = {
  "▸": "›",
  "▹": "›",
  "▶": "›",
  "►": "›"
};

export function updateNotesPlainText(markdown: string): string {
  return markdown
    .replace(/\r\n/g, "\n")
    .replace(/\[([^\]]+)\]\(([^\s)]+)\)/g, "$1 ($2)")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/(?<!\w)(\*\*|__)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/(?<!\w)(\*|_)(?=\S)(.+?)(?<=\S)\1(?!\w)/g, "$2")
    .replace(/^(?: {0,3})#{1,6}[ \t]+/gm, "")
    .replace(/^([ \t]*)[-*+][ \t]+/gm, "$1• ")
    .replace(/[▸▹▶►]/g, (glyph) => WINDOWS_UI_GLYPH_REPLACEMENTS[glyph])
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
