import { pptxSlidePictureMedia, readZipFromBase64, type OfficeZipEntry } from "@chemdraft/clipboard-adapter";
import {
  errorMessage, noStructure, officeAsync, readCarrier, readOfficeDocument, refuse, replacementImage, selectionChanged,
  type OfficeContext, type OfficeHostAdapter, type SelectionResult,
} from "./host";
import { A, P, R, child, children, decodeXml, hasCrop, relationshipPart, xmlDocument } from "./ooxml";

interface Collection<T> {
  load(fields: string): Collection<T>;
  items: T[];
}
interface Tag { key: string; value: string }
interface Shape {
  id: string;
  name: string;
  type: string;
  left: number;
  top: number;
  width: number;
  height: number;
  rotation?: number;
  zOrderPosition: number;
  tags: Collection<Tag> & { add(key: string, value: string): void };
  load(fields: string): unknown;
  setZOrder(order: "BringForward" | "SendBackward"): void;
  delete(): void;
}
interface Slide {
  id: string;
  shapes: Collection<Shape>;
  exportAsBase64(): { value: string };
}
interface PowerPointContext {
  presentation: {
    getSelectedShapes(): Collection<Shape>;
    getSelectedSlides(): Collection<Slide>;
    slides: { getItem(id: string): Slide };
  };
  sync(): Promise<void>;
}
export interface PowerPointApi {
  run<T>(work: (context: PowerPointContext) => Promise<T>): Promise<T>;
}

const api = "PowerPointApi";
const needsNewer = "Updating needs a newer PowerPoint (PowerPointApi 1.8).";
const needsRotation = "This picture is rotated. Updating it needs PowerPointApi 1.10 to preserve its rotation.";
const grouped = "Grouped pictures cannot be edited in PowerPoint.";
const marker = "CHEMDRAFT";

async function selectedSlideShape(context: PowerPointContext) {
  const shapes = context.presentation.getSelectedShapes().load("items/id,items/type");
  const slides = context.presentation.getSelectedSlides().load("items/id");
  await context.sync();
  return shapes.items.length === 1 && slides.items.length === 1
    ? { shape: shapes.items[0]!, slide: slides.items[0]! }
    : undefined;
}

function findSlide(entries: OfficeZipEntry[], slideId?: string) {
  if (slideId === undefined) {
    const slides = entries.filter(entry => /^ppt\/slides\/[^/]+\.xml$/.test(entry.name));
    return slides.length === 1 ? slides[0] : undefined;
  }
  const presentationPath = "ppt/presentation.xml";
  const presentation = entries.find(entry => entry.name === presentationPath);
  const relationships = entries.find(entry => entry.name === "ppt/_rels/presentation.xml.rels");
  if (!presentation || !relationships) return;
  const slideList = child(xmlDocument(decodeXml(presentation.data)).documentElement, P, "sldIdLst");
  const slides = slideList ? children(slideList, P, "sldId").filter(slide => slide.getAttribute("id") === slideId) : [];
  const relId = slides.length === 1 && slides[0]!.getAttributeNS(R, "id");
  if (!relId) return;
  const name = relationshipPart(xmlDocument(decodeXml(relationships.data)).documentElement, relId, presentationPath, "slide");
  return name && /^ppt\/slides\/[^/]+\.xml$/.test(name) ? entries.find(entry => entry.name === name) : undefined;
}

