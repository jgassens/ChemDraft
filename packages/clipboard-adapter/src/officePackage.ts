import { crc32, inflateBounded } from "./carrierBytes";

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const ZIP64_SIZE = 0xffffffff;
const ENCRYPTED_FLAGS = 0x2041;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export interface OfficeZipEntry {
  name: string;
  data: Uint8Array;
}

interface ZipEntryHeader {
  name: string;
  method: number;
  checksum: number;
  length: number;
  dataStart: number;
  compressedLength: number;
}

function checkZipExtraFields(view: DataView, start: number, end: number): void {
  let offset = start;
  while (offset < end) {
    if (offset + 4 > end) throw new Error("Truncated ZIP extra field.");
    if (view.getUint16(offset, true) === 1) throw new Error("ZIP64 is unsupported.");
    offset += 4 + view.getUint16(offset + 2, true);
  }
  if (offset !== end) throw new Error("Truncated ZIP extra field.");
}

function zipInflater(compressed: Uint8Array, checksum: number, length: number) {
  try {
    return { parts: [compressed], stream: new DecompressionStream("deflate-raw") };
  } catch {
    // Early Node 20 releases support gzip but lack the raw DEFLATE format. ZIP already
    // provides the CRC and size needed to frame the identical stream as gzip.
    const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255);
    const trailer = new Uint8Array(8);
    const view = new DataView(trailer.buffer);
    view.setUint32(0, checksum, true);
    view.setUint32(4, length, true);
    return { parts: [header, compressed, trailer], stream: new DecompressionStream("gzip") };
  }
}

/** Validate a classic single-disk ZIP and return its entries in central-directory order. */
export async function readZip(bytes: Uint8Array): Promise<OfficeZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);
  let endRecord = bytes.length - 22;
  const searchStart = Math.max(0, endRecord - 0xffff);
  while (endRecord >= searchStart) {
    if (u32(endRecord) === 0x06054b50 && endRecord + 22 + u16(endRecord + 20) === bytes.length) break;
    endRecord--;
  }
  if (endRecord < searchStart) throw new Error("Missing or truncated ZIP central directory.");

  const diskCount = u16(endRecord + 8);
  const count = u16(endRecord + 10);
  const size = u32(endRecord + 12);
  const directory = u32(endRecord + 16);
  if (diskCount === 0xffff || count === 0xffff || size === ZIP64_SIZE || directory === ZIP64_SIZE ||
      (endRecord >= 20 && u32(endRecord - 20) === 0x07064b50)) {
    throw new Error("ZIP64 is unsupported.");
  }
  if (u16(endRecord + 4) || u16(endRecord + 6) || diskCount !== count) {
    throw new Error("Multi-disk ZIP is unsupported.");
  }
  if (count > MAX_ENTRIES) throw new Error("ZIP exceeds 2000 entries.");
  if (directory + size !== endRecord) throw new Error("Invalid ZIP central directory bounds.");

  const entries: ZipEntryHeader[] = [];
  const names = new Set<string>();
  let totalLength = 0;
  let position = directory;
  for (let index = 0; index < count; index++) {
    if (position + 46 > endRecord || u32(position) !== 0x02014b50) {
      throw new Error("Truncated ZIP central directory entry.");
    }
    const flags = u16(position + 8);
    const method = u16(position + 10);
    const checksum = u32(position + 16);
    const compressedLength = u32(position + 20);
    const length = u32(position + 24);
    const nameLength = u16(position + 28);
    const extraLength = u16(position + 30);
    const local = u32(position + 42);
    const nameStart = position + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + u16(position + 32);
    if (next > endRecord) throw new Error("Truncated ZIP central directory entry.");
    if (flags & ENCRYPTED_FLAGS) throw new Error("Encrypted ZIP is unsupported.");
    if ([compressedLength, length, local].includes(ZIP64_SIZE)) throw new Error("ZIP64 is unsupported.");
    if (u16(position + 34)) throw new Error("Multi-disk ZIP is unsupported.");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);
    checkZipExtraFields(view, extraStart, extraStart + extraLength);
    if (length > MAX_ENTRY_BYTES) throw new Error("ZIP entry exceeds 50 MB inflated.");
    totalLength += length;
    if (totalLength > MAX_INFLATED_BYTES) throw new Error("ZIP exceeds 200 MB inflated.");

    const nameBytes = bytes.subarray(nameStart, extraStart);
    const name = utf8.decode(nameBytes);
    if (!name || names.has(name)) throw new Error(`Empty or duplicate ZIP entry name: ${name}`);
    names.add(name);
    if (local + 30 > directory || u32(local) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localFlags = u16(local + 6);
    const localNameStart = local + 30;
    const localNameLength = u16(local + 26);
    const localExtraStart = localNameStart + localNameLength;
    const dataStart = localExtraStart + u16(local + 28);
    if (localFlags & ENCRYPTED_FLAGS) throw new Error("Encrypted ZIP is unsupported.");
    if (u32(local + 18) === ZIP64_SIZE || u32(local + 22) === ZIP64_SIZE) throw new Error("ZIP64 is unsupported.");
    if (dataStart + compressedLength > directory) throw new Error(`Truncated ZIP data: ${name}`);
    if (localFlags !== flags || u16(local + 8) !== method || localNameLength !== nameLength ||
        nameBytes.some((byte, index) => byte !== bytes[localNameStart + index])) {
      throw new Error(`ZIP local/central header mismatch: ${name}`);
    }
    // With a data descriptor, CRC and sizes come from the central directory.
    if (!(flags & 8) &&
        (u32(local + 14) !== checksum || u32(local + 18) !== compressedLength || u32(local + 22) !== length)) {
      throw new Error(`ZIP local/central CRC or size mismatch: ${name}`);
    }
    checkZipExtraFields(view, localExtraStart, dataStart);
    if (method === 0 && compressedLength !== length) throw new Error(`ZIP stored size mismatch: ${name}`);
    entries.push({ name, method, checksum, length, dataStart, compressedLength });
    position = next;
  }
  if (position !== endRecord) throw new Error("Invalid ZIP central directory size.");

  const results: OfficeZipEntry[] = [];
  for (const { name, method, checksum, length, dataStart, compressedLength } of entries) {
    const compressed = bytes.subarray(dataStart, dataStart + compressedLength);
    let data = compressed;
    if (method === 8) {
      try {
        const { parts, stream } = zipInflater(compressed, checksum, length);
        data = await inflateBounded(parts, stream, length, "Inflated size exceeds the declared size.", new Uint8Array(length));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new Error(`ZIP decompression failed for ${name}: ${reason}`);
      }
      if (data.length !== length) throw new Error(`ZIP inflated size mismatch: ${name}`);
    }
    if (crc32(data) !== checksum) throw new Error(`ZIP CRC mismatch: ${name}`);
    results.push({ name, data });
  }
  return results;
}

