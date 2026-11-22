import {
  Base64Size, base64Writer, crc32, createDecompressionStream, decodeBase64Bounded, inflateBounded,
  UnsupportedDecompressionError,
} from "./carrierBytes";

const MAX_ENTRIES = 2000;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_ENTRY_BYTES = 50 * 1024 * 1024;
const MAX_INFLATED_BYTES = 200 * 1024 * 1024;
const ZIP64_SIZE = 0xffffffff;
const ENCRYPTED_FLAGS = 0x2041;
const PATCHED_DATA_FLAG = 0x20;
const UTF8_NAME_FLAG = 0x800;
const DATA_DESCRIPTOR_FLAG = 8;
const DATA_DESCRIPTOR_SIGNATURE = 0x08074b50;
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const ascii = new TextDecoder("ascii");

export interface OfficeZipEntry {
  name: string;
  data: Uint8Array;
  /** Set when `OfficeZipCaps.include` declined the entry: it was validated but not inflated. */
  skipped?: true;
}

interface ZipEntryHeader {
  name: string;
  method: number;
  checksum: number;
  length: number;
  local: number;
  dataStart: number;
  compressedLength: number;
  descriptor: boolean;
}

export interface OfficeZipCaps {
  /** Optional lower input limit for the archive. The hard limit is 200 MiB. */
  maxArchiveBytes?: number;
  /** Optional lower limit on the number of entries. The hard limit is 2000. */
  maxEntries?: number;
  /** Optional lower limit on one entry's inflated size. The hard limit is 50 MiB. */
  maxEntryBytes?: number;
  /** Optional lower limit on the sum of every entry's declared inflated size. The hard limit is 200 MiB. */
  maxInflatedBytes?: number;
  /**
   * Inflate only the entries this accepts; the others are still validated (headers, bounds, sizes)
   * but returned with empty data and `skipped: true`. Defaults to every entry.
   */
  include?: (name: string) => boolean;
}

function capLimit(value: number | undefined, hard: number, what: string): number {
  const limit = value ?? hard;
  if (!Number.isSafeInteger(limit) || limit < 0) throw new Error(`Invalid ZIP ${what} limit.`);
  return Math.min(limit, hard);
}

function archiveLimit(caps: OfficeZipCaps): number {
  return capLimit(caps.maxArchiveBytes, MAX_ARCHIVE_BYTES, "archive byte");
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
  if (typeof globalThis.DecompressionStream !== "function") {
    throw new UnsupportedDecompressionError("This runtime lacks DecompressionStream.");
  }
  try {
    return { parts: [compressed], stream: createDecompressionStream("deflate-raw") };
  } catch {
    // Early Node 20 releases support gzip but lack the raw DEFLATE format. ZIP already
    // provides the CRC and size needed to frame the identical stream as gzip.
    const stream = createDecompressionStream("gzip");
    const header = Uint8Array.of(0x1f, 0x8b, 8, 0, 0, 0, 0, 0, 0, 255);
    const trailer = new Uint8Array(8);
    const view = new DataView(trailer.buffer);
    view.setUint32(0, checksum, true);
    view.setUint32(4, length, true);
    return { parts: [header, compressed, trailer], stream };
  }
}

function zipName(bytes: Uint8Array, flags: number): string {
  if (!(flags & UTF8_NAME_FLAG)) {
    if (bytes.some((byte) => byte > 0x7f)) throw new Error("Non-ASCII ZIP entry name without the UTF-8 flag.");
    return ascii.decode(bytes);
  }
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error("Invalid UTF-8 ZIP entry name.");
  }
}

/** Read a ZIP directly from the compact base64 returned by Office.js. */
export async function readZipFromBase64(base64: string, caps: OfficeZipCaps = {}): Promise<OfficeZipEntry[]> {
  return readZip(decodeBase64Bounded(base64, archiveLimit(caps)), caps);
}

