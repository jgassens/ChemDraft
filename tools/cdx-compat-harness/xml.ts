import type { CdxElement } from "../../packages/cdx-compat/src/cdxBinary";

const name = "[A-Za-z_][A-Za-z0-9_.:-]*";
const startTag = new RegExp(`<(${name})`, "y");
const attribute = new RegExp(`\\s+(${name})\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "y");
const endTag = new RegExp(`</(${name})\\s*>`, "y");
const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** Decode once, leaving undeclared named entities literal, as the CDXML importer does. */
function decode(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (entity, value: string) => {
    if (!value.startsWith("#")) return entities[value] ?? entity;
    const code = value.startsWith("#x") ? parseInt(value.slice(2), 16) : Number(value.slice(1));
    if (!(code === 9 || code === 10 || code === 13 || code >= 32 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) {
      throw new Error("Source XML contains an invalid character reference");
    }
    return String.fromCodePoint(code);
  });
}

/** Read source objects without importing them into the native document (which can discard data).
 * This small, non-validating reader retains attributes, child order and text for survival counts
 * and synthetic CDX inputs. It never loads a DTD or expands custom entities. */
export function parseSourceXml(xml: string): CdxElement {
  let position = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  let root: CdxElement | undefined;
  const stack: CdxElement[] = [];
  const fail = (): never => { throw new Error(`Invalid source XML at offset ${position}`); };
  const match = (pattern: RegExp) => {
    pattern.lastIndex = position;
    const result = pattern.exec(xml);
    if (result) position = pattern.lastIndex;
    return result;
  };
  const skipThrough = (ending: string) => {
    const end = xml.indexOf(ending, position);
    if (end < 0) fail();
    position = end + ending.length;
  };
  while (position < xml.length) {
    if (xml.startsWith("<!--", position)) { skipThrough("-->"); continue; }
    if (xml.startsWith("<?", position)) { skipThrough("?>"); continue; }
    if (xml.startsWith("<!DOCTYPE", position)) {
      // Ignore declarations, including internal subsets, without interpreting their contents.
      position += 9;
      let quote = "", depth = 0, closed = false;
      while (position < xml.length) {
        if (!quote && xml.startsWith("<!--", position)) { skipThrough("-->"); continue; }
        const char = xml[position++];
        if (quote) { if (char === quote) quote = ""; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === "[") depth++;
        else if (char === "]") depth--;
        else if (char === ">" && depth === 0) { closed = true; break; }
      }
      if (!closed) fail();
      continue;
    }
    if (xml.startsWith("<![CDATA[", position)) {
      const parent = stack.at(-1);
      if (!parent) fail();
      const begin = position + 9;
      skipThrough("]]>");
      parent!.text += xml.slice(begin, position - 3);
      continue;
    }
    if (xml.startsWith("</", position)) {
      const tag = match(endTag);
      if (!tag || stack.pop()?.name !== tag[1]) fail();
      continue;
    }
    if (xml[position] === "<") {
      const tag = match(startTag);
      if (!tag) fail();
      const node: CdxElement = { name: tag![1], attrs: Object.create(null), kids: [], text: "" };
      let attr: RegExpExecArray | null;
      while ((attr = match(attribute))) {
        if (Object.hasOwn(node.attrs, attr[1]) || (attr[2] ?? attr[3]).includes("<")) fail();
        node.attrs[attr[1]] = decode(attr[2] ?? attr[3]);
      }
      while (/\s/.test(xml[position] ?? "")) position++;
      const selfClosing = xml.startsWith("/>", position);
      if (!selfClosing && xml[position] !== ">") fail();
      position += selfClosing ? 2 : 1;
      const parent = stack.at(-1);
      if (parent) parent.kids.push(node);
      else { if (root) fail(); root = node; }
      if (!selfClosing) stack.push(node);
      continue;
    }
    const next = xml.indexOf("<", position);
    const text = xml.slice(position, next < 0 ? xml.length : next);
    const parent = stack.at(-1);
    if (parent) parent.text += decode(text);
    else if (text.trim()) fail();
    position += text.length;
  }
  if (!root || stack.length) fail();
  return root!;
}