async function readPicture(entries: OfficeZipEntry[], shapeId: string, slideId?: string) {
  const slide = findSlide(entries, slideId);
  if (!slide) throw new Error("Could not identify the selected PowerPoint slide in the file.");
  const relsPath = slide.name.replace(/^ppt\/slides\//, "ppt/slides/_rels/") + ".rels";
  const rels = entries.find(entry => entry.name === relsPath);
  if (!rels) throw new Error("The selected PowerPoint slide has no image relationships.");
  const xml = decodeXml(slide.data);
  const doc = xmlDocument(xml);
  const properties = [...doc.getElementsByTagNameNS(P, "cNvPr")].filter(node => node.getAttribute("id") === shapeId);
  if (properties.length > 1) throw new Error("The selected picture has an ambiguous shape ID.");
  const shape = properties[0]?.parentElement?.parentElement;
  if (shape?.localName !== "pic" || shape.namespaceURI !== P) return noStructure;
  if (shape.parentElement?.namespaceURI === P && shape.parentElement.localName === "grpSp") return refuse(grouped);
  if (hasCrop(shape)) return refuse("Cropped pictures cannot be edited in PowerPoint.");
  const transform = child(child(shape, P, "spPr"), A, "xfrm");
  if (["flipH", "flipV"].some(axis => ["1", "true"].includes(transform?.getAttribute(axis) ?? ""))) {
    return refuse("Flipped pictures cannot be edited in PowerPoint.");
  }
  const rotation = Number(transform?.getAttribute("rot") ?? 0) / 60000;
  if (!Number.isFinite(rotation)) return refuse("The picture has an invalid rotation.");
  const media = pptxSlidePictureMedia(xml, decodeXml(rels.data), shapeId);
  const carrier = await readCarrier(entries.find(entry => entry.name === media)?.data);
  return carrier.kind === "found" ? { kind: "picture" as const, json: carrier.json, rotation } : carrier;
}

function writableProperty(value: object, property: string) {
  for (let target: object | null = value; target; target = Object.getPrototypeOf(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor) return descriptor.set !== undefined || descriptor.writable === true;
  }
  return false;
}

export function powerpointAdapter(office: OfficeContext, powerpoint: PowerPointApi | undefined): OfficeHostAdapter {
  let selected: Extract<SelectionResult, { kind: "structure" }> | undefined;
  let reading = 0;
  const supports = (version: string) => office.requirements.isSetSupported(api, version);
  async function readSelection(): Promise<SelectionResult> {
    if (!powerpoint || !supports("1.5")) return refuse("Selecting pictures needs PowerPointApi 1.5 or later.");
    const active = await powerpoint.run(async context => {
      const current = await selectedSlideShape(context);
      return current && { slideId: current.slide.id, shapeId: current.shape.id, shapeType: current.shape.type };
    });
    if (!active) return noStructure;
    const { slideId, shapeId, shapeType } = active;
    if (shapeType === "Group") return refuse(grouped);
    if (shapeType !== "Image" && shapeType !== "Graphic") return noStructure;
    let picture: Awaited<ReturnType<typeof readPicture>> | undefined;
    let exportError: unknown;
    if (supports("1.8")) {
      try {
        const base64 = await powerpoint.run(async context => {
          const result = context.presentation.slides.getItem(slideId).exportAsBase64();
          await context.sync();
          return result.value;
        });
        picture = await readPicture(await readZipFromBase64(base64), shapeId);
      } catch (error) {
        exportError = error;
      }
    }
    if (!picture || picture.kind === "no-structure" ||
        (picture.kind === "refusal" && /carrier|stored image|PNG/.test(picture.reason))) {
      if (office.requirements.isSetSupported("CompressedFile", "1.1")) {
        const fallback = await readPicture(await readOfficeDocument(office), shapeId, slideId);
        if (fallback.kind !== "no-structure" || !picture) picture = fallback;
      }
    }
    if (!picture) return refuse(exportError ? errorMessage(exportError) : "This PowerPoint cannot read the stored picture.");
    if (picture.kind !== "picture") return picture;
    const updateRefusal = !supports("1.8") ? needsNewer :
      picture.rotation && !supports("1.10") ? needsRotation :
      !office.requirements.isSetSupported("ImageCoercion", "1.1") ? "This PowerPoint cannot insert image data." : undefined;
    return { kind: "structure", key: JSON.stringify([slideId, shapeId]), json: picture.json, updateRefusal };
  }

  return {
    async readSelectedStructure() {
      const request = ++reading;
      try {
        const result = await readSelection();
        if (result.kind === "structure" && request === reading) selected = result;
        return result;
      } catch (error) {
        return refuse("Could not read the selected PowerPoint picture. " + errorMessage(error));
      }
    },
    async replaceSelectedStructure(png, json, size) {
      if (!powerpoint || !supports("1.8")) return refuse(needsNewer);
      const expected = selected;
      if (!expected) return refuse(selectionChanged);
      try {
        const image = await replacementImage(png, json, size);
        const current = await readSelection();
        if (current.kind !== "structure" || current.key !== expected.key || current.json !== expected.json ||
            selected !== expected) return refuse(selectionChanged);
        if (current.updateRefusal) return refuse(current.updateRefusal);
        const canRotate = supports("1.10");
        const original = await powerpoint.run(async context => {
          const active = await selectedSlideShape(context);
          if (!active || JSON.stringify([active.slide.id, active.shape.id]) !== expected.key) throw new Error(selectionChanged);
          const { slide, shape } = active;
          const all = slide.shapes.load("items/id");
          shape.load("name,left,top,width,height,zOrderPosition" + (canRotate ? ",rotation" : ""));
          shape.tags.load("items/key,items/value");
          await context.sync();
          const ids = new Set(all.items.map(item => item.id));
          if (!ids.has(shape.id)) throw new Error(grouped);
          if (canRotate && (!Number.isFinite(shape.rotation) ||
              (shape.rotation && !writableProperty(shape, "rotation")))) throw new Error(needsRotation);
          return {
            slideId: slide.id, id: shape.id, ids, left: shape.left, top: shape.top, width: shape.width,
            name: shape.name, rotation: canRotate ? shape.rotation : undefined,
            zOrder: shape.zOrderPosition, tags: shape.tags.items.map(({ key, value }) => ({ key, value })),
          };
        });
        if (selected !== expected) return refuse(selectionChanged);
        const height = original.width * image.aspect;
        if (![original.left, original.top, original.width, height].every(Number.isFinite) || original.width <= 0 || height <= 0) {
          throw new Error("The replacement PowerPoint picture has invalid dimensions.");
        }
        // Office.js exposes no PowerPoint undo group that spans Common API image insertion and
        // requirement-set shape operations. The Mac probe measured three undo steps.
        await officeAsync<void>(done => office.document.setSelectedDataAsync(image.base64, {
          coercionType: "image", imageLeft: original.left, imageTop: original.top,
          imageWidth: original.width, imageHeight: height,
        }, done));
        await powerpoint.run(async context => {
          const slide = context.presentation.slides.getItem(original.slideId);
          const shapes = slide.shapes.load("items/id,items/type,items/zOrderPosition");
          await context.sync();
          const added = shapes.items.filter(shape => !original.ids.has(shape.id));
          if (added.length !== 1 || added[0]!.type !== "Image") {
            throw new Error("The new picture could not be identified. Check the slide before retrying.");
          }
          const inserted = added[0]!;
          const old = shapes.items.find(shape => shape.id === original.id);
          let deletionRequested = false;
          try {
            if (!old || shapes.items.length !== original.ids.size + 1) throw new Error("The slide changed during the update.");
            const delta = old.zOrderPosition + Number(inserted.zOrderPosition > old.zOrderPosition) - inserted.zOrderPosition;
            const direction = delta > 0 ? "BringForward" : "SendBackward";
            if (original.rotation) {
              if (!writableProperty(inserted, "rotation")) throw new Error(needsRotation);
              inserted.rotation = original.rotation;
            }
            const canRename = writableProperty(inserted, "name");
            if (canRename) inserted.name = original.name;
            for (const { key, value } of original.tags) {
              if (key.toUpperCase() !== marker) inserted.tags.add(key, value);
            }
            inserted.tags.add(marker, "1");
            for (let step = 0; step < Math.abs(delta); step++) inserted.setZOrder(direction);
            inserted.load("zOrderPosition,left,top,width,height" + (canRename ? ",name" : "") + (canRotate ? ",rotation" : ""));
            inserted.tags.load("items/key,items/value");
            old.load("zOrderPosition");
            await context.sync();
            if (inserted.zOrderPosition !== old.zOrderPosition + 1 || old.zOrderPosition !== original.zOrder) {
              throw new Error("PowerPoint could not preserve the picture’s stacking order.");
            }
            if ([[inserted.left, original.left], [inserted.top, original.top], [inserted.width, original.width],
              [inserted.height, height]].some(([actual, expected]) => !Number.isFinite(actual) || Math.abs(actual! - expected!) > 0.05)) {
              throw new Error("PowerPoint could not preserve the picture’s placement or size.");
            }
            const tags = new Map(inserted.tags.items.map(({ key, value }) => [key.toUpperCase(), value]));
            if (tags.get(marker) !== "1" || original.tags.some(({ key, value }) => key.toUpperCase() !== marker &&
                tags.get(key.toUpperCase()) !== value)) throw new Error("PowerPoint could not preserve the picture’s tags.");
            if (canRename && inserted.name !== original.name) throw new Error("PowerPoint could not preserve the picture’s name.");
            if (canRotate && (!Number.isFinite(inserted.rotation) || Math.abs(inserted.rotation! - original.rotation!) > 0.01)) {
              throw new Error("PowerPoint could not preserve the picture’s rotation.");
            }
            deletionRequested = true;
            old.delete();
            await context.sync();
          } catch (error) {
            if (deletionRequested) throw new Error(errorMessage(error) + " Check the slide before retrying.");
            try {
              inserted.delete();
              await context.sync();
            } catch {
              throw new Error(errorMessage(error) + " The newly inserted picture may remain on the slide.");
            }
            throw error;
          }
        });
        return { kind: "replaced" };
      } catch (error) {
        return refuse("Could not replace the PowerPoint picture. " + errorMessage(error));
      }
    },
  };
}
