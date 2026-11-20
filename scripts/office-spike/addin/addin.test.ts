import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32 } from "../png.mjs";
import { extractBinaryParts, findSlidePictureMedia, readZip } from "./zip.js";

const here = dirname(fileURLToPath(import.meta.url));
const carriers = join(here, "..", "..", "..", "packages", "fixtures", "office", "carriers");
const fixture = readFileSync(join(carriers, "png-itxt.png"));
const replacement = readFileSync(join(here, "test-replacement.png"));
const manifest: { file: string; sha256: string }[] = JSON.parse(readFileSync(join(carriers, "manifest.json"), "utf8"));
const hash = manifest.find(({ file }) => file === "png-itxt.png")!.sha256;
const mb = 1024 * 1024;

type Entry = {
  name: string;
  data: Buffer;
  deflate?: boolean;
  descriptor?: boolean;
  declaredLength?: number;
  extra?: Buffer;
};

function makeZip(entries: Entry[]) {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, data, deflate, descriptor, declaredLength = data.length, extra = Buffer.alloc(0) } of entries) {
    const filename = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(descriptor ? 8 : 0, 6);
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    if (!descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(declaredLength, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(extra.length, 28);
    const directoryEntry = Buffer.alloc(46);
    directoryEntry.writeUInt32LE(0x02014b50);
    directoryEntry.writeUInt16LE(20, 4);
    directoryEntry.writeUInt16LE(20, 6);
    directoryEntry.writeUInt16LE(descriptor ? 8 : 0, 8);
    directoryEntry.writeUInt16LE(deflate ? 8 : 0, 10);
    directoryEntry.writeUInt32LE(checksum, 16);
    directoryEntry.writeUInt32LE(body.length, 20);
    directoryEntry.writeUInt32LE(declaredLength, 24);
    directoryEntry.writeUInt16LE(filename.length, 28);
    directoryEntry.writeUInt16LE(extra.length, 30);
    directoryEntry.writeUInt32LE(offset, 42);
    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(checksum, 4);
      trailer.writeUInt32LE(body.length, 8);
      trailer.writeUInt32LE(declaredLength, 12);
    }
    locals.push(local, filename, extra, body, trailer);
    central.push(directoryEntry, filename, extra);
    offset += local.length + filename.length + extra.length + body.length + trailer.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

async function sha256(bytes: Uint8Array<ArrayBufferLike>) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes))).toString("hex");
}

const OPC = "http://schemas.microsoft.com/office/2006/xmlPackage";
const P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PR = "http://schemas.openxmlformats.org/package/2006/relationships";
const W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

const slideXml = `<?xml version="1.0"?>
<p:sld xmlns:p="${P}" xmlns:a="${A}" xmlns:r="${R}">
  <p:cSld><p:spTree>
    <p:pic>
      <p:nvPicPr><p:cNvPr name='Picture > 1' id = '3' /></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
    </p:pic>
    <p:sp>
      <p:nvSpPr><p:cNvPr id="4" name="Rectangle"/></p:nvSpPr>
      <p:spPr><a:blipFill><a:blip r:embed="rId2"/></a:blipFill></p:spPr>
    </p:sp>
    <p:grpSp>
      <p:nvGrpSpPr><p:cNvPr id="5" name="Group"/></p:nvGrpSpPr>
      <other:pic xmlns:other="${P}">
        <other:nvPicPr><other:cNvPr id="6" name="Grouped picture"/></other:nvPicPr>
        <other:blipFill><a:blip xmlns:rel="${R}" rel:embed="rId3"/></other:blipFill>
      </other:pic>
    </p:grpSp>
    <p:pic>
      <p:nvPicPr><p:cNvPr id="7" name="External picture"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="rId4"/></p:blipFill>
    </p:pic>
  </p:spTree></p:cSld>
</p:sld>`;
const relsXml = `<Relationships xmlns="${PR}">
  <Relationship Type="${R}/image" Target="../media/image1.png" Id="rId2"/>
  <Relationship Id = 'rId3' Target='/ppt/media/group%20%26%20child.png' Type='${R}/image' />
  <Relationship Id="rId4" Target="../media/image1.png" TargetMode="External" Type="${R}/image"/>
</Relationships>`;

