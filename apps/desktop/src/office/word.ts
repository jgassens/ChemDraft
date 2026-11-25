import { flatOpcBinaryParts } from "@chemdraft/clipboard-adapter";
import {
  errorMessage, noStructure, readCarrier, readOfficeDocument, refuse, replacementImage, selectionChanged,
  type OfficeContext, type OfficeHostAdapter,
} from "./host";
import { A, PIC, OPC, PKG_REL, R, WORD, WP, WP14, child, decodeXml, hasCrop, partXml, relationshipPart, xmlDocument } from "./ooxml";

interface WordRange {
  getOoxml(): { value: string };
  insertOoxml(xml: string, location: "Replace"): WordRange;
  // WordApi 1.3; feature-detected before use.
  load?(fields: "isEmpty"): WordRange;
  isEmpty?: boolean;
}
interface WordContext {
  document: { getSelection(): WordRange };
  sync(): Promise<void>;
}
export interface WordApi {
  run<T>(work: (context: WordContext) => Promise<T>): Promise<T>;
}

const documentPath = "word/document.xml";
const relsPath = "word/_rels/document.xml.rels";
const relsContentType = "application/vnd.openxmlformats-package.relationships+xml";
const groupNamespace = "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup";

function wordPicture(drawing: Element) {
  const placement = child(drawing, WP, "inline") ?? child(drawing, WP, "anchor");
  const graphics = child(child(placement, A, "graphic"), A, "graphicData");
  const picture = child(graphics, PIC, "pic");
  if (!placement || !picture) {
    if (drawing.getElementsByTagNameNS(groupNamespace, "*").length || drawing.getElementsByTagNameNS(PIC, "pic").length > 1) {
      return refuse("Grouped pictures cannot be edited in Word.");
    }
    return noStructure;
  }
  if (hasCrop(picture)) return refuse("Cropped pictures cannot be edited in Word.");
  const extent = child(placement, WP, "extent");
  const properties = child(placement, WP, "docPr");
  const blip = child(child(picture, PIC, "blipFill"), A, "blip");
  const transformExtent = child(child(child(picture, PIC, "spPr"), A, "xfrm"), A, "ext");
  const width = Number(extent?.getAttribute("cx"));
  if (!extent || !properties || !blip || !Number.isSafeInteger(width) || width <= 0 ||
      !(Number(extent.getAttribute("cy")) > 0)) {
    return refuse("The selected Word picture has invalid dimensions or placement.");
  }
  const id = properties.getAttribute("id");
  const anchorId = placement.getAttributeNS(WP14, "anchorId");
  const name = properties.getAttribute("name");
  const imageId = blip.getAttributeNS(R, "embed");
  if (!imageId || blip.hasAttributeNS(R, "link")) return refuse("Select an embedded Word picture.");
  const key = new XMLSerializer().serializeToString(drawing);
  return { kind: "picture" as const, key, drawing, extent, transformExtent, width, id, anchorId, name, imageId, properties, blip };
}
type WordPicture = Extract<ReturnType<typeof wordPicture>, { kind: "picture" }>;

function parseSelection(xml: string) {
  const pkg = xmlDocument(xml);
  const document = partXml(pkg, "/" + documentPath);
  const body = child(document, WORD, "body");
  if (!body) return noStructure;
  const drawings = [...body.getElementsByTagNameNS(WORD, "drawing")];
  if (!drawings.length) return noStructure;
  // Replacing a range that also contains text, other objects, or paragraph breaks would delete them.
  const selectedDrawing = drawings[0]!;
  const content = new Set(["document", "body", "p", "pPr", "r", "rPr", "sectPr", "drawing",
    "bookmarkStart", "bookmarkEnd", "proofErr", "lastRenderedPageBreak"]);
  const additionalContent = [...body.getElementsByTagName("*")].some(element => {
    if (selectedDrawing.contains(element)) return false;
    if (element.namespaceURI === WORD && content.has(element.localName)) return false;
    for (let parent = element.parentElement; parent && parent !== body; parent = parent.parentElement) {
      if (parent.namespaceURI === WORD && ["pPr", "rPr", "sectPr"].includes(parent.localName)) return false;
    }
    return true;
  });
  if (drawings.length !== 1 || additionalContent || body.getElementsByTagNameNS(WORD, "p").length !== 1) {
    return refuse("Select a single Word picture without surrounding content.");
  }
  const picture = wordPicture(selectedDrawing);
  if (picture.kind !== "picture") return picture;
  const media = relationshipPart(partXml(pkg, "/" + relsPath), picture.imageId, documentPath, "image");
  return { ...picture, media };
}

