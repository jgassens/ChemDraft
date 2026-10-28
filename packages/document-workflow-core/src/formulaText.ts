import { elementSymbols, type TextSpan } from "@chemdraft/chem-core";

/** Chemical-formula span formatting: digit runs that follow an element letter or closing
 *  parenthesis become subscripts, and a trailing charge (optional digits plus +, -, or −) becomes a
 *  superscript. Everything else stays a normal span. */
/**
 * A run of element symbols, groupings, and counts — what a trailing sign must follow to be a charge
 * at all. "trans-", "Boc-", and "tert-" fail this and keep their hyphen.
 *
 * Written so that at most one alternative can match at any position: a digit is consumed only by a
 * `\d*` suffix, never by an alternative of its own. The earlier spelling offered both
 * `[A-Z][a-z]?\d*` and a standalone `\d+`, so a long digit run had 2^(n-1) parses and a
 * non-matching tail sent the engine through all of them — a pasted label of ~30 digits froze the
 * app. Same language, linear time.
 */
const formulaBodyPattern = /^\d*(?:(?:[A-Z][a-z]?|[()[\]·])\d*)*$/;
const singleElementPattern = /^[A-Z][a-z]?$/;

/**
 * Index where a trailing charge begins, or `text.length` when there is none.
 *
 * The hard case is that a digit before the sign can be either a charge magnitude or an atom count,
 * and the two are spelled identically: in "Ca2+" the 2 is the charge, in "NH4+" the 4 is a count.
 * Two or more digits always split (the last is the magnitude, as in "SO42-"); a single digit is
 * read as the magnitude only when the body is one element symbol, which is what separates the
 * metal cations from the polyatomic ions.
 */
function formulaChargeStart(text: string): number {
  const match = /(\d*)([+\-±−])$/.exec(text);
  if (!match) {
    return text.length;
  }

  const signIndex = text.length - 1;
  const digits = match[1];
  const body = text.slice(0, text.length - match[0].length);
  // The pattern below accepts the empty string; a bare sign is not a charged formula.
  if (body.length === 0 || !formulaBodyPattern.test(body)) {
    return text.length;
  }
  if (digits.length === 0) {
    return signIndex;
  }
  if (digits.length >= 2) {
    return signIndex - 1;
  }
  return singleElementPattern.test(body) ? signIndex - 1 : signIndex;
}

/** Per-character source styles, so reformatting keeps colour, font, and weight. */
function formulaCharacterStyles(
  text: string,
  sourceSpans: readonly TextSpan[]
): Array<TextSpan["style"] | undefined> {
  const styles: Array<TextSpan["style"] | undefined> = [];
  for (const span of sourceSpans) {
    for (let index = 0; index < span.text.length; index += 1) {
      styles.push(span.style);
    }
  }
  while (styles.length < text.length) {
    styles.push(styles[styles.length - 1]);
  }
  return styles;
}

export function formulaSpansFromText(text: string, sourceSpans: readonly TextSpan[] = []): TextSpan[] {
  if (text.length === 0) {
    return [{ text: "", script: "normal", style: {} }];
  }

  const styles = formulaCharacterStyles(text, sourceSpans);
  const runs: Array<{ text: string; script: TextSpan["script"]; style: TextSpan["style"] | undefined }> = [];
  const pushRun = (runText: string, script: TextSpan["script"], at: number) => {
    if (runText.length === 0) {
      return;
    }
    const style = styles[at];
    const previous = runs[runs.length - 1];
    // Styles come from the source spans, so identical styling is the same object reference.
    if (previous && previous.script === script && previous.style === style) {
      previous.text += runText;
      return;
    }
    runs.push({ text: runText, script, style });
  };

  const chargeStart = formulaChargeStart(text);
  let index = 0;
  while (index < chargeStart) {
    const character = text[index];
    if (/\d/.test(character) && index > 0 && /[A-Za-z)\]]/.test(text[index - 1])) {
      let end = index;
      while (end < chargeStart && /\d/.test(text[end])) {
        end += 1;
      }
      pushRun(text.slice(index, end), "subscript", index);
      index = end;
      continue;
    }
    pushRun(character, "normal", index);
    index += 1;
  }
  if (chargeStart < text.length) {
    pushRun(text.slice(chargeStart), "superscript", chargeStart);
  }

  return runs.map((run) => ({ text: run.text, script: run.script, style: { ...(run.style ?? {}) } }));
}

