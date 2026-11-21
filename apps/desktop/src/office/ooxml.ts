export const OPC = "http://schemas.microsoft.com/office/2006/xmlPackage";
export const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
export const WP = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
export const WP14 = "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing";
export const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
export const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
export const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
export const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
export const PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships";

export function xmlDocument(text: string): Document {
  if (text.length > 40 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new Error("Office returned unsupported or oversized XML.");
  }
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagNameNS("*", "parsererror").length) {
    throw new Error("Office returned malformed XML.");
  }
  return doc;
}

export function children(node: Element, ns: string, localName: string) {
  return [...node.children].filter(child => child.namespaceURI === ns && child.localName === localName);
}

export function child(node: Element | undefined, ns: string, name: string) {
  if (!node) return undefined;
  const nodes = children(node, ns, name);
  if (nodes.length > 1) throw new Error("Duplicate Office XML element: " + name + ".");
  return nodes[0];
}

export function partXml(doc: Document, name: string) {
  const parts = children(doc.documentElement, OPC, "part").filter(part => part.getAttributeNS(OPC, "name") === name);
  if (parts.length > 1) throw new Error("Office returned duplicate package parts.");
  return child(parts[0], OPC, "xmlData")?.firstElementChild ?? undefined;
}

export function relationshipPart(rels: Element | undefined, id: string, owner: string, type: string) {
  if (!rels || rels.namespaceURI !== PKG_REL || rels.localName !== "Relationships") return undefined;
  const matches = children(rels, PKG_REL, "Relationship").filter(rel => rel.getAttribute("Id") === id);
  if (matches.length > 1) throw new Error("Office returned duplicate relationships.");
  const rel = matches[0];
  const mode = rel?.getAttribute("TargetMode");
  if (!rel || (mode && mode !== "Internal") || rel.getAttribute("Type") !== R + "/" + type) return undefined;
  const target = decodeURIComponent(rel.getAttribute("Target") ?? "");
  if (!target || /^[\w+.-]+:|^\/\/|[\\?#\0]/.test(target)) return undefined;
  const path = target.startsWith("/") ? [] : owner.split("/").slice(0, -1);
  for (const segment of target.split("/")) {
    if (segment === "..") {
      if (!path.length) return undefined;
      path.pop();
    } else if (segment && segment !== ".") path.push(segment);
  }
  return path.join("/");
}

export function hasCrop(picture: Element) {
  return [...picture.getElementsByTagNameNS(A, "srcRect")].some(rect =>
    ["l", "t", "r", "b"].some(edge => {
      const value = rect.getAttribute(edge);
      return value !== null && !/^[+-]?0+(?:\.0+)?%?$/.test(value);
    }));
}

export const decodeXml = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
