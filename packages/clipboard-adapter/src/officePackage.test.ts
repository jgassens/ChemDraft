import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { flatOpcBinaryParts, pptxSlidePictureMedia, readZip } from "./index";

interface TestEntry {
  name: string;
  data: Buffer;
  deflate?: boolean;
  descriptor?: boolean;
  declaredLength?: number;
  checksum?: number;
  extra?: Buffer;
}

function makeZip(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const { name, data, deflate, descriptor, declaredLength = data.length,
    checksum = crc32(data), extra = Buffer.alloc(0) } of entries) {
    const filename = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const flags = descriptor ? 8 : 0;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    if (!descriptor) {
      local.writeUInt32LE(checksum, 14);
      local.writeUInt32LE(body.length, 18);
      local.writeUInt32LE(declaredLength, 22);
    }
    local.writeUInt16LE(filename.length, 26);
    local.writeUInt16LE(extra.length, 28);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(flags, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(declaredLength, 24);
    record.writeUInt16LE(filename.length, 28);
    record.writeUInt16LE(extra.length, 30);
    record.writeUInt32LE(offset, 42);

    const trailer = Buffer.alloc(descriptor ? 16 : 0);
    if (descriptor) {
      trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(checksum, 4);
      trailer.writeUInt32LE(body.length, 8);
      trailer.writeUInt32LE(declaredLength, 12);
    }
    locals.push(local, filename, extra, body, trailer);
    records.push(record, filename, extra);
    offset += local.length + filename.length + extra.length + body.length + trailer.length;
  }

  const directory = Buffer.concat(records);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

describe("Office ZIP reader", () => {
  const data = Buffer.from("A package part with UTF-8 text ° and arbitrary bytes.\0");
  const entry = { name: "ppt/media/image.png", data };

  it("reads stored and deflated entries, using the central sizes for data descriptors", async () => {
    const entries = [entry, { ...entry, name: "ppt/slides/slide1.xml", deflate: true },
      { ...entry, name: "ppt/slides/_rels/slide1.xml.rels", deflate: true, descriptor: true }];
    const archive = Buffer.concat([Buffer.of(0), makeZip(entries)]).subarray(1);
    expect((await readZip(archive)).map(({ name, data }) => ({ name, data: Buffer.from(data) }))).toEqual(
      entries.map(({ name, data }) => ({ name, data })),
    );
  });

  it("can inflate on early Node 20 builds without the deflate-raw stream format", async () => {
    class GzipOnlyStream extends DecompressionStream {
      constructor(format: CompressionFormat) {
        if (format === "deflate-raw") throw new TypeError("Unsupported format");
        super(format);
      }
    }
    vi.stubGlobal("DecompressionStream", GzipOnlyStream);
    try {
      const [result] = await readZip(makeZip([{ ...entry, deflate: true }]));
      expect(Buffer.from(result.data)).toEqual(data);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects corrupt CRCs both for stored and deflated data", async () => {
    const checksum = (crc32(data) ^ 1) >>> 0;
    await expect(readZip(makeZip([{ ...entry, checksum }]))).rejects.toThrow(/CRC mismatch/);
    await expect(readZip(makeZip([{ ...entry, checksum, deflate: true }]))).rejects.toThrow(/CRC mismatch/);
  });

  it("refuses ZIP64 markers, encrypted entries and multi-disk archives", async () => {
    const zip64 = makeZip([{ ...entry, extra: Buffer.of(1, 0, 0, 0) }]);
    await expect(readZip(zip64)).rejects.toThrow(/ZIP64/);
    const zip64End = makeZip([entry]);
    zip64End.writeUInt16LE(0xffff, zip64End.length - 22 + 10);
    await expect(readZip(zip64End)).rejects.toThrow(/ZIP64/);

    const encrypted = makeZip([entry]);
    const directory = encrypted.readUInt32LE(encrypted.length - 6);
    encrypted.writeUInt16LE(1, directory + 8);
    await expect(readZip(encrypted)).rejects.toThrow(/encrypted/i);

    const multiDisk = makeZip([entry]);
    multiDisk.writeUInt16LE(1, multiDisk.length - 22 + 4);
    await expect(readZip(multiDisk)).rejects.toThrow(/multi-disk/i);
  });

  it("caps entry count, per-entry size and total size before inflating entries", async () => {
    const mib = 1024 * 1024;
    const tooMany = makeZip(Array.from({ length: 2001 }, (_, index) => ({ name: String(index), data: Buffer.alloc(0) })));
    await expect(readZip(tooMany)).rejects.toThrow(/2000 entries/);
    await expect(readZip(makeZip([{ ...entry, deflate: true, declaredLength: 50 * mib + 1 }]))).rejects.toThrow(/50 MB/);
    const tooBig = makeZip(Array.from({ length: 5 }, (_, index) => ({
      ...entry, name: String(index), deflate: true, declaredLength: 50 * mib,
    })));
    await expect(readZip(tooBig)).rejects.toThrow(/200 MB/);
  });

  it("rejects both longer and shorter inflated results than advertised", async () => {
    const deflated = { ...entry, deflate: true, descriptor: true };
    await expect(readZip(makeZip([{ ...deflated, declaredLength: 1 }]))).rejects.toThrow(/exceeds the declared size/);
    await expect(readZip(makeZip([{ ...deflated, declaredLength: data.length + 1 }]))).rejects.toThrow(/size mismatch/);
  });
});

const presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
const officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";

describe("PowerPoint picture media lookup", () => {
  const slide = `<?xml version="1.0"?>
    <p:sld xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${officeRelationships}">
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
          <p:grpSp><other:pic xmlns:other="${presentation}">
            <other:nvPicPr><other:cNvPr id="6" name="Grouped picture"/></other:nvPicPr>
            <other:blipFill><a:blip xmlns:rel="${officeRelationships}" rel:embed="rId3"/></other:blipFill>
          </other:pic></p:grpSp>
        </p:grpSp>
        <p:pic>
          <p:nvPicPr><p:cNvPr id="7" name="Missing relationship"/></p:nvPicPr>
          <p:blipFill><a:blip r:embed="rId4"/></p:blipFill>
        </p:pic>
      </p:spTree></p:cSld>
    </p:sld>`;
  const relationships = `<Relationships xmlns="${packageRelationships}">
    <Relationship Type="${officeRelationships}/image" Target="../media/image1.png" Id="rId2"/>
    <Relationship Id = 'rId3' Target='/ppt/media/group%20%26%20child.png' Type='${officeRelationships}/image' />
    <!-- <Relationship Id="rId4" Target="../media/ignored.png" Type="${officeRelationships}/image"/> -->
  </Relationships>`;

  it("resolves pictures and pictures within nested groups", () => {
    expect(pptxSlidePictureMedia(slide, relationships, 3)).toBe("ppt/media/image1.png");
    expect(pptxSlidePictureMedia(slide, relationships, "6")).toBe("ppt/media/group & child.png");
  });

  it("returns null for shape fills, group IDs, missing shapes and missing relationships", () => {
    for (const id of [4, 5, 7, 999]) expect(pptxSlidePictureMedia(slide, relationships, id)).toBeNull();
  });

  it("returns null for an external relationship, a non-image relationship or a target outside ppt/media", () => {
    expect(pptxSlidePictureMedia(slide, relationships.replace('Id="rId2"', 'Id="rId2" TargetMode="External"'), 3)).toBeNull();
    expect(pptxSlidePictureMedia(slide, relationships.replace("/image\"", "/slide\""), 3)).toBeNull();
    expect(pptxSlidePictureMedia(slide, relationships.replace("../media/image1.png", "../../word/media/image1.png"), 3)).toBeNull();
  });
});

describe("Flat OPC binary parts", () => {
  it("reads multiple ordered parts with wrapped base64 and ignores XML-only parts", () => {
    const xml = `<?xml version='1.0'?>
      <pkg:package xmlns:pkg="http://schemas.microsoft.com/office/2006/xmlPackage">
        <pkg:part pkg:contentType = 'image/png' pkg:name="/word/media/a&amp;b.png">
          <pkg:binaryData>iVBO\r\n    Rw0K\tGgo=</pkg:binaryData>
        </pkg:part>
        <pkg:part pkg:name="/word/document.xml" pkg:contentType="application/xml"><pkg:xmlData/></pkg:part>
        <part:part xmlns:part="http://schemas.microsoft.com/office/2006/xmlPackage"
          part:name="/word/media/b.jpeg" part:contentType="image/jpeg">
          <part:binaryData>/9j/</part:binaryData>
        </part:part>
      </pkg:package>`;
    expect(flatOpcBinaryParts(xml)).toEqual([
      { name: "/word/media/a&b.png", contentType: "image/png", bytes: Uint8Array.of(0x89, 80, 78, 71, 13, 10, 26, 10) },
      { name: "/word/media/b.jpeg", contentType: "image/jpeg", bytes: Uint8Array.of(0xff, 0xd8, 0xff) },
    ]);
  });
});
