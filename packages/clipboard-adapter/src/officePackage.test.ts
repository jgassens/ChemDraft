import { crc32, deflateRawSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { decodeBase64Bounded, flatOpcBinaryParts, pptxSlidePictureMedia, readZip, readZipFromBase64 } from "./index";

interface TestEntry {
  name: string;
  data: Buffer;
  deflate?: boolean;
  descriptor?: "signed" | "unsigned" | "missing";
  flags?: number;
  declaredLength?: number;
  checksum?: number;
  extra?: Buffer;
}

function makeZip(entries: TestEntry[]): Buffer {
  const locals: Buffer[] = [];
  const records: Buffer[] = [];
  let offset = 0;
  for (const { name, data, deflate, descriptor, flags: extraFlags = 0, declaredLength = data.length,
    checksum = crc32(data), extra = Buffer.alloc(0) } of entries) {
    const filename = Buffer.from(name);
    const body = deflate ? deflateRawSync(data) : data;
    const method = deflate ? 8 : 0;
    const flags = extraFlags | (descriptor ? 8 : 0);

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

    const trailer = Buffer.alloc(descriptor === "signed" ? 16 : descriptor === "unsigned" ? 12 : 0);
    if (trailer.length) {
      const start = trailer.length - 12;
      if (start) trailer.writeUInt32LE(0x08074b50);
      trailer.writeUInt32LE(checksum, start);
      trailer.writeUInt32LE(body.length, start + 4);
      trailer.writeUInt32LE(declaredLength, start + 8);
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

  it("reads stored and deflated entries with signed and unsigned data descriptors", async () => {
    const entries = [entry, { ...entry, name: "ppt/slides/slide1.xml", deflate: true },
      { ...entry, name: "ppt/slides/_rels/slide1.xml.rels", deflate: true, descriptor: "signed" },
      { ...entry, name: "ppt/media/second.png", descriptor: "unsigned" }] satisfies TestEntry[];
    const archive = Buffer.concat([Buffer.of(0), makeZip(entries)]).subarray(1);
    expect((await readZip(archive)).map(({ name, data }) => ({ name, data: Buffer.from(data) }))).toEqual(
      entries.map(({ name, data }) => ({ name, data })),
    );
  });

  it("reads Office.js base64 and checks the archive length before parsing or decoding", async () => {
    const archive = makeZip([entry]);
    const base64 = archive.toString("base64");
    const [decoded] = await readZipFromBase64(base64, { maxArchiveBytes: archive.length });
    expect({ name: decoded.name, data: Buffer.from(decoded.data) }).toEqual(entry);
    await expect(readZipFromBase64(base64, { maxArchiveBytes: archive.length - 1 })).rejects.toThrow(/byte limit/);
    await expect(readZip(Buffer.of(0), { maxArchiveBytes: 0 })).rejects.toThrow(/archive exceeds/);
  });

  it("refuses a missing data descriptor before the next entry", async () => {
    const archive = makeZip([{ ...entry, descriptor: "missing" }, { ...entry, name: "ppt/media/next.png" }]);
    await expect(readZip(archive)).rejects.toThrow(/Missing or truncated ZIP data descriptor/);
  });

  it.each([["CRC", 12], ["compressed size", 8], ["inflated size", 4]] as const)(
    "refuses a data descriptor with mismatched %s", async (_field, fromDirectory) => {
      const archive = makeZip([{ ...entry, deflate: true, descriptor: "signed" }]);
      const directory = archive.readUInt32LE(archive.length - 6);
      archive[directory - fromDirectory] ^= 1;
      await expect(readZip(archive)).rejects.toThrow(/data descriptor CRC or size mismatch/);
    },
  );

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

  it.each([
    ["missing DecompressionStream", undefined, /lacks DecompressionStream/],
    ["unsupported format", class { constructor() { throw new TypeError("Unsupported format"); } }, /does not support/],
  ] as const)("reports %s as unsupported for deflated entries", async (_label, decoder, reason) => {
    vi.stubGlobal("DecompressionStream", decoder);
    try {
      await expect(readZip(makeZip([entry]))).resolves.toHaveLength(1);
      await expect(readZip(makeZip([{ ...entry, deflate: true }]))).rejects.toMatchObject({
        code: "unsupported-decompression", message: expect.stringMatching(reason),
      });
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

  it("refuses patched data flags and requires bit 11 for UTF-8 names", async () => {
    const name = "ppt/media/café.png";
    await expect(readZip(makeZip([{ ...entry, flags: 0x20 }]))).rejects.toThrow(/Patched ZIP data/);
    await expect(readZip(makeZip([{ ...entry, name }]))).rejects.toThrow(/Non-ASCII ZIP entry name/);
    await expect(readZip(makeZip([{ ...entry, name, flags: 0x800 }]))).resolves.toMatchObject([{ name }]);
    const archive = makeZip([{ ...entry, flags: 0x800 }]);
    const directory = archive.readUInt32LE(archive.length - 6);
    archive[30] = archive[directory + 46] = 0xff;
    await expect(readZip(archive)).rejects.toThrow(/Invalid UTF-8 ZIP entry name/);
  });

  it("rejects both longer and shorter inflated results than advertised", async () => {
    const deflated = { ...entry, deflate: true, descriptor: "signed" } satisfies TestEntry;
    await expect(readZip(makeZip([{ ...deflated, declaredLength: 1 }]))).rejects.toThrow(/exceeds the declared size/);
    await expect(readZip(makeZip([{ ...deflated, declaredLength: data.length + 1 }]))).rejects.toThrow(/size mismatch/);
  });
});

describe("bounded base64 decoding", () => {
  it("allows exact limits and optional padding", () => {
    expect(decodeBase64Bounded("", 0)).toEqual(new Uint8Array(0));
    expect(decodeBase64Bounded("/+A=", 2)).toEqual(Uint8Array.of(255, 224));
    expect(decodeBase64Bounded("/+A", 2)).toEqual(Uint8Array.of(255, 224));
  });

  it("checks both encoded length and exact decoded size", () => {
    expect(() => decodeBase64Bounded("xxxxxxxx!", 3)).toThrow(/3-byte limit/);
    expect(() => decodeBase64Bounded("AAAA", 2)).toThrow(/2-byte limit/);
  });

  it.each(["A", "AB=", "A===", "AB=C", "AB-_", "AB C"])("rejects malformed compact base64 %s", (base64) => {
    expect(() => decodeBase64Bounded(base64, 12)).toThrow(/Invalid base64/);
  });
});

const presentation = "http://schemas.openxmlformats.org/presentationml/2006/main";
const drawing = "http://schemas.openxmlformats.org/drawingml/2006/main";
const officeRelationships = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const packageRelationships = "http://schemas.openxmlformats.org/package/2006/relationships";
const markupCompatibility = "http://schemas.openxmlformats.org/markup-compatibility/2006";

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

  it("resolves ASCII case variants of the PowerPoint media directory and preserves target spelling", () => {
    expect(pptxSlidePictureMedia(slide, relationships.replace("../media/image1.png", "../MEDIA/Image1.png"), 3))
      .toBe("ppt/MEDIA/Image1.png");
    expect(pptxSlidePictureMedia(slide, relationships.replace("../media/image1.png", "../MEDIAX/Image1.png"), 3))
      .toBeNull();
  });

  it("returns null for shape fills, group IDs, missing shapes and missing relationships", () => {
    for (const id of [4, 5, 7, 999]) expect(pptxSlidePictureMedia(slide, relationships, id)).toBeNull();
  });

  it("returns null for an external relationship, a non-image relationship or a target outside ppt/media", () => {
    expect(pptxSlidePictureMedia(slide, relationships.replace('Id="rId2"', 'Id="rId2" TargetMode="External"'), 3)).toBeNull();
    expect(pptxSlidePictureMedia(slide, relationships.replace("/image\"", "/slide\""), 3)).toBeNull();
    expect(pptxSlidePictureMedia(slide, relationships.replace("../media/image1.png", "../../word/media/image1.png"), 3)).toBeNull();
  });

  function picture(id: number, relationship: string): string {
    return `<p:pic><p:nvPicPr><p:cNvPr id="${id}"/></p:nvPicPr>
      <p:blipFill><a:blip r:embed="${relationship}"/></p:blipFill></p:pic>`;
  }

  function alternate(branches: string, tail = ""): string {
    return `<p:sld xmlns:p="${presentation}" xmlns:a="${drawing}" xmlns:r="${officeRelationships}"
      xmlns:mc="${markupCompatibility}" xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main"
      xmlns:future="urn:example:future-presentation">
      <mc:AlternateContent>${branches}</mc:AlternateContent>${tail}
    </p:sld>`;
  }

  it("uses the first Choice whose scoped namespace URIs are all understood", () => {
    const xml = alternate(`
      <mc:Choice Requires="p future">${picture(3, "rId4")}</mc:Choice>
      <mc:Choice Requires="draw r" xmlns:draw="${drawing}">${picture(3, "rId2")}</mc:Choice>
      <mc:Choice Requires="p">${picture(3, "rId3")}</mc:Choice>
      <mc:Fallback>${picture(3, "rId3")}</mc:Fallback>`);
    expect(pptxSlidePictureMedia(xml, relationships, 3)).toBe("ppt/media/image1.png");
  });

  it("selects a Choice that requires the PowerPoint 2010 namespace, as PowerPoint does", () => {
    const xml = alternate(`
      <mc:Choice Requires="p14">${picture(3, "rId3")}</mc:Choice>
      <mc:Fallback>${picture(3, "rId2")}</mc:Fallback>`);
    expect(pptxSlidePictureMedia(xml, relationships, 3)).toBe("ppt/media/group & child.png");
  });

  it("uses the fallback when all choices require unsupported namespaces", () => {
    const xml = alternate(`
      <mc:Choice Requires="future">${picture(3, "rId2")}</mc:Choice>
      <mc:Choice Requires="a" xmlns:a="urn:unsupported">${picture(3, "rId2")}</mc:Choice>
      <mc:Fallback>${picture(3, "rId3")}</mc:Fallback>`);
    expect(pptxSlidePictureMedia(xml, relationships, 3)).toBe("ppt/media/group & child.png");
  });

  it("treats selected branches under a picture's properties as transparent", () => {
    const xml = alternate(`<mc:Choice Requires="p">
      <p:pic><p:nvPicPr><p:cNvPr id="3"/></p:nvPicPr><p:blipFill>
        <mc:AlternateContent>
          <mc:Choice Requires="future"><a:blip r:embed="rId3"/></mc:Choice>
          <mc:Fallback><a:blip r:embed="rId2"/></mc:Fallback>
        </mc:AlternateContent>
      </p:blipFill></p:pic>
    </mc:Choice>`);
    expect(pptxSlidePictureMedia(xml, relationships, 3)).toBe("ppt/media/image1.png");
  });

  it("rejects a target ID in multiple effective branches", () => {
    const xml = alternate(
      `<mc:Choice Requires="p">${picture(3, "rId2")}</mc:Choice>`,
      alternate(`<mc:Choice Requires="future">${picture(4, "rId4")}</mc:Choice>
        <mc:Fallback>${picture(3, "rId3")}</mc:Fallback>`),
    );
    expect(() => pptxSlidePictureMedia(xml, relationships, 3)).toThrow(/Duplicate shape ID/);
  });

  it("fails closed on an undeclared Requires prefix", () => {
    const xml = alternate(`<mc:Choice Requires="missing">${picture(3, "rId2")}</mc:Choice>`);
    expect(() => pptxSlidePictureMedia(xml, relationships, 3)).toThrow(/Undeclared .* prefix: missing/);
  });
});

const flatOpc = "http://schemas.microsoft.com/office/2006/xmlPackage";

function flatOpcBinary(content: string): string {
  return `<pkg:package xmlns:pkg="${flatOpc}">
    <pkg:part pkg:name="/word/media/image.png" pkg:contentType="image/png">
      <pkg:binaryData>${content}</pkg:binaryData>
    </pkg:part>
  </pkg:package>`;
}

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

  it("combines text and CDATA while discarding comments and processing instructions", () => {
    const xml = flatOpcBinary("&#x51;<!-- invalid &example; base64 --><?sample &invalid?><![CDATA[U]]>&#74;\tD");
    expect(flatOpcBinaryParts(xml)[0].bytes).toEqual(Uint8Array.of(65, 66, 67));
  });

  it("normalizes literal attribute whitespace and preserves referenced characters", () => {
    const xml = flatOpcBinary("QQ==").replace("image.png", "one\r\ntwo&#9;&#x1F4C4;.png");
    expect(flatOpcBinaryParts(xml)[0].name).toBe("/word/media/one two\t📄.png");
  });

  it("rejects duplicate part names, compared case-insensitively, before decoding", () => {
    const part = (name: string, data: string) =>
      `<pkg:part pkg:name="${name}" pkg:contentType="image/png"><pkg:binaryData>${data}</pkg:binaryData></pkg:part>`;
    const xml = (second: string) => `<pkg:package xmlns:pkg="${flatOpc}">
      ${part("/word/media/image1.png", "QUJD")}${part(second, "REVG")}</pkg:package>`;
    expect(() => flatOpcBinaryParts(xml("/word/media/image1.png"))).toThrow(/duplicate part names/);
    expect(() => flatOpcBinaryParts(xml("/Word/Media/IMAGE1.png"))).toThrow(/duplicate part names/);
    expect(flatOpcBinaryParts(xml("/word/media/image2.png")).map(({ name }) => name))
      .toEqual(["/word/media/image1.png", "/word/media/image2.png"]);
  });

  it("treats markup-like CDATA as literal text and rejects elements inside binaryData", () => {
    expect(() => flatOpcBinaryParts(flatOpcBinary("<![CDATA[&#65;]]>"))).toThrow(/Invalid base64/);
    expect(() => flatOpcBinaryParts(flatOpcBinary("QU<nested/>JD"))).toThrow(/Unexpected element inside .*binaryData/);
  });
});

describe("bounded Office XML scanning", () => {
  it.each([
    ["size", () => " ".repeat(20 * 1024 * 1024 + 1), /20 MiB input length/],
    ["elements", () => `<x>${"<x/>".repeat(200_000)}</x>`, /200000 element limit/],
    ["depth", () => `${"<x>".repeat(256)}<x/>${"</x>".repeat(256)}`, /nesting limit/],
    ["attributes", () => `<x ${Array.from({ length: 257 }, (_, i) => `a${i}="v"`).join(" ")}/>`, /attributes per element/],
  ] as const)("enforces the %s limit in both Office readers", (_label, fixture, error) => {
    const xml = fixture();
    expect(() => flatOpcBinaryParts(xml)).toThrow(error);
    expect(() => pptxSlidePictureMedia(xml, "<relationships/>", 1)).toThrow(error);
  });

  it("validates relationship XML even when the picture has no relationship to look up", () => {
    expect(() => pptxSlidePictureMedia("<slide/>", "<relationships>&unknown;</relationships>", 1)).toThrow(/entity reference/);
  });

  it.each([
    ['<x a="&unknown;"/>', /entity reference/],
    ["<x>&amp</x>", /entity reference/],
    ["<x>&#;</x>", /character reference/],
    ["<x>&#xD800;</x>", /character reference/],
    ["<x>&#1114112;</x>", /character reference/],
    ['<x a="1" a="2"/>', /Duplicate Office XML attribute/],
    ['<x xmlns="urn:a" xmlns="urn:b"/>', /Duplicate Office XML attribute/],
    ['<x xmlns:a="urn:a" xmlns:a="urn:b"/>', /Duplicate Office XML attribute/],
    ['<x xmlns:a="urn:a" xmlns:b="urn:a" a:id="1" b:id="2"/>', /Duplicate Office XML attribute/],
    ['<x a="unescaped <"/>', /Unescaped/],
    ["<x:root/>", /Undeclared Office XML namespace prefix/],
    ["<x/><y/>", /Multiple Office XML root elements/],
    ["<x><!--invalid -- comment--></x>", /Malformed Office XML comment/],
    ["<x><![CDATA[unclosed</x>", /Unclosed Office XML CDATA/],
    ["<!DOCTYPE x><x/>", /Unsupported Office XML declaration/],
  ] as const)("rejects malformed XML %s", (xml, error) => {
    expect(() => flatOpcBinaryParts(xml)).toThrow(error);
    expect(() => pptxSlidePictureMedia(xml, "<relationships/>", 1)).toThrow(error);
  });
});
