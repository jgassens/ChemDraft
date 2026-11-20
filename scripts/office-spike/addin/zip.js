const MAX_ENTRIES = 2000;
const MAX_ENTRY = 50 * 1024 * 1024;
const MAX_INFLATED = 200 * 1024 * 1024;
const ZIP64_SIZE = 0xffffffff;
const ENCRYPTED = 0x2041;
const utf8 = new TextDecoder();

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) {
    crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return crc;
});

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}

function checkExtra(view, start, end) {
  while (start < end) {
    if (start + 4 > end) throw new Error("Truncated ZIP extra field");
    if (view.getUint16(start, true) === 1) throw new Error("ZIP64 is unsupported");
    start += 4 + view.getUint16(start + 2, true);
  }
  if (start !== end) throw new Error("Truncated ZIP extra field");
}

async function inflateRaw(compressed, length, name) {
  if (typeof DecompressionStream !== "function") {
    throw new Error("This webview does not support DecompressionStream");
  }
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const bytes = new Uint8Array(length);
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value.byteLength > length - offset) {
        await reader.cancel();
        throw new Error(`ZIP inflated size exceeds declared size: ${name}`);
      }
      bytes.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== length) throw new Error(`ZIP inflated size mismatch: ${name}`);
  return bytes;
}

/** Read a classic single-disk ZIP, validating every entry before returning any data. */
export async function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (offset) => view.getUint16(offset, true);
  const u32 = (offset) => view.getUint32(offset, true);
  let eocd = bytes.byteLength - 22;
  const first = Math.max(0, eocd - 0xffff);
  while (eocd >= first) {
    if (u32(eocd) === 0x06054b50 && eocd + 22 + u16(eocd + 20) === bytes.byteLength) break;
    eocd--;
  }
  if (eocd < first) throw new Error("Missing or truncated ZIP central directory");

  const count = u16(eocd + 10);
  const size = u32(eocd + 12);
  const directory = u32(eocd + 16);
  if (count === 0xffff || size === ZIP64_SIZE || directory === ZIP64_SIZE ||
      (eocd >= 20 && u32(eocd - 20) === 0x07064b50)) {
    throw new Error("ZIP64 is unsupported");
  }
  if (u16(eocd + 4) || u16(eocd + 6) || u16(eocd + 8) !== count) {
    throw new Error("Multi-disk ZIP is unsupported");
  }
  if (count > MAX_ENTRIES) throw new Error("ZIP exceeds 2000 entries");
  const end = directory + size;
  if (end !== eocd) throw new Error("Invalid ZIP central directory bounds");

  const entries = [];
  const names = new Set();
  let totalLength = 0;
  let position = directory;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || u32(position) !== 0x02014b50) {
      throw new Error("Truncated ZIP central directory entry");
    }
    const flags = u16(position + 8);
    const method = u16(position + 10);
    const crc = u32(position + 16);
    const compressedLength = u32(position + 20);
    const length = u32(position + 24);
    const nameLength = u16(position + 28);
    const extraLength = u16(position + 30);
    const local = u32(position + 42);
    const nameStart = position + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + u16(position + 32);
    if (next > end) throw new Error("Truncated ZIP central directory entry");
    if (flags & ENCRYPTED) throw new Error("Encrypted ZIP is unsupported");
    if ([compressedLength, length, local].includes(ZIP64_SIZE)) throw new Error("ZIP64 is unsupported");
    if (u16(position + 34)) throw new Error("Multi-disk ZIP is unsupported");
    if (method !== 0 && method !== 8) throw new Error(`Unsupported ZIP compression method ${method}`);
    checkExtra(view, extraStart, extraStart + extraLength);
    if (length > MAX_ENTRY) throw new Error("ZIP entry exceeds 50 MB inflated");
    totalLength += length;
    if (totalLength > MAX_INFLATED) throw new Error("ZIP exceeds 200 MB inflated");

    const nameBytes = bytes.subarray(nameStart, extraStart);
    const name = utf8.decode(nameBytes);
    if (!name || names.has(name)) throw new Error(`Empty or duplicate ZIP entry name: ${name}`);
    names.add(name);
    if (local + 30 > directory || u32(local) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header: ${name}`);
    }
    const localFlags = u16(local + 6);
    const localNameStart = local + 30;
    const localExtraStart = localNameStart + u16(local + 26);
    const dataStart = localExtraStart + u16(local + 28);
    if (localFlags & ENCRYPTED) throw new Error("Encrypted ZIP is unsupported");
    if (u32(local + 18) === ZIP64_SIZE || u32(local + 22) === ZIP64_SIZE) {
      throw new Error("ZIP64 is unsupported");
    }
    if (dataStart + compressedLength > directory) throw new Error(`Truncated ZIP data: ${name}`);
    if (localFlags !== flags || u16(local + 8) !== method ||
        localExtraStart - localNameStart !== nameLength ||
        nameBytes.some((byte, i) => byte !== bytes[localNameStart + i])) {
      throw new Error(`ZIP local/central header mismatch: ${name}`);
    }
    // With a data descriptor, the central directory supplies CRC and sizes.
    if (!(flags & 8) &&
        (u32(local + 14) !== crc || u32(local + 18) !== compressedLength || u32(local + 22) !== length)) {
      throw new Error(`ZIP local/central CRC or size mismatch: ${name}`);
    }
    checkExtra(view, localExtraStart, dataStart);
    if (method === 0 && compressedLength !== length) throw new Error(`ZIP stored size mismatch: ${name}`);
    entries.push({ name, method, crc, length, dataStart, compressedLength });
    position = next;
  }
  if (position !== end) throw new Error("Invalid ZIP central directory size");

  const results = [];
  for (const { name, method, crc, length, dataStart, compressedLength } of entries) {
    const compressed = bytes.subarray(dataStart, dataStart + compressedLength);
    const data = method === 0 ? compressed : await inflateRaw(compressed, length, name);
    if (crc32(data) !== crc) throw new Error(`ZIP CRC mismatch: ${name}`);
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

function xmlUnescape(text) {
  const predefined = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[\da-fA-F]+);/g, (_, code) => {
    if (code.startsWith("#x")) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
    if (code.startsWith("#")) return String.fromCodePoint(Number(code.slice(1)));
    return predefined[code];
  });
}

function qualifiedName(name) {
  const colon = name.indexOf(":");
  return colon < 0 ? ["", name] : [name.slice(0, colon), name.slice(colon + 1)];
}

// Read only tags and attributes. Track the containing element and scoped namespaces
// so group children and similarly named tags in other namespaces stay distinct.
function* xmlElements(xml) {
  const tags = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<(\/?)([^\s/>!?]+)((?:[^<>"']|"[^"]*"|'[^']*')*)>/g;
  let parent;
  for (const token of xml.matchAll(tags)) {
    const [markup, closing, name, attributes] = token;
    if (!name) continue;
    if (closing) {
      if (name !== parent?.name || attributes.trim()) throw new Error(`Mismatched XML end tag: ${name}`);
      yield { element: parent, closingAt: token.index };
      parent = parent.parent;
      continue;
    }
    const namespaces = Object.create(parent?.namespaces ?? null);
    const attrs = new Map();
    for (const [, key, doubleQuoted, singleQuoted] of attributes.matchAll(/([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const value = xmlUnescape(doubleQuoted ?? singleQuoted);
      if (key === "xmlns") namespaces[""] = value;
      else if (key.startsWith("xmlns:")) namespaces[key.slice(6)] = value;
      else attrs.set(key, value);
    }
    const [prefix, local] = qualifiedName(name);
    const element = { name, local, ns: namespaces[prefix], namespaces, attrs, parent,
      contentStart: token.index + markup.length };
    yield { element };
    if (attributes.endsWith("/")) yield { element, closingAt: element.contentStart };
    else parent = element;
  }
  if (parent) throw new Error(`Unclosed XML tag: ${parent.name}`);
}

function namespacedAttr(element, local, namespaces) {
  for (const [key, value] of element.attrs) {
    const [prefix, attr] = qualifiedName(key);
    if (attr === local && prefix && namespaces.includes(element.namespaces[prefix])) return value;
  }
  return undefined;
}

export function decodeBase64(text) {
  const binary = atob(text.replace(/[\t\n\r ]/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function extractBinaryParts(xml) {
  const parts = [];
  for (const { element, closingAt } of xmlElements(xml)) {
    const part = element.parent;
    if (closingAt === undefined || element.ns !== FLAT_OPC || element.local !== "binaryData" ||
        part?.ns !== FLAT_OPC || part.local !== "part") continue;
    const name = namespacedAttr(part, "name", [FLAT_OPC]);
    const contentType = namespacedAttr(part, "contentType", [FLAT_OPC]);
    if (!name || !contentType) throw new Error("Flat OPC binary part is missing its name or content type");
    const bytes = decodeBase64(xml.slice(element.contentStart, closingAt));
    parts.push({ name, contentType, bytes });
  }
  return parts;
}

function resolveMediaTarget(target) {
  const path = decodeURIComponent(target);
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
  return segments[0] === "ppt" && segments[1] === "media" && segments.length > 2
    ? segments.join("/") : null;
}

/** Resolve an embedded p:pic, including a picture nested inside a group. */
export function findSlidePictureMedia(slideXml, relsXml, shapeId) {
  const pictures = new Map();
  for (const { element, closingAt } of xmlElements(slideXml)) {
    if (closingAt !== undefined) continue;
    const { parent, ns, local } = element;
    const picture = parent?.parent;
    if (picture?.local !== "pic" || !PRESENTATION.includes(picture.ns) ||
        !PRESENTATION.includes(parent.ns)) continue;
    if (local === "cNvPr" && PRESENTATION.includes(ns) && parent.local === "nvPicPr") {
      const data = pictures.get(picture) ?? {};
      data.id = element.attrs.get("id");
      pictures.set(picture, data);
    } else if (local === "blip" && DRAWING.includes(ns) && parent.local === "blipFill") {
      const data = pictures.get(picture) ?? {};
      data.embed = namespacedAttr(element, "embed", OFFICE_RELS);
      pictures.set(picture, data);
    }
  }
  const matches = [...pictures.values()].filter((picture) => picture.id === String(shapeId));
  if (matches.length > 1) throw new Error(`Duplicate picture ID in slide XML: ${shapeId}`);
  const relationshipId = matches[0]?.embed;
  if (!relationshipId) return null;
  for (const { element, closingAt } of xmlElements(relsXml)) {
    if (closingAt !== undefined || element.ns !== PACKAGE_RELS ||
        element.local !== "Relationship" || element.attrs.get("Id") !== relationshipId) continue;
    const type = element.attrs.get("Type");
    const mode = element.attrs.get("TargetMode");
    const target = element.attrs.get("Target");
    if (!OFFICE_RELS.some((namespace) => type === namespace + "/image") ||
        (mode && mode !== "Internal") || !target) return null;
    return resolveMediaTarget(target);
  }
  return null;
}