async function fallbackPicture(context: OfficeContext, selected: WordPicture) {
  // Relationship IDs in a Flat OPC selection can be renumbered. Locate the drawing in the full
  // document before using its own relationship. Never pick a carrier by scanning unrelated images.
  if (!selected.anchorId && (!selected.id || selected.id === "0" || !selected.name)) return;
  const entries = await readOfficeDocument(context);
  const document = entries.find(entry => entry.name === documentPath);
  const rels = entries.find(entry => entry.name === relsPath);
  if (!document || !rels) return;
  const candidates = [...xmlDocument(decodeXml(document.data)).getElementsByTagNameNS(WORD, "drawing")]
    .map(wordPicture)
    .filter((picture): picture is WordPicture => picture.kind === "picture" &&
      picture.width === selected.width && picture.extent.getAttribute("cy") === selected.extent.getAttribute("cy") &&
      (selected.anchorId ? picture.anchorId === selected.anchorId : picture.id === selected.id && picture.name === selected.name));
  if (candidates.length !== 1) return;
  const media = relationshipPart(xmlDocument(decodeXml(rels.data)).documentElement, candidates[0]!.imageId, documentPath, "image");
  return media?.startsWith("word/media/") ? entries.find(entry => entry.name === media)?.data : undefined;
}

async function wordCarrier(office: OfficeContext, picture: WordPicture & { media?: string }, xml: string) {
  let primary = refuse("Office did not return the selected picture’s stored image.");
  if (picture.media?.startsWith("word/media/")) {
    try {
      const stored = await readCarrier(flatOpcBinaryParts(xml).find(part => part.name === "/" + picture.media)?.bytes);
      if (stored.kind === "found") return stored;
      primary = stored;
    } catch (error) {
      primary = refuse(errorMessage(error));
    }
  }
  if (office.requirements.isSetSupported("CompressedFile", "1.1")) {
    const fallback = await fallbackPicture(office, picture);
    if (fallback) return readCarrier(fallback);
  }
  return primary;
}

function replacementOoxml(picture: WordPicture, pngBase64: string, aspect: number) {
  const { drawing, blip, extent, transformExtent, properties, width } = picture;
  const height = Math.round(width * aspect);
  if (!Number.isSafeInteger(height) || height < 1) throw new Error("The replacement Word picture is too tall or too short.");
  for (const element of [drawing, ...drawing.getElementsByTagName("*")]) {
    if ([...element.attributes].some(attr => attr.namespaceURI === R && !(element === blip && attr.localName === "embed"))) {
      throw new Error("The selected Word picture has additional linked parts that cannot be preserved.");
    }
  }
  extent.setAttribute("cy", String(height));
  // A picture has a layout extent and a DrawingML extent. Both must describe the new image.
  transformExtent?.setAttribute("cx", String(width));
  transformExtent?.setAttribute("cy", String(height));
  const description = properties.getAttribute("descr")?.trim();
  properties.setAttribute("descr", description && !description.startsWith("ChemDraft") ? "ChemDraft · " + description : description || "ChemDraft");
  blip.setAttributeNS(R, "r:embed", "rIdImage");
  const drawingXml = new XMLSerializer().serializeToString(drawing);
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<pkg:package xmlns:pkg="' + OPC + '">' +
    '<pkg:part pkg:name="/_rels/.rels" pkg:contentType="' + relsContentType + '">' +
    '<pkg:xmlData><Relationships xmlns="' + PKG_REL + '">' +
    '<Relationship Id="rIdDocument" Type="' + R + '/officeDocument" Target="word/document.xml"/>' +
    '</Relationships></pkg:xmlData></pkg:part>' +
    '<pkg:part pkg:name="/word/document.xml" pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml">' +
    '<pkg:xmlData><w:document xmlns:w="' + WORD + '"><w:body><w:p><w:r>' + drawingXml +
    '</w:r></w:p></w:body></w:document></pkg:xmlData></pkg:part>' +
    '<pkg:part pkg:name="/word/_rels/document.xml.rels" pkg:contentType="' + relsContentType + '">' +
    '<pkg:xmlData><Relationships xmlns="' + PKG_REL + '">' +
    '<Relationship Id="rIdImage" Type="' + R + '/image" Target="media/replacement.png"/>' +
    '</Relationships></pkg:xmlData></pkg:part>' +
    '<pkg:part pkg:name="/word/media/replacement.png" pkg:contentType="image/png"><pkg:binaryData>' +
    pngBase64 + '</pkg:binaryData></pkg:part></pkg:package>';
}

