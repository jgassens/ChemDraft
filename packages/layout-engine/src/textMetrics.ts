import { helveticaAdvances, helveticaBoldAdvances } from "./textMetrics.generated";

export function textAdvanceEm(character: string, { bold = false }: { bold?: boolean } = {}): number {
  const codePoint = character.codePointAt(0);
  return codePoint === undefined ? 0.62 : (bold ? helveticaBoldAdvances : helveticaAdvances)[codePoint] ?? 0.62;
}

export function measureTextRun(text: string, {
  fontSizePx, fontWeight = 400, script = "normal"
}: { fontSizePx: number; fontWeight?: number; script?: "normal" | "subscript" | "superscript" }): number {
  const em = [...text].reduce((sum, character) => sum + textAdvanceEm(character, { bold: fontWeight >= 600 }), 0);
  return em * fontSizePx * (script === "normal" ? 1 : 0.72);
}