const formulaParts = [
  ...elementSymbols, "D", "T",
  ...("Me Et Pr iPr nPr Bu nBu tBu sBu iBu Ph Bn Bz Ac Ts Ms Tf Tol Boc Cbz Fmoc " +
    "TMS TES TBS TIPS Cp Cy Py dba cod acac dppf").split(" ")
].sort((a, b) => b.length - a.length);

// Only fully parsed tokens with a count are formatted. C18-like labels can pass this
// heuristic; a separate undo entry lets the user undo that accepted miss.
function isFormulaToken(token: string): boolean {
  if (!/[A-Za-z)\]]\d/.test(token)) return false;
  const end = /[+\-±−]$/.test(token) ? token.length - 1 : token.length;
  // TODO(isotopes): a leading mass number before an element symbol (13CH3I) is read as a coefficient and
  // stays plain; the isotope-label work decides whether it becomes a superscript (¹³CH₃I).
  let index = 0;
  while (index < end && /\d/.test(token[index])) index += 1;
  const stack: string[] = [];
  let hasPart = false;
  while (index < end) {
    const char = token[index];
    if (char === "(" || char === "[") { stack.push(char); index += 1; continue; }
    if (char === ")" || char === "]") {
      if (stack.pop() !== (char === ")" ? "(" : "[")) return false;
      index += 1; continue;
    }
    if (/\d/.test(char)) {
      while (index < end && /\d/.test(token[index])) index += 1;
      continue;
    }
    if (char === "·") {
      index += 1;
      const coefficientStart = index;
      while (index < end && /\d/.test(token[index])) index += 1;
      if (index > coefficientStart && token[index] === "." && /\d/.test(token[index + 1] ?? "")) {
        index += 1;
        while (index < end && /\d/.test(token[index])) index += 1;
      }
      continue;
    }
    const part = formulaParts.find(value => index + value.length <= end && token.startsWith(value, index));
    if (!part) return false;
    hasPart = true;
    index += part.length;
  }
  return hasPart && stack.length === 0;
}

/** Formats formula-like tokens embedded in mixed text while preserving surrounding text and styles. */
export function formulaSpansForMixedText(text: string, sourceSpans: readonly TextSpan[] = []): TextSpan[] | undefined {
  const source = sourceSpans.length && sourceSpans.map(span => span.text).join("") === text
    ? sourceSpans : [{ text, script: "normal" as const, style: {} }];
  const slice = (start: number, end: number): TextSpan[] => {
    let offset = 0;
    return source.flatMap(span => {
      const from = Math.max(0, start - offset), to = Math.min(span.text.length, end - offset);
      offset += span.text.length;
      return to > from ? [{ ...span, text: span.text.slice(from, to) }] : [];
    });
  };
  const result: TextSpan[] = [];
  let offset = 0, changed = false;
  for (const match of text.matchAll(/\S+/g)) {
    const start = match.index;
    result.push(...slice(offset, start));
    const token = match[0].replace(/[,;:.!?*†‡]+$/, "");
    const end = start + token.length;
    const original = slice(start, end);
    if (isFormulaToken(token)) {
      const formatted = formulaSpansFromText(token, original);
      const scripts = (spans: readonly TextSpan[]) => spans.flatMap(span => Array(span.text.length).fill(span.script));
      if (JSON.stringify(scripts(original)) !== JSON.stringify(scripts(formatted))) changed = true;
      result.push(...formatted);
    } else result.push(...original);
    result.push(...slice(end, start + match[0].length));
    offset = start + match[0].length;
  }
  result.push(...slice(offset, text.length));
  return changed ? result : undefined;
}