describe("browser Office ZIP reader", () => {
  it("reads stored and deflated DOCX parts and verifies the carrier fixture hash", async () => {
    const documentXml = `<w:document xmlns:w="${W}"><w:body><w:p/></w:body></w:document>`;
    const docx = makeZip([
      { name: "word/document.xml", data: Buffer.from(documentXml), deflate: true, descriptor: true },
      { name: "word/media/image1.png", data: fixture },
    ]);
    const entries = await readZip(docx);
    expect(Buffer.from(entries[0].data).toString("utf8")).toBe(documentXml);
    expect(entries.map(({ name }) => name)).toEqual(["word/document.xml", "word/media/image1.png"]);
    expect(await sha256(entries[1].data)).toBe(hash);
    expect(replacement.equals(fixture)).toBe(true);
    expect(await sha256(replacement)).toBe(hash);
  });

  it("follows the selected shape to deflated media in a PPTX", async () => {
    const pptx = makeZip([
      { name: "ppt/slides/slide1.xml", data: Buffer.from(slideXml) },
      { name: "ppt/slides/_rels/slide1.xml.rels", data: Buffer.from(relsXml), deflate: true },
      { name: "ppt/media/image1.png", data: fixture, deflate: true },
    ]);
    const entries = new Map((await readZip(pptx)).map(({ name, data }) => [name, data]));
    const part = findSlidePictureMedia(
      new TextDecoder().decode(entries.get("ppt/slides/slide1.xml")),
      new TextDecoder().decode(entries.get("ppt/slides/_rels/slide1.xml.rels")),
      "3",
    );
    expect(part).toBe("ppt/media/image1.png");
    expect(await sha256(entries.get(part!)!)).toBe(hash);
  });

  it("refuses an entry with changed bytes and an intact directory", async () => {
    const archive = makeZip([{ name: "pic", data: fixture }]);
    archive[30 + Buffer.byteLength("pic")] ^= 1;
    await expect(readZip(archive)).rejects.toThrow(/CRC mismatch/);
  });

  it("refuses ZIP64 sentinels, locator and extra fields", async () => {
    const archive = makeZip([{ name: "x", data: Buffer.alloc(0) }]);
    const end = archive.subarray(-22);
    end.writeUInt16LE(0xffff, 10);
    await expect(readZip(archive)).rejects.toThrow(/ZIP64/);
    end.writeUInt16LE(1, 10);
    const locator = Buffer.alloc(20);
    locator.writeUInt32LE(0x07064b50);
    await expect(readZip(Buffer.concat([archive.subarray(0, -22), locator, end]))).rejects.toThrow(/ZIP64/);
    const extra = makeZip([{ name: "x", data: Buffer.alloc(0), extra: Buffer.from([1, 0, 0, 0]) }]);
    await expect(readZip(extra)).rejects.toThrow(/ZIP64/);
    archive.writeUInt32LE(0xffffffff, 22);
    await expect(readZip(archive)).rejects.toThrow(/ZIP64/);
  });

  it("refuses encryption in either header", async () => {
    const archive = makeZip([{ name: "x", data: Buffer.alloc(0) }]);
    const directoryOffset = archive.readUInt32LE(archive.length - 6);
    archive.writeUInt16LE(0x40, directoryOffset + 8);
    await expect(readZip(archive)).rejects.toThrow(/Encrypted ZIP/);
    archive.writeUInt16LE(0, directoryOffset + 8);
    archive.writeUInt16LE(1, 6);
    await expect(readZip(archive)).rejects.toThrow(/Encrypted ZIP/);
  });

  it("refuses 2001 entries and declared per-entry and aggregate overruns", async () => {
    const payload = Buffer.alloc(0);
    const tooMany = makeZip(Array.from({ length: 2001 }, (_, i) => ({ name: String(i), data: payload })));
    await expect(readZip(tooMany)).rejects.toThrow(/2000 entries/);
    const oversized = makeZip([{ name: "x", data: payload, deflate: true, declaredLength: 50 * mb + 1 }]);
    await expect(readZip(oversized)).rejects.toThrow(/50 MB/);
    const aggregate = makeZip(Array.from({ length: 5 }, (_, i) => ({
      name: String(i), data: payload, deflate: true, declaredLength: 50 * mb,
    })));
    await expect(readZip(aggregate)).rejects.toThrow(/200 MB/);
  });

  it("refuses deflate data whose actual expansion exceeds its declared size", async () => {
    const archive = makeZip([{ name: "x", data: Buffer.alloc(1024), deflate: true, declaredLength: 16 }]);
    await expect(readZip(archive)).rejects.toThrow(/inflated size exceeds declared size/);
  });
});

describe("Office package XML", () => {
  it("matches picture IDs, including a picture nested inside a group", () => {
    expect(findSlidePictureMedia(slideXml, relsXml, 3)).toBe("ppt/media/image1.png");
    expect(findSlidePictureMedia(slideXml, relsXml, 6)).toBe("ppt/media/group & child.png");
    expect(findSlidePictureMedia(slideXml, relsXml, 4)).toBeNull();
    expect(findSlidePictureMedia(slideXml, relsXml, 5)).toBeNull();
    expect(findSlidePictureMedia(slideXml, relsXml, 7)).toBeNull();
    expect(findSlidePictureMedia(slideXml, relsXml, 8)).toBeNull();
  });

  it("extracts each binary part with reordered attributes and line-wrapped base64", async () => {
    const wrapped = fixture.toString("base64").match(/.{1,76}/g)!.join("\r\n  ");
    const xml = `<?xml version='1.0'?>
<pkg:package xmlns:pkg="${OPC}" xmlns:alias="${OPC}">
  <!-- <pkg:part><pkg:binaryData>ignored</pkg:binaryData></pkg:part> -->
  <alias:part alias:contentType = 'image/png'
     pkg:name="/word/media/image&amp;1.png" pkg:compression="store">
    <pkg:binaryData>
    ${wrapped}
    </pkg:binaryData>
  </alias:part>
  <pkg:part pkg:name='/word/media/image2.bin' pkg:contentType='application/octet-stream'>
    <pkg:binaryData> Q U
     J D </pkg:binaryData>
  </pkg:part>
  <pkg:part pkg:name="/word/document.xml" pkg:contentType="application/xml">
    <pkg:xmlData><w:document xmlns:w="${W}"/></pkg:xmlData>
  </pkg:part>
</pkg:package>`;
    const parts = extractBinaryParts(xml);
    expect(parts.map(({ name, contentType }) => ({ name, contentType }))).toEqual([
      { name: "/word/media/image&1.png", contentType: "image/png" },
      { name: "/word/media/image2.bin", contentType: "application/octet-stream" },
    ]);
    expect(await sha256(parts[0].bytes)).toBe(hash);
    expect(Buffer.from(parts[1].bytes).toString("ascii")).toBe("ABC");
  });
});
