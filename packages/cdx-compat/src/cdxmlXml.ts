import { XMLParser, XMLValidator } from "fast-xml-parser";

export type OrderedXmlNode = Record<string, unknown>;
export type OrderedXmlTree = OrderedXmlNode[];

export interface XmlElementView {
  name: string;
  children: OrderedXmlTree;
  attributes: Record<string, string>;
}

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: false,
  // Decode references once in text and attributes, without enabling named HTML entities.
  // The custom decoder also leaves document-defined entities unexpanded.
  entityDecoder: {
    decode: decodeXmlReferences,
    reset() {},
    setExternalEntities() {},
    addInputEntities() {},
    setXmlVersion() {}
  },
  commentPropName: "#comment",
  cdataPropName: "#cdata"
});

export function parseCdxml(contents: string, parser = xmlParser, sourceFormat: "CDXML" | "CDX" = "CDXML"): OrderedXmlTree {
  const xml = stripByteOrderMark(contents);
  const validation = XMLValidator.validate(withLongAttributeValuesShortened(xml));
  if (validation !== true) {
    throw new Error(validation.err.msg);
  }
  const parsed = parser.parse(xml) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`${sourceFormat} parser returned an unexpected document shape.`);
  }
  return parsed as OrderedXmlTree;
}

/** The document element, skipping the XML declaration and other processing instructions. */
export function xmlRootElement(tree: OrderedXmlTree): XmlElementView | undefined {
  for (const node of tree) {
    const element = elementView(node);
    if (element && !element.name.startsWith("?") && !element.name.startsWith("!")) {
      return element;
    }
  }
  return undefined;
}

export function childElements(parent: XmlElementView, name: string): XmlElementView[] {
  return parent.children.flatMap((node) => {
    const element = elementView(node);
    return element?.name === name ? [element] : [];
  });
}

export function elementView(node: OrderedXmlNode): XmlElementView | undefined {
  const name = Object.keys(node).find((key) => key !== ":@");
  if (!name || name === "#text" || name === "#comment" || name === "#cdata") {
    return undefined;
  }
  const rawChildren = node[name];
  const children = Array.isArray(rawChildren) ? rawChildren as OrderedXmlTree : [];
  const attributes = attributesFromNode(node);
  return { name, children, attributes };
}

function attributesFromNode(node: OrderedXmlNode): Record<string, string> {
  const raw = node[":@"];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {};
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

export function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * fast-xml-parser's validator matches attribute values with `(([\s\S])*?)`, a group repeated once per
 * character, which V8 runs recursively: a value of a few hundred thousand characters overflows the
 * stack. The embedded ChemDraft payload is exactly such a value — base64 of the whole document — so
 * every large drawing failed to save (the export re-parses its own output for the visible hash) and a
 * large saved file could not be reopened. Validation only checks structure, so it runs on a copy with
 * long values shortened; the parser, whose attribute pattern is flat, reads the real text.
 */
const VALIDATION_ATTRIBUTE_VALUE_LIMIT = 4096;

// A linear scan, not a regular expression: even `"[^"<]{4096,}"` keeps backtracking state per
// character in V8 and overflows on a multi-megabyte match. It reads quotes only inside markup —
// never in text, comments, or CDATA. Text may hold a raw quote (the writer escapes only `&`, `<`
// and `>` there), and a scan keyed on every `=` took `pH = "7` in a caption for an attribute: the
// quote paired with a later one, the payload after it went unshortened, and the app refused to
// reopen its own file.
function withLongAttributeValuesShortened(xml: string): string {
  let result = "";
  let copiedUpTo = 0;
  let cursor = 0;
  for (;;) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) {
      break;
    }
    const skipTo = xml.startsWith("<!--", open)
      ? xml.indexOf("-->", open + 4)
      : xml.startsWith("<![CDATA[", open)
        ? xml.indexOf("]]>", open + 9)
        : undefined;
    if (skipTo !== undefined) {
      if (skipTo === -1) {
        break;
      }
      cursor = skipTo + 3;
      continue;
    }
    // A tag (or `<?…?>`, `<!DOCTYPE …>`): quoted values until the `>` outside them.
    let index = open + 1;
    for (; index < xml.length; index += 1) {
      const character = xml[index];
      if (character === ">") {
        break;
      }
      if (character !== '"' && character !== "'") {
        continue;
      }
      const close = xml.indexOf(character, index + 1);
      if (close === -1) {
        // Unterminated: nothing to shorten, and the validator reports the real error.
        return copiedUpTo === 0 ? xml : result + xml.slice(copiedUpTo);
      }
      const lessThan = xml.indexOf("<", index + 1);
      if (close - index - 1 >= VALIDATION_ATTRIBUTE_VALUE_LIMIT && (lessThan === -1 || lessThan > close)) {
        result += `${xml.slice(copiedUpTo, index + 1)}…`;
        copiedUpTo = close;
      }
      index = close;
    }
    cursor = index + 1;
  }
  return copiedUpTo === 0 ? xml : result + xml.slice(copiedUpTo);
}

/** Decode XML's five predefined entities and numeric character references, once. Entities a
 * document defines in a DOCTYPE stay literal, so a crafted file cannot expand them. */
function decodeXmlReferences(value: string): string {
  const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  // A single replace never scans its replacement text: &amp;#10; stays literal &#10;.
  return value.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, (reference, entity: string) => {
    if (entity[0] !== "#") return xmlEntities[entity];
    const codePoint = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(codePoint === 9 || codePoint === 10 || codePoint === 13
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff))) {
      throw new Error(`Invalid XML character reference "${reference}".`);
    }
    return String.fromCodePoint(codePoint);
  });
}
