import { pptxSlidePictureMedia, readZipFromBase64, type OfficeZipEntry } from "@chemdraft/clipboard-adapter";
import {
  errorMessage, noStructure, officeAsync, readCarrier, readOfficeDocument, refuse, replacementImage, selectionChanged,
  type NoStructure, type OfficeContext, type OfficeHostAdapter, type Refusal, type SelectedStructure,
} from "./host";
import { A, P, PKG_REL, R, child, children, decodeXml, hasCrop, relationshipPart, xmlDocument } from "./ooxml";

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
  // PowerPointApi 1.10; feature-detected with writableProperty before use.
  altTextTitle?: string;
  altTextDescription?: string;
  isDecorative?: boolean;
  setHyperlink?(options: { address: string; screenTip?: string }): unknown;
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
const DECORATIVE = "http://schemas.microsoft.com/office/drawing/2017/decorative";

/**
 * Shape state read from the slide XML. Office.js cannot read most of it, so the XML is the only way to
 * know whether the old picture carries something the insert-and-delete replacement would lose.
 */
export interface PictureState {
  altTextTitle: string;
  altTextDescription: string;
  isDecorative: boolean;
  /** A plain click hyperlink to an external address, which PowerPointApi 1.10 can write back. */
  link?: { address: string; screenTip?: string };
  /** State no Office.js API can write; named in the warning shown after Update. */
  lost: string[];
}

const on = (value: string | null) => value === "1" || value === "true";

function pictureState(doc: Document, shape: Element, properties: Element, rels: Element, shapeId: string): PictureState {
  const lost: string[] = [];
  const timing = child(doc.documentElement, P, "timing");
  if (timing && [...timing.getElementsByTagName("*")].some(node => node.getAttribute("spid") === shapeId)) {
    lost.push("animations");
  }
  let link: PictureState["link"];
  const click = child(properties, A, "hlinkClick");
  if (click) {
    const action = click.getAttribute("action") ?? "";
    const id = click.getAttributeNS(R, "id") ?? "";
    const targets = children(rels, PKG_REL, "Relationship").filter(rel => rel.getAttribute("Id") === id);
    const target = targets.length === 1 && targets[0]!.getAttribute("TargetMode") === "External"
      ? targets[0]!.getAttribute("Target") ?? "" : "";
    if (!action && target) link = { address: target, screenTip: click.getAttribute("tooltip") ?? undefined };
    else if (action || id) lost.push(action && !action.startsWith("ppaction://hlink") ? "its action setting" : "its link");
  }
  if (child(properties, A, "hlinkHover")) lost.push("its mouse-over action");
  if (on(properties.getAttribute("hidden"))) lost.push("its hidden setting");
  const locks = child(child(child(shape, P, "nvPicPr"), P, "cNvPicPr"), A, "picLocks");
  if (locks && [...locks.attributes].some(attribute => attribute.name !== "noChangeAspect" && on(attribute.value))) {
    lost.push("its locks");
  }
  const spPr = child(shape, P, "spPr");
  const line = child(spPr, A, "ln");
  const outlined = line && children(line, A, "noFill").length === 0 &&
    ["solidFill", "gradFill", "pattFill"].some(fill => children(line, A, fill).length > 0);
  const effects = ["effectLst", "effectDag", "scene3d", "sp3d"].some(name => {
    const effect = child(spPr, A, name);
    return effect && (name !== "effectLst" || effect.children.length > 0);
  });
  if (outlined || effects || child(shape, P, "style")) lost.push("its border and effects");
  const blip = child(child(shape, P, "blipFill"), A, "blip");
  if (blip && [...blip.children].some(node => node.localName !== "extLst")) lost.push("its color adjustments");
  return {
    altTextTitle: properties.getAttribute("title") ?? "",
    altTextDescription: properties.getAttribute("descr") ?? "",
    isDecorative: [...properties.getElementsByTagNameNS(DECORATIVE, "decorative")].some(node => on(node.getAttribute("val"))),
    link,
    lost,
  };
}