const FLAT_OPC = "http://schemas.microsoft.com/office/2006/xmlPackage";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";
const TRANSITIONAL = "http://schemas.openxmlformats.org/";
const STRICT = "http://purl.oclc.org/ooxml/";
const PRESENTATION = [TRANSITIONAL + "presentationml/2006/main", STRICT + "presentationml/main"];
const DRAWING = [TRANSITIONAL + "drawingml/2006/main", STRICT + "drawingml/main"];
const OFFICE_RELS = [TRANSITIONAL + "officeDocument/2006/relationships", STRICT + "officeDocument/relationships"];

const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function xmlUnescape(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, code: string) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return xmlEntities[code];
  });
}

function qualifiedName(name: string): [prefix: string, local: string] {
  const colon = name.indexOf(":");
  return colon < 0 ? ["", name] : [name.slice(0, colon), name.slice(colon + 1)];
}

interface XmlElement {
  name: string;
  local: string;
  ns: string;
  namespaces: Record<string, string | undefined>;
  attrs: Map<string, string>;
  parent: XmlElement | undefined;
  contentStart: number;
}

// Scan tags without expanding entities. Parent links and scoped namespaces distinguish
// pictures in groups from unrelated shapes, and ignore markup inside comments and CDATA.
function* xmlElements(xml: string): Generator<{ element: XmlElement; closingAt?: number }> {
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([^\s<>/!?="']+)((?:[^<>"']|"[^"]*"|'[^']*')*)>|</g;
  let parent: XmlElement | undefined;
  for (const token of xml.matchAll(tags)) {
    const [markup, closing, name, attributes] = token;
    if (markup === "<") throw new Error("Malformed or unsupported Office XML tag.");
    if (!name) continue;
    if (closing) {
      if (name !== parent?.name || attributes.trim()) throw new Error(`Mismatched Office XML end tag: ${name}`);
      yield { element: parent, closingAt: token.index };
      parent = parent.parent;
      continue;
    }
    const namespaces: XmlElement["namespaces"] = Object.create(parent?.namespaces ?? null);
    const attrs = new Map<string, string>();
    const selfClosing = attributes.endsWith("/");
    const attrSource = selfClosing ? attributes.slice(0, -1) : attributes;
    const attribute = /\s+([^\s<>/="']+)\s*=\s*(?:"([^"]*)"|'([^']*)')/gy;
    let attrEnd = 0;
    for (const match of attrSource.matchAll(attribute)) {
      const [, key, doubleQuoted, singleQuoted] = match;
      const value = xmlUnescape(doubleQuoted ?? singleQuoted);
      if (key === "xmlns") namespaces[""] = value;
      else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
      else {
        if (attrs.has(key)) throw new Error(`Duplicate Office XML attribute: ${key}`);
        attrs.set(key, value);
      }
      attrEnd = match.index + match[0].length;
    }
    if (attrSource.slice(attrEnd).trim()) throw new Error(`Malformed Office XML attributes: ${name}`);
    const [prefix, local] = qualifiedName(name);
    const element: XmlElement = { name, local, ns: namespaces[prefix] ?? "", namespaces, attrs, parent,
      contentStart: token.index + markup.length };
    yield { element };
    if (selfClosing) yield { element, closingAt: element.contentStart };
    else parent = element;
  }
  if (parent) throw new Error(`Unclosed Office XML tag: ${parent.name}`);
}

function namespacedAttr(element: XmlElement, local: string, namespaces: readonly string[]): string | undefined {
  for (const [key, value] of element.attrs) {
    const [prefix, attr] = qualifiedName(key);
    if (attr === local && prefix && namespaces.includes(element.namespaces[prefix] ?? "")) return value;
  }
  return undefined;
}

export interface FlatOpcBinaryPart {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Recover binary parts from Word's Flat OPC XML, in package order. */
export function flatOpcBinaryParts(flatOpcXml: string): FlatOpcBinaryPart[] {
  const parts: FlatOpcBinaryPart[] = [];
  for (const { element, closingAt } of xmlElements(flatOpcXml)) {
    const part = element.parent;
    if (closingAt === undefined || element.ns !== FLAT_OPC || element.local !== "binaryData" ||
        part?.ns !== FLAT_OPC || part.local !== "part") continue;
    const name = namespacedAttr(part, "name", [FLAT_OPC]);
    const contentType = namespacedAttr(part, "contentType", [FLAT_OPC]);
    if (!name || !contentType) throw new Error("Flat OPC binary part is missing its name or content type.");
    // atob accepts the ASCII whitespace that Word puts between base64 lines.
    const binary = atob(xmlUnescape(flatOpcXml.slice(element.contentStart, closingAt)));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
    parts.push({ name, contentType, bytes });
  }
  return parts;
}

function resolveMediaTarget(target: string): string | null {
  if (/[?#]/.test(target)) return null;
  let path: string;
  try {
    path = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:|^\/\/|[\\\0]/i.test(path)) return null;
  const segments = path.startsWith("/") ? [] : ["ppt", "slides"];
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else if (segment && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments[0] === "ppt" && segments[1] === "media" && segments.length > 2 ? segments.join("/") : null;
}

/** Resolve a slide picture's embedded image to its ZIP part name, including within groups. */
export function pptxSlidePictureMedia(slideXml: string, slideRelsXml: string, shapeId: string | number): string | null {
  const pictures = new Map<XmlElement, { id?: string; embed?: string }>();
  for (const { element, closingAt } of xmlElements(slideXml)) {
    if (closingAt !== undefined) continue;
    const { parent, ns, local } = element;
    const picture = parent?.parent;
    if (!parent || picture?.local !== "pic" || !PRESENTATION.includes(picture.ns) ||
        !PRESENTATION.includes(parent.ns)) continue;
    const data = pictures.get(picture) ?? {};
    if (local === "cNvPr" && PRESENTATION.includes(ns) && parent.local === "nvPicPr") {
      data.id = element.attrs.get("id");
    } else if (local === "blip" && DRAWING.includes(ns) && parent.local === "blipFill") {
      data.embed = namespacedAttr(element, "embed", OFFICE_RELS);
    } else continue;
    pictures.set(picture, data);
  }
  const matches = [...pictures.values()].filter(({ id }) => id === String(shapeId));
  if (matches.length > 1) throw new Error(`Duplicate picture ID in slide XML: ${shapeId}`);
  const relationshipId = matches[0]?.embed;
  if (!relationshipId) return null;

  let match: XmlElement | undefined;
  for (const { element, closingAt } of xmlElements(slideRelsXml)) {
    if (closingAt !== undefined || element.ns !== PACKAGE_RELS || element.local !== "Relationship" ||
        element.parent?.ns !== PACKAGE_RELS || element.parent.local !== "Relationships" ||
        element.attrs.get("Id") !== relationshipId) continue;
    if (match) throw new Error(`Duplicate image relationship ID in slide XML: ${relationshipId}`);
    match = element;
  }
  const type = match?.attrs.get("Type");
  const mode = match?.attrs.get("TargetMode");
  const target = match?.attrs.get("Target");
  if (!OFFICE_RELS.some((namespace) => type === `${namespace}/image`) || (mode && mode !== "Internal") || !target) {
    return null;
  }
  return resolveMediaTarget(target);
}