/** Whether the Word selection is a bare insertion point. Undefined when Word cannot say. */
async function selectionIsEmpty(office: OfficeContext, word: WordApi) {
  if (!office.requirements.isSetSupported("WordApi", "1.3")) return undefined;
  try {
    return await word.run(async context => {
      const range = context.document.getSelection();
      if (!range.load) return undefined;
      range.load("isEmpty");
      await context.sync();
      return range.isEmpty === true;
    });
  } catch {
    return undefined;
  }
}

export function wordAdapter(office: OfficeContext, word: WordApi | undefined): OfficeHostAdapter {
  let selected: { key: string; json: string } | undefined;
  let reading = 0;
  return {
    async readSelectedStructure() {
      const request = ++reading;
      if (!word || !office.requirements.isSetSupported("WordApi", "1.1")) return refuse("Editing needs WordApi 1.1 or later.");
      try {
        let xml: string;
        try {
          xml = await word.run(async context => {
            const file = context.document.getSelection().getOoxml();
            await context.sync();
            return file.value;
          });
        } catch (error) {
          // Word for Mac fails getOoxml() with GeneralException when the selection is only a text
          // cursor. That is not a picture, so show the usual prompt; any other failure is reported.
          if (await selectionIsEmpty(office, word)) return noStructure;
          throw error;
        }
        const picture = parseSelection(xml);
        if (picture.kind !== "picture") return picture;
        const carrier = await wordCarrier(office, picture, xml);
        if (carrier.kind === "refusal") return carrier;
        const value = { key: picture.key, json: carrier.json };
        if (request === reading) selected = value;
        return { kind: "structure", ...value };
      } catch (error) {
        return refuse("Could not read the selected Word picture. " + errorMessage(error));
      }
    },
    async replaceSelectedStructure(png, json, size) {
      const expected = selected;
      if (!word || !expected) return refuse(selectionChanged);
      try {
        const image = await replacementImage(png, json, size);
        return await word.run(async context => {
          const range = context.document.getSelection();
          const source = range.getOoxml();
          await context.sync();
          const picture = parseSelection(source.value);
          if (picture.kind !== "picture" || picture.key !== expected.key || selected !== expected) return refuse(selectionChanged);
          // Compare the bytes as well, since a document edit can replace the media without changing the drawing XML.
          const stored = await wordCarrier(office, picture, source.value);
          if (stored.kind !== "found" || stored.json !== expected.json || selected !== expected) return refuse(selectionChanged);
          const replacement = range.insertOoxml(replacementOoxml(picture, image.base64, image.aspect), "Replace");
          await context.sync();
          // Word may renumber picture IDs during insertion. Read the returned range, since the
          // user may already have selected another picture.
          try {
            const insertedXml = replacement.getOoxml();
            await context.sync();
            const inserted = parseSelection(insertedXml.value);
            if (inserted.kind === "picture" && (inserted.anchorId || Number(inserted.id) > 0)) {
              return { kind: "replaced", key: inserted.key };
            }
          } catch {
            // The write was already confirmed. Report the missing identity without retrying it.
          }
          return { kind: "replaced", key: undefined, warnings: ["Could not identify the replacement Word picture."] };
        });
      } catch (error) {
        return refuse("Could not replace the Word picture. " + errorMessage(error));
      }
    },
  };
}