export function lostStateWarning(lost: string[]) {
  return lost.length ? "Not carried over from the old picture: " + lost.join(", ") + "." : undefined;
}

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
  const relsXml = decodeXml(rels.data);
  const media = pptxSlidePictureMedia(xml, relsXml, shapeId);
  const carrier = await readCarrier(entries.find(entry => entry.name === media)?.data);
  if (carrier.kind !== "found") return carrier;
  const state = pictureState(doc, shape, properties[0]!, xmlDocument(relsXml).documentElement, shapeId);
  return { kind: "picture" as const, json: carrier.json, rotation, state };
}

type Selection = NoStructure | Refusal | (SelectedStructure & { state: PictureState });
type Placement = { left: number; top: number; width: number; height: number };
const altText = ["altTextTitle", "altTextDescription", "isDecorative"] as const;

/**
 * Removes the picture an Update inserted, in a fresh batch so a failed batch cannot block it. The
 * picture is found by its ID when the update got that far, otherwise as the one new picture at the
 * placement the insert was asked for.
 */
async function removeInserted(
  powerpoint: PowerPointApi, slideId: string, ids: Set<string>, insertedId: string | undefined, placement: Placement,
) {
  return powerpoint.run(async context => {
    const shapes = context.presentation.slides.getItem(slideId).shapes
      .load("items/id,items/type,items/left,items/top,items/width,items/height");
    await context.sync();
    const added = shapes.items.filter(shape => !ids.has(shape.id));
    const matches = insertedId !== undefined ? added.filter(shape => shape.id === insertedId) : added.filter(shape =>
      (shape.type === "Image" || shape.type === "Graphic") &&
      (["left", "top", "width", "height"] as const).every(key => Math.abs(shape[key] - placement[key]) <= 0.5));
    if (matches.length !== 1) return false;
    matches[0]!.delete();
    await context.sync();
    return true;
  });
}

function writableProperty(value: object, property: string) {
  for (let target: object | null = value; target; target = Object.getPrototypeOf(target)) {
    const descriptor = Object.getOwnPropertyDescriptor(target, property);
    if (descriptor) return descriptor.set !== undefined || descriptor.writable === true;
  }
  return false;
}