/** Validate a classic single-disk ZIP and return its entries in central-directory order. */
export async function readZip(bytes: Uint8Array, caps: OfficeZipCaps = {}): Promise<OfficeZipEntry[]> {
  const limit = archiveLimit(caps);
  const maxEntries = capLimit(caps.maxEntries, MAX_ENTRIES, "entry count");
  const maxEntryBytes = capLimit(caps.maxEntryBytes, MAX_ENTRY_BYTES, "entry byte");
  const maxInflatedBytes = capLimit(caps.maxInflatedBytes, MAX_INFLATED_BYTES, "inflated byte");
  if (bytes.length > limit) throw new Error(`ZIP archive exceeds the ${limit}-byte input limit.`);
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
  if (count > maxEntries) throw new Error(`ZIP exceeds ${maxEntries} entries.`);
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
    if (flags & PATCHED_DATA_FLAG) throw new Error("Patched ZIP data is unsupported.");
    if ([compressedLength, length, local].includes(ZIP64_SIZE)) throw new Error("ZIP64 is unsupported.");
    if (u16(position + 34)) throw new Error("Multi-disk ZIP is unsupported.");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}.`);
    checkZipExtraFields(view, extraStart, extraStart + extraLength);
    if (length > maxEntryBytes) {
      throw new Error(maxEntryBytes === MAX_ENTRY_BYTES ? "ZIP entry exceeds 50 MB inflated."
        : `ZIP entry exceeds the ${maxEntryBytes}-byte inflated limit.`);
    }
    totalLength += length;
    if (totalLength > maxInflatedBytes) {
      throw new Error(maxInflatedBytes === MAX_INFLATED_BYTES ? "ZIP exceeds 200 MB inflated."
        : `ZIP exceeds the ${maxInflatedBytes}-byte total inflated limit.`);
    }

    const nameBytes = bytes.subarray(nameStart, extraStart);
    const name = zipName(nameBytes, flags);
    if (!name || names.has(name)) throw new Error(`Empty or duplicate ZIP entry name: ${name}`);
    names.add(name);
    if (local + 30 > directory || u32(local) !== 0x04034b50) throw new Error(`Invalid ZIP local header: ${name}`);
    const localFlags = u16(local + 6);
    const localNameStart = local + 30;
    const localNameLength = u16(local + 26);
    const localExtraStart = localNameStart + localNameLength;
    const dataStart = localExtraStart + u16(local + 28);
    if (localFlags & ENCRYPTED_FLAGS) throw new Error("Encrypted ZIP is unsupported.");
    if (localFlags & PATCHED_DATA_FLAG) throw new Error("Patched ZIP data is unsupported.");
    if (u32(local + 18) === ZIP64_SIZE || u32(local + 22) === ZIP64_SIZE) throw new Error("ZIP64 is unsupported.");
    if (dataStart + compressedLength > directory) throw new Error(`Truncated ZIP data: ${name}`);
    if (localFlags !== flags || u16(local + 8) !== method || localNameLength !== nameLength ||
        nameBytes.some((byte, index) => byte !== bytes[localNameStart + index])) {
      throw new Error(`ZIP local/central header mismatch: ${name}`);
    }
    const descriptor = Boolean(flags & DATA_DESCRIPTOR_FLAG);
    if (!descriptor &&
        (u32(local + 14) !== checksum || u32(local + 18) !== compressedLength || u32(local + 22) !== length)) {
      throw new Error(`ZIP local/central CRC or size mismatch: ${name}`);
    }
    checkZipExtraFields(view, localExtraStart, dataStart);
    if (method === 0 && compressedLength !== length) throw new Error(`ZIP stored size mismatch: ${name}`);
    entries.push({ name, method, checksum, length, local, dataStart, compressedLength, descriptor });
    position = next;
  }
  if (position !== endRecord) throw new Error("Invalid ZIP central directory size.");

  // Check descriptor bounds against the next local header, regardless of directory order.
  const localOrder = [...entries].sort((a, b) => a.local - b.local);
  for (const [index, entry] of localOrder.entries()) {
    const { dataStart, compressedLength, checksum, length, name, descriptor } = entry;
    const end = dataStart + compressedLength;
    const next = localOrder[index + 1]?.local ?? directory;
    if (end > next) throw new Error(`Overlapping ZIP local entries: ${name}`);
    if (!descriptor) continue;
    const matches = (offset: number) =>
      u32(offset) === checksum && u32(offset + 4) === compressedLength && u32(offset + 8) === length;
    const available = next - end;
    if (available >= 12 && matches(end)) continue;
    const signed = available >= 4 && u32(end) === DATA_DESCRIPTOR_SIGNATURE;
    if (signed && available >= 16 && matches(end + 4)) continue;
    if (available < (signed ? 16 : 12)) throw new Error(`Missing or truncated ZIP data descriptor: ${name}`);
    throw new Error(`ZIP data descriptor CRC or size mismatch: ${name}`);
  }

  const results: OfficeZipEntry[] = [];
  for (const { name, method, checksum, length, dataStart, compressedLength } of entries) {
    if (caps.include && !caps.include(name)) {
      results.push({ name, data: new Uint8Array(0), skipped: true });
      continue;
    }
    const compressed = bytes.subarray(dataStart, dataStart + compressedLength);
    let data = compressed;
    if (method === 8) {
      try {
        const { parts, stream } = zipInflater(compressed, checksum, length);
        data = await inflateBounded(parts, stream, length, "Inflated size exceeds the declared size.", new Uint8Array(length));
      } catch (error) {
        if (error instanceof UnsupportedDecompressionError) throw error;
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

const MAX_XML_LENGTH = 20 * 1024 * 1024; // UTF-16 code units
const MAX_XML_ELEMENTS = 200_000;
const MAX_XML_ATTRIBUTES = 256;
const MAX_XML_DEPTH = 256;
const XML_NS = "http://www.w3.org/XML/1998/namespace";
const XMLNS_NS = "http://www.w3.org/2000/xmlns/";
const MC = "http://schemas.openxmlformats.org/markup-compatibility/2006";

// XML 1.0 NameStartChar and NameChar, excluding the QName separator.
const xmlNameStart = "A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF" +
  "\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}";
const xmlNameChar = xmlNameStart + "0-9.\\u00B7\\u0300-\\u036F\\u203F-\\u2040-";
const ncName = "[" + xmlNameStart + "][" + xmlNameChar + "]*";
const qualifiedXmlName = new RegExp(ncName + "(?::" + ncName + ")?", "uy");
const piTarget = new RegExp("[:" + xmlNameStart + "][:" + xmlNameChar + "]*", "uy");
const xmlDeclaration = /<\?xml[ \t\r\n]+version[ \t\r\n]*=[ \t\r\n]*(?:"1\.0"|'1\.0')(?:[ \t\r\n]+encoding[ \t\r\n]*=[ \t\r\n]*(?:"[A-Za-z][A-Za-z0-9._-]*"|'[A-Za-z][A-Za-z0-9._-]*'))?(?:[ \t\r\n]+standalone[ \t\r\n]*=[ \t\r\n]*(?:"(?:yes|no)"|'(?:yes|no)'))?[ \t\r\n]*\?>/y;

function isXmlSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

function skipXmlSpace(xml: string, offset: number): number {
  while (isXmlSpace(xml.charCodeAt(offset))) offset++;
  return offset;
}

function isXmlCharacter(code: number): boolean {
  return isXmlSpace(code) || (code >= 0x20 && code <= 0xd7ff) ||
    (code >= 0xe000 && code <= 0xfffd) || (code >= 0x10000 && code <= 0x10ffff);
}

const xmlEntities = [
  ["amp;", 38], ["lt;", 60], ["gt;", 62], ["quot;", 34], ["apos;", 39],
] as const;

function xmlReference(xml: string, offset: number, end: number): { code: number; next: number } {
  if (xml.charCodeAt(offset) !== 35) {
    for (const [entity, code] of xmlEntities) {
      if (offset + entity.length <= end && xml.startsWith(entity, offset)) {
        return { code, next: offset + entity.length };
      }
    }
    throw new Error("Unknown or malformed Office XML entity reference.");
  }

  offset++;
  const hex = xml.charCodeAt(offset) === 120;
  if (hex) offset++;
  const start = offset;
  let code = 0;
  while (offset < end && xml.charCodeAt(offset) !== 59) {
    const char = xml.charCodeAt(offset++);
    let digit = char >= 48 && char <= 57 ? char - 48 : -1;
    if (hex && char >= 65 && char <= 70) digit = char - 55;
    if (hex && char >= 97 && char <= 102) digit = char - 87;
    if (digit < 0) throw new Error("Malformed Office XML character reference.");
    code = code * (hex ? 16 : 10) + digit;
    if (code > 0x10ffff) throw new Error("Invalid Office XML character reference.");
  }
  if (offset === start || offset >= end) throw new Error("Malformed Office XML character reference.");
  if (!isXmlCharacter(code)) throw new Error("Invalid Office XML character reference.");
  return { code, next: offset + 1 };
}

type XmlCodeSink = (code: number) => void;

function scanXmlText(
  xml: string, start: number, end: number,
  mode: "text" | "attribute" | "literal" | "outside", emit?: XmlCodeSink,
): void {
  for (let offset = start; offset < end;) {
    let code = xml.codePointAt(offset)!;
    if (mode === "outside" && !isXmlSpace(code)) throw new Error("Unexpected text outside the Office XML root.");
    if (mode === "attribute" && code === 60) throw new Error("Unescaped '<' in Office XML attribute.");
    if (mode === "text" && code === 93 && offset + 2 < end && xml.startsWith("]]>", offset)) {
      throw new Error("Unexpected CDATA terminator in Office XML text.");
    }
    if (code === 38 && (mode === "text" || mode === "attribute")) {
      const reference = xmlReference(xml, offset + 1, end);
      code = reference.code;
      offset = reference.next;
    } else {
      if (!isXmlCharacter(code)) throw new Error("Invalid character in Office XML.");
      offset += code > 0xffff ? 2 : 1;
      if (mode === "attribute" && isXmlSpace(code)) {
        if (code === 13 && offset < end && xml.charCodeAt(offset) === 10) offset++;
        code = 32;
      }
    }
    emit?.(code);
  }
}

function xmlAttributeValue(xml: string, start: number, end: number): string {
  const value = xml.slice(start, end);
  if (!/[&\r\n\t]/.test(value)) {
    scanXmlText(xml, start, end, "attribute");
    return value;
  }
  // Bound the temporary code point buffer even for attributes made entirely of references.
  const chunks: string[] = [];
  const codes: number[] = [];
  scanXmlText(xml, start, end, "attribute", (code) => {
    codes.push(code);
    if (codes.length === 4096) {
      chunks.push(String.fromCodePoint(...codes));
      codes.length = 0;
    }
  });
  chunks.push(String.fromCodePoint(...codes));
  return chunks.join("");
}

function readXmlName(xml: string, offset: number, pattern = qualifiedXmlName): string {
  pattern.lastIndex = offset;
  const name = pattern.exec(xml)?.[0];
  if (!name) throw new Error("Malformed Office XML name.");
  return name;
}

// Consume character data and markup that cannot introduce an element. The binary decoder
// uses the same rules on validated ranges, keeping text and CDATA in source order.
function scanXmlContent(xml: string, offset: number, inRoot: boolean, emit?: XmlCodeSink): number {
  if (xml.charCodeAt(offset) !== 60) {
    const tag = xml.indexOf("<", offset);
    const end = tag < 0 ? xml.length : tag;
    scanXmlText(xml, offset, end, inRoot ? "text" : "outside", emit);
    return end;
  }
  if (xml.startsWith("<!--", offset)) {
    const end = xml.indexOf("--", offset + 4);
    if (end < 0 || xml.charCodeAt(end + 2) !== 62) throw new Error("Malformed Office XML comment.");
    scanXmlText(xml, offset + 4, end, "literal");
    return end + 3;
  }
  if (xml.startsWith("<![CDATA[", offset)) {
    if (!inRoot) throw new Error("CDATA outside the Office XML root.");
    const end = xml.indexOf("]]>", offset + 9);
    if (end < 0) throw new Error("Unclosed Office XML CDATA.");
    scanXmlText(xml, offset + 9, end, "literal", emit);
    return end + 3;
  }
  if (xml.startsWith("<?", offset)) {
    const target = readXmlName(xml, offset + 2, piTarget);
    const start = offset + 2 + target.length;
    if (target.toLowerCase() === "xml") throw new Error("Malformed or misplaced Office XML declaration.");
    const end = xml.indexOf("?>", start);
    if (end < 0 || (end !== start && !isXmlSpace(xml.charCodeAt(start)))) {
      throw new Error("Malformed Office XML processing instruction.");
    }
    scanXmlText(xml, start, end, "literal");
    return end + 2;
  }
  return offset;
}

function qualifiedName(name: string): [prefix: string, local: string] {
  const colon = name.indexOf(":");
  return colon < 0 ? ["", name] : [name.slice(0, colon), name.slice(colon + 1)];
}

interface XmlElement {
  name: string;
  local: string;
  ns: string;
  attrs: Map<string, string>;
  qualifiedAttrs: Map<string, Map<string, string>>;
  parent: XmlElement | undefined;
  contentStart: number;
}

type XmlEvent =
  | { element: XmlElement; namespaces: ReadonlyMap<string, string>; closingAt?: undefined }
  | { element: XmlElement; closingAt: number };

function boundNamespace(namespaces: ReadonlyMap<string, string>, prefix: string): string {
  const namespace = namespaces.get(prefix);
  if (prefix && !namespace) throw new Error("Undeclared Office XML namespace prefix: " + prefix);
  return namespace ?? "";
}

function declareNamespace(namespaces: Map<string, string>, prefix: string, value: string): void {
  if (prefix === "xmlns" || value === XMLNS_NS || (prefix === "xml") !== (value === XML_NS) || (prefix && !value)) {
    throw new Error("Invalid Office XML namespace declaration: " + (prefix || "xmlns"));
  }
  namespaces.set(prefix, value);
}

function restoreNamespaces(namespaces: Map<string, string>, previous: Map<string, string | undefined>): void {
  for (const [prefix, old] of previous) {
    if (old === undefined) namespaces.delete(prefix);
    else namespaces.set(prefix, old);
  }
}

// Scope declarations by undoing changes to a single namespace map on close. Name
// resolution takes a direct lookup even at maximum depth.
function* xmlElements(xml: string, emit?: XmlCodeSink): Generator<XmlEvent> {
  if (xml.length > MAX_XML_LENGTH) throw new Error("Office XML exceeds the 20 MiB input length limit.");
  const namespaces = new Map([["xml", XML_NS]]);
  const stack: { element: XmlElement; previous: Map<string, string | undefined> }[] = [];
  let count = 0;
  let rootSeen = false;
  let offset = xml.charCodeAt(0) === 0xfeff ? 1 : 0;
  xmlDeclaration.lastIndex = offset;
  const declaration = xmlDeclaration.exec(xml);
  if (declaration) offset += declaration[0].length;

  while (offset < xml.length) {
    const frame = stack.at(-1);
    const next = scanXmlContent(xml, offset, Boolean(frame), emit);
    if (next !== offset) {
      offset = next;
      continue;
    }

    const tagStart = offset++;
    const closing = xml.charCodeAt(offset) === 47;
    if (closing) offset++;
    if (xml.charCodeAt(offset) === 33) throw new Error("Unsupported Office XML declaration.");
    if (!closing && ++count > MAX_XML_ELEMENTS) throw new Error("Office XML exceeds the 200000 element limit.");
    if (!closing && stack.length >= MAX_XML_DEPTH) throw new Error("Office XML exceeds the 256 element nesting limit.");
    const name = readXmlName(xml, offset);
    offset += name.length;
    if (closing) {
      offset = skipXmlSpace(xml, offset);
      if (xml.charCodeAt(offset++) !== 62) throw new Error("Malformed Office XML end tag: " + name);
      if (!frame || name !== frame.element.name) throw new Error("Mismatched Office XML end tag: " + name);
      yield { element: frame.element, closingAt: tagStart };
      stack.pop();
      restoreNamespaces(namespaces, frame.previous);
      continue;
    }

    if (!frame && rootSeen) throw new Error("Multiple Office XML root elements.");
    rootSeen = true;
    const rawAttrs = new Map<string, string>();
    const previous = new Map<string, string | undefined>();
    let selfClosing = false;
    for (;;) {
      const start = offset;
      offset = skipXmlSpace(xml, offset);
      if (xml.charCodeAt(offset) === 62) {
        offset++;
        break;
      }
      if (xml.startsWith("/>", offset)) {
        selfClosing = true;
        offset += 2;
        break;
      }
      if (offset === start) throw new Error("Malformed Office XML attributes: " + name);
      if (rawAttrs.size >= MAX_XML_ATTRIBUTES) throw new Error("Office XML exceeds the 256 attributes per element limit.");
      const key = readXmlName(xml, offset);
      if (rawAttrs.has(key)) throw new Error("Duplicate Office XML attribute: " + key);
      offset = skipXmlSpace(xml, offset + key.length);
      if (xml.charCodeAt(offset++) !== 61) throw new Error("Malformed Office XML attribute: " + key);
      offset = skipXmlSpace(xml, offset);
      const quote = xml[offset++];
      if (quote !== '"' && quote !== "'") throw new Error("Missing quotes on Office XML attribute: " + key);
      const end = xml.indexOf(quote, offset);
      if (end < 0) throw new Error("Unclosed Office XML attribute: " + key);
      const value = xmlAttributeValue(xml, offset, end);
      rawAttrs.set(key, value);
      offset = end + 1;
      if (key === "xmlns" || key.startsWith("xmlns:")) {
        const prefix = key === "xmlns" ? "" : key.slice(6);
        previous.set(prefix, namespaces.get(prefix));
        declareNamespace(namespaces, prefix, value);
      }
    }

    const [prefix, local] = qualifiedName(name);
    const ns = boundNamespace(namespaces, prefix);
    const attrs = new Map<string, string>();
    const qualifiedAttrs = new Map<string, Map<string, string>>();
    for (const [key, value] of rawAttrs) {
      const [attrPrefix, attr] = qualifiedName(key);
      if (key === "xmlns" || attrPrefix === "xmlns") continue;
      if (!attrPrefix) {
        attrs.set(attr, value);
        continue;
      }
      const attrNs = boundNamespace(namespaces, attrPrefix);
      let values = qualifiedAttrs.get(attrNs);
      if (!values) {
        values = new Map();
        qualifiedAttrs.set(attrNs, values);
      }
      if (values.has(attr)) throw new Error("Duplicate Office XML attribute: " + key);
      values.set(attr, value);
    }
    const element = { name, local, ns, attrs, qualifiedAttrs, parent: frame?.element, contentStart: offset };
    yield { element, namespaces };
    if (selfClosing) {
      yield { element, closingAt: offset };
      restoreNamespaces(namespaces, previous);
    } else {
      stack.push({ element, previous });
    }
  }
  const open = stack.at(-1);
  if (open) throw new Error("Unclosed Office XML tag: " + open.element.name);
  if (!rootSeen) throw new Error("Missing Office XML root element.");
}

function namespacedAttr(element: XmlElement, local: string, namespaces: readonly string[]): string | undefined {
  let result: string | undefined;
  for (const namespace of namespaces) {
    const value = element.qualifiedAttrs.get(namespace)?.get(local);
    if (value === undefined) continue;
    if (result !== undefined) throw new Error("Ambiguous Office XML attribute: " + local);
    result = value;
  }
  return result;
}

export interface FlatOpcBinaryPart {
  name: string;
  contentType: string;
  bytes: Uint8Array;
}

/** Recover binary parts from Word's Flat OPC XML, in package order. */
export function flatOpcBinaryParts(flatOpcXml: string): FlatOpcBinaryPart[] {
  const parts: { name: string; contentType: string; start: number; end: number; length: number }[] = [];
  let binary: { name: string; contentType: string; start: number; size: Base64Size } | undefined;
  let totalLength = 0;
  const names = new Set<string>();
  for (const { element, closingAt } of xmlElements(flatOpcXml, (code) => {
    if (binary && !isXmlSpace(code)) binary.size.add(code);
  })) {
    if (binary) {
      if (closingAt === undefined) throw new Error("Unexpected element inside Flat OPC binaryData.");
      const length = binary.size.finish();
      parts.push({ name: binary.name, contentType: binary.contentType, start: binary.start, end: closingAt, length });
      totalLength += length;
      binary = undefined;
      continue;
    }
    const part = element.parent;
    if (closingAt !== undefined || element.ns !== FLAT_OPC || element.local !== "binaryData" ||
        part?.ns !== FLAT_OPC || part.local !== "part") continue;
    const name = namespacedAttr(part, "name", [FLAT_OPC]);
    const contentType = namespacedAttr(part, "contentType", [FLAT_OPC]);
    if (!name || !contentType) throw new Error("Flat OPC binary part is missing its name or content type.");
    // OPC part names compare case-insensitively; two parts with one name leave the target ambiguous.
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("Flat OPC package has duplicate part names.");
    names.add(key);
    const remaining = MAX_INFLATED_BYTES - totalLength;
    const limit = Math.min(MAX_ENTRY_BYTES, remaining);
    const reason = limit === MAX_ENTRY_BYTES ? "Flat OPC binary part exceeds 50 MB." : "Flat OPC binary data exceeds 200 MB.";
    binary = { name, contentType, start: element.contentStart, size: new Base64Size(limit, reason) };
  }

  // Entire XML and aggregate output size are validated before any decoded part is allocated.
  return parts.map(({ name, contentType, start, end, length }) => {
    const bytes = new Uint8Array(length);
    const write = base64Writer(bytes);
    const emit = (code: number) => { if (!isXmlSpace(code)) write(code); };
    for (let offset = start; offset < end;) offset = scanXmlContent(flatOpcXml, offset, true, emit);
    return { name, contentType, bytes };
  });
}

/**
 * Resolve a relationship target, relative to the folder of the part that owns the relationship
 * (`ppt/slides` for `ppt/slides/slide1.xml`), to a package part name. Returns null for anything
 * that is not a plain path inside the package: a URL or scheme, a backslash, NUL, a query or
 * fragment, or `..` that climbs above the package root.
 */
export function resolvePartTarget(sourceFolder: string, target: string): string | null {
  if (/[?#]/.test(target)) return null;
  let path: string;
  try {
    path = decodeURIComponent(target);
  } catch {
    return null;
  }
  if (/^[a-z][a-z\d+.-]*:|^\/\/|[\\\0]/i.test(path)) return null;
  const segments = path.startsWith("/") ? [] : sourceFolder.split("/").filter(Boolean);
  for (const segment of path.split("/")) {
    if (segment === "..") {
      if (!segments.length) return null;
      segments.pop();
    } else if (segment && segment !== ".") {
      segments.push(segment);
    }
  }
  return segments.length ? segments.join("/") : null;
}

function resolveMediaTarget(target: string): string | null {
  const part = resolvePartTarget("ppt/slides", target);
  return part?.startsWith("ppt/media/") ? part : null;
}

// PowerPoint 2010 and later select a Choice that requires p14, so the reader does too.
const understoodSlideNamespaces: ReadonlySet<string> = new Set([
  ...PRESENTATION, ...DRAWING, ...OFFICE_RELS, "http://schemas.microsoft.com/office/powerpoint/2010/main",
]);

/**
 * Whether an `mc:Choice` that requires these namespace URIs is the branch a slide reader selects.
 * Shared with the PowerPoint adapter, which reads the same slide through the DOM.
 */
export function pptxChoiceIsUnderstood(namespaceUris: readonly (string | null)[]): boolean {
  return namespaceUris.length > 0 && namespaceUris.every((uri) => uri !== null && understoodSlideNamespaces.has(uri));
}

const WORD_MAIN = [TRANSITIONAL + "wordprocessingml/2006/main", STRICT + "wordprocessingml/main"];
const VML = "urn:schemas-microsoft-com:vml";
const understoodWordNamespaces: ReadonlySet<string> = new Set([
  ...WORD_MAIN, ...DRAWING, ...OFFICE_RELS,
  TRANSITIONAL + "drawingml/2006/wordprocessingDrawing", STRICT + "drawingml/wordprocessingDrawing",
  TRANSITIONAL + "drawingml/2006/picture", STRICT + "drawingml/picture",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
  "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas",
]);

function choiceIsUnderstood(
  element: XmlElement, namespaces: ReadonlyMap<string, string>, understoodNamespaces: ReadonlySet<string>,
): boolean {
  const requires = element.attrs.get("Requires") ?? "";
  let hasPrefix = false;
  let understood = true;
  for (const [prefix] of requires.matchAll(/[^ \t\r\n]+/g)) {
    hasPrefix = true;
    const namespace = boundNamespace(namespaces, prefix);
    if (!understoodNamespaces.has(namespace)) understood = false;
  }
  if (!hasPrefix) throw new Error("mc:Choice is missing its Requires prefixes.");
  return understood;
}

interface SlideFrame {
  active: boolean;
  visible?: XmlElement;
  alternate?: { sawChoice: boolean; sawFallback: boolean; selected: boolean };
}

// AlternateContent and its selected branch are transparent to the picture lookup.
function* effectiveSlideElements(
  slideXml: string, understoodNamespaces: ReadonlySet<string> = understoodSlideNamespaces,
): Generator<XmlElement> {
  const stack: SlideFrame[] = [];
  for (const event of xmlElements(slideXml, (code) => {
    if (!isXmlSpace(code) && stack.at(-1)?.alternate) {
      throw new Error("Unexpected text inside mc:AlternateContent.");
    }
  })) {
    if (event.closingAt !== undefined) {
      if (stack.pop()?.alternate?.sawChoice === false) throw new Error("mc:AlternateContent is missing mc:Choice.");
      continue;
    }
    const parent = stack.at(-1);
    if (parent && !parent.active) {
      stack.push({ active: false });
      continue;
    }
    const { element, namespaces } = event;
    const choice = element.ns === MC && element.local === "Choice";
    const fallback = element.ns === MC && element.local === "Fallback";
    const alternate = parent?.alternate;
    if (alternate) {
      if (alternate.sawFallback || (!choice && !fallback) || (fallback && !alternate.sawChoice)) {
        throw new Error("Invalid mc:AlternateContent branch order or content.");
      }
      const supported = fallback || choiceIsUnderstood(element, namespaces, understoodNamespaces);
      const active = !alternate.selected && supported;
      alternate.sawChoice ||= choice;
      alternate.sawFallback = fallback;
      alternate.selected ||= active;
      stack.push({ active, visible: parent?.visible });
    } else if (choice || fallback) {
      throw new Error("mc:Choice or mc:Fallback is outside mc:AlternateContent.");
    } else if (element.ns === MC && element.local === "AlternateContent") {
      stack.push({
        active: true, visible: parent?.visible, alternate: { sawChoice: false, sawFallback: false, selected: false },
      });
    } else {
      const visible = { ...element, parent: parent?.visible };
      stack.push({ active: true, visible });
      yield visible;
    }
  }
}

/** Resolve a slide picture's embedded image to its ZIP part name, including within groups. */
export function pptxSlidePictureMedia(slideXml: string, slideRelsXml: string, shapeId: string | number): string | null {
  const pictures = new Map<XmlElement, { id?: string; embed?: string }>();
  const id = String(shapeId);
  let sawShapeId = false;
  for (const element of effectiveSlideElements(slideXml)) {
    const { parent, ns, local } = element;
    if (local === "cNvPr" && PRESENTATION.includes(ns) && element.attrs.get("id") === id) {
      if (sawShapeId) throw new Error(`Duplicate shape ID in effective slide XML: ${shapeId}`);
      sawShapeId = true;
    }
    const picture = parent?.parent;
    if (!parent || picture?.local !== "pic" || !PRESENTATION.includes(picture.ns) ||
        !PRESENTATION.includes(parent.ns)) continue;
    const data = pictures.get(picture) ?? {};
    if (local === "cNvPr" && PRESENTATION.includes(ns) && parent.local === "nvPicPr") {
      if ("id" in data) throw new Error("Multiple effective cNvPr elements on a slide picture.");
      data.id = element.attrs.get("id");
    } else if (local === "blip" && DRAWING.includes(ns) && parent.local === "blipFill") {
      if ("embed" in data) throw new Error("Multiple effective blip elements on a slide picture.");
      data.embed = namespacedAttr(element, "embed", OFFICE_RELS);
    } else continue;
    pictures.set(picture, data);
  }
  let relationshipId: string | undefined;
  for (const picture of pictures.values()) {
    if (picture.id === id) relationshipId = picture.embed;
  }

  let match: XmlElement | undefined;
  for (const { element, closingAt } of xmlElements(slideRelsXml)) {
    if (!relationshipId || closingAt !== undefined || element.ns !== PACKAGE_RELS || element.local !== "Relationship" ||
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

export interface OfficeRelationship {
  id: string;
  type: string;
  target: string;
  external: boolean;
}

/** Read a relationships part (`*.rels`). Refuses duplicate relationship IDs. */
export function officeRelationships(relsXml: string): Map<string, OfficeRelationship> {
  const relationships = new Map<string, OfficeRelationship>();
  for (const { element, closingAt } of xmlElements(relsXml)) {
    if (closingAt !== undefined || element.ns !== PACKAGE_RELS || element.local !== "Relationship" ||
        element.parent?.ns !== PACKAGE_RELS || element.parent.local !== "Relationships") continue;
    const id = element.attrs.get("Id");
    const type = element.attrs.get("Type");
    const target = element.attrs.get("Target");
    if (!id || !type || target === undefined) throw new Error("Office relationship is missing its Id, Type or Target.");
    if (relationships.has(id)) throw new Error(`Duplicate Office relationship ID: ${id}`);
    const mode = element.attrs.get("TargetMode");
    relationships.set(id, { id, type, target, external: mode !== undefined && mode !== "Internal" });
  }
  return relationships;
}

/** True when a relationship type is the given OOXML relationship (transitional or strict). */
export function isOfficeRelationshipType(type: string, name: "officeDocument" | "slide" | "image"): boolean {
  return OFFICE_RELS.some((namespace) => type === `${namespace}/${name}`);
}

export type OfficeMainPartKind = "word" | "powerpoint" | "other";

/** Identify a main part by its root element: `w:document` or `p:presentation`. */
export function officeMainPartKind(xml: string): OfficeMainPartKind {
  for (const { element } of xmlElements(xml)) {
    if (element.local === "document" && WORD_MAIN.includes(element.ns)) return "word";
    if (element.local === "presentation" && PRESENTATION.includes(element.ns)) return "powerpoint";
    return "other";
  }
  return "other";
}

/** Relationship IDs of a presentation's slides, in slide order (`p:sldIdLst`). */
export function pptxSlideRelationshipIds(presentationXml: string): string[] {
  const ids: string[] = [];
  for (const { element, closingAt } of xmlElements(presentationXml)) {
    const list = element.parent;
    if (closingAt !== undefined || element.local !== "sldId" || !PRESENTATION.includes(element.ns) ||
        list?.local !== "sldIdLst" || !PRESENTATION.includes(list.ns)) continue;
    const id = namespacedAttr(element, "id", OFFICE_RELS);
    if (!id) throw new Error("Presentation slide entry is missing its relationship ID.");
    ids.push(id);
  }
  return ids;
}

/**
 * Relationship IDs of every picture on a slide (`p:pic/p:blipFill/a:blip`), in drawing order,
 * including pictures inside groups and the chosen branch of `mc:AlternateContent`.
 */
export function pptxSlidePictureRelationshipIds(slideXml: string): string[] {
  const ids: string[] = [];
  for (const element of effectiveSlideElements(slideXml)) {
    const fill = element.parent;
    const picture = fill?.parent;
    if (element.local !== "blip" || !DRAWING.includes(element.ns) || fill?.local !== "blipFill" ||
        !PRESENTATION.includes(fill.ns) || picture?.local !== "pic" || !PRESENTATION.includes(picture.ns)) continue;
    const id = namespacedAttr(element, "embed", OFFICE_RELS);
    if (id) ids.push(id);
  }
  return ids;
}

// Office's clipboard drawing (GVML): DrawingML pictures, usually inside a locked canvas.
const understoodDrawingNamespaces: ReadonlySet<string> = new Set([
  ...DRAWING, ...OFFICE_RELS,
  TRANSITIONAL + "drawingml/2006/picture", STRICT + "drawingml/picture",
  TRANSITIONAL + "drawingml/2006/lockedCanvas", STRICT + "drawingml/lockedCanvas",
]);

/**
 * Relationship IDs of every embedded picture (`a:blip r:embed`) in a DrawingML part, in document
 * order and once per occurrence: two pictures that share one image part are two entries. Only the
 * chosen branch of `mc:AlternateContent` is read, so a picture is not reported twice.
 */
export function drawingPictureRelationshipIds(drawingXml: string): string[] {
  const ids: string[] = [];
  for (const element of effectiveSlideElements(drawingXml, understoodDrawingNamespaces)) {
    if (element.local !== "blip" || !DRAWING.includes(element.ns)) continue;
    const id = namespacedAttr(element, "embed", OFFICE_RELS);
    if (id) ids.push(id);
  }
  return ids;
}

export interface WordPictureReference {
  relationshipId: string;
  /** 1-based count of paragraphs started before or at the picture, in body order. */
  paragraph: number;
}

/**
 * Every embedded picture in a Word main document, in body order: DrawingML `a:blip r:embed` and
 * VML `v:imagedata r:id` (embedded-object previews). Only the chosen branch of
 * `mc:AlternateContent` is read, so a picture is not reported twice through its fallback.
 */
export function docxPictureReferences(documentXml: string): WordPictureReference[] {
  const references: WordPictureReference[] = [];
  let paragraph = 0;
  for (const element of effectiveSlideElements(documentXml, understoodWordNamespaces)) {
    if (element.local === "p" && WORD_MAIN.includes(element.ns)) {
      paragraph++;
      continue;
    }
    let id: string | undefined;
    if (element.local === "blip" && DRAWING.includes(element.ns)) id = namespacedAttr(element, "embed", OFFICE_RELS);
    else if (element.local === "imagedata" && element.ns === VML) id = namespacedAttr(element, "id", OFFICE_RELS);
    if (id) references.push({ relationshipId: id, paragraph: Math.max(paragraph, 1) });
  }
  return references;
}

export function folderOf(part: string): string {
  const slash = part.lastIndexOf("/");
  return slash < 0 ? "" : part.slice(0, slash);
}

export function relsPartFor(part: string): string {
  const slash = part.lastIndexOf("/");
  return `${part.slice(0, slash + 1)}_rels/${part.slice(slash + 1)}.rels`;
}