export function powerpointAdapter(office: OfficeContext, powerpoint: PowerPointApi | undefined): OfficeHostAdapter {
  let selected: Extract<Selection, { kind: "structure" }> | undefined;
  let reading = 0;
  const supports = (version: string) => office.requirements.isSetSupported(api, version);
  async function readSelection(): Promise<Selection> {
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
    return { kind: "structure", key: JSON.stringify([slideId, shapeId]), json: picture.json, updateRefusal, state: picture.state };
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
        const placement = { left: original.left, top: original.top, width: original.width, height };
        const { state } = current;
        const lost = [...state.lost];
        // Office.js exposes no PowerPoint undo group that spans Common API image insertion and
        // requirement-set shape operations. The Mac probe measured three undo steps.
        await officeAsync<void>(done => office.document.setSelectedDataAsync(image.base64, {
          coercionType: "image", imageLeft: placement.left, imageTop: placement.top,
          imageWidth: placement.width, imageHeight: placement.height,
        }, done));
        // From here on a picture has been inserted: every failure before the old one is deleted removes it.
        let insertedId: string | undefined;
        let deletionRequested = false;
        try {
          await powerpoint.run(async context => {
            const slide = context.presentation.slides.getItem(original.slideId);
            const shapes = slide.shapes.load("items/id,items/type,items/zOrderPosition");
            await context.sync();
            const added = shapes.items.filter(shape => !original.ids.has(shape.id));
            if (added.length !== 1 || added[0]!.type !== "Image") throw new Error("The new picture could not be identified.");
            const inserted = added[0]!;
            insertedId = inserted.id;
            const old = shapes.items.find(shape => shape.id === original.id);
            if (!old || shapes.items.length !== original.ids.size + 1) throw new Error("The slide changed during the update.");
            const delta = old.zOrderPosition + Number(inserted.zOrderPosition > old.zOrderPosition) - inserted.zOrderPosition;
            const direction = delta > 0 ? "BringForward" : "SendBackward";
            if (original.rotation) {
              if (!writableProperty(inserted, "rotation")) throw new Error(needsRotation);
              inserted.rotation = original.rotation;
            }
            const canRename = writableProperty(inserted, "name");
            if (canRename) inserted.name = original.name;
            // Alt text and the decorative flag (PowerPointApi 1.10) are written whenever the host can,
            // so the new picture never keeps alt text PowerPoint generated for it.
            const altWritable = supports("1.10") ? altText.filter(key => writableProperty(inserted, key)) : [];
            if (altWritable.includes("altTextTitle")) inserted.altTextTitle = state.altTextTitle;
            if (altWritable.includes("altTextDescription")) inserted.altTextDescription = state.altTextDescription;
            if (altWritable.includes("isDecorative")) inserted.isDecorative = state.isDecorative;
            if ((state.altTextTitle || state.altTextDescription) &&
                !(altWritable.includes("altTextTitle") && altWritable.includes("altTextDescription"))) lost.push("its alt text");
            if (state.isDecorative && !altWritable.includes("isDecorative")) lost.push("its decorative setting");
            for (const { key, value } of original.tags) {
              if (key.toUpperCase() !== marker) inserted.tags.add(key, value);
            }
            inserted.tags.add(marker, "1");
            for (let step = 0; step < Math.abs(delta); step++) inserted.setZOrder(direction);
            inserted.load(["zOrderPosition,left,top,width,height", ...(canRename ? ["name"] : []),
              ...(canRotate ? ["rotation"] : []), ...altWritable].join(","));
            inserted.tags.load("items/key,items/value");
            old.load("zOrderPosition");
            await context.sync();
            if (inserted.zOrderPosition !== old.zOrderPosition + 1 || old.zOrderPosition !== original.zOrder) {
              throw new Error("PowerPoint could not preserve the picture’s stacking order.");
            }
            if ([[inserted.left, placement.left], [inserted.top, placement.top], [inserted.width, placement.width],
              [inserted.height, placement.height]].some(([actual, expected]) => !Number.isFinite(actual) || Math.abs(actual! - expected!) > 0.05)) {
              throw new Error("PowerPoint could not preserve the picture’s placement or size.");
            }
            const tags = new Map(inserted.tags.items.map(({ key, value }) => [key.toUpperCase(), value]));
            if (tags.get(marker) !== "1" || original.tags.some(({ key, value }) => key.toUpperCase() !== marker &&
                tags.get(key.toUpperCase()) !== value)) throw new Error("PowerPoint could not preserve the picture’s tags.");
            if (canRename && inserted.name !== original.name) throw new Error("PowerPoint could not preserve the picture’s name.");
            if (canRotate && (!Number.isFinite(inserted.rotation) || Math.abs(inserted.rotation! - original.rotation!) > 0.01)) {
              throw new Error("PowerPoint could not preserve the picture’s rotation.");
            }
            const altChanged = (key: "altTextTitle" | "altTextDescription") =>
              altWritable.includes(key) && (inserted[key] ?? "") !== state[key];
            if ((altWritable.includes("isDecorative") && inserted.isDecorative !== state.isDecorative) ||
                (!state.isDecorative && (altChanged("altTextTitle") || altChanged("altTextDescription")))) {
              throw new Error("PowerPoint could not preserve the picture’s alt text.");
            }
            if (state.link) {
              // Office.js cannot read a shape's hyperlink back, so a failed write is reported, not verified.
              if (supports("1.10") && typeof inserted.setHyperlink === "function") {
                try {
                  inserted.setHyperlink(state.link);
                  await context.sync();
                } catch {
                  lost.push("its link");
                }
              } else {
                lost.push("its link");
              }
            }
            deletionRequested = true;
            old.delete();
            await context.sync();
          });
        } catch (error) {
          if (deletionRequested) throw new Error(errorMessage(error) + " Check the slide before retrying.");
          const removed = await removeInserted(powerpoint, original.slideId, original.ids, insertedId, placement)
            .catch(() => false);
          if (!removed) throw new Error(errorMessage(error) + " The newly inserted picture may remain on the slide.");
          throw error;
        }
        const warning = lostStateWarning(lost);
        return warning ? { kind: "replaced", warnings: [warning] } : { kind: "replaced" };
      } catch (error) {
        return refuse("Could not replace the PowerPoint picture. " + errorMessage(error));
      }
    },
  };
}
