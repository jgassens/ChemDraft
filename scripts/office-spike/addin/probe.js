import { checkArchiveLength, decodeBase64, extractBinaryParts, findSlidePictureMedia, MAX_ARCHIVE_BYTES, readZip } from "./zip.js";

const status = document.querySelector("#status");
const routes = document.querySelector("#routes");
const results = document.querySelector("#results");
const copy = document.querySelector("#copy");
const rows = [];
const utf8 = new TextEncoder();
const xmlText = new TextDecoder();
const FILE_SLICE_BYTES = 1024 * 1024;

function requireSet(set, version = "1.1") {
  if (!Office.context.requirements.isSetSupported(set, version)) {
    throw new Error(`unsupported: ${set} ${version}`);
  }
}

function officeAsync(call) {
  return new Promise((resolve, reject) => call((result) => {
    if (result.status === Office.AsyncResultStatus.Succeeded) resolve(result.value);
    else reject(new Error(result.error?.message ?? "Office callback failed"));
  }));
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function only(items, description) {
  if (items.length !== 1) throw new Error(`Expected one ${description}, found ${items.length}`);
  return items[0];
}

function base64(bytes) {
  let binary = "";
  for (let start = 0; start < bytes.length; start += 8192) {
    binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
  }
  return btoa(binary);
}

async function replacement(evidence) {
  const response = await fetch(new URL("./test-replacement.png", import.meta.url));
  if (!response.ok) throw new Error(`Replacement PNG request failed (HTTP ${response.status})`);
  evidence.bytes = new Uint8Array(await response.arrayBuffer());
  evidence.details.byteSource = "replacement input PNG";
  return base64(evidence.bytes);
}

async function listDocumentMedia(evidence, prefix) {
  requireSet("CompressedFile");
  const file = await officeAsync((done) => Office.context.document.getFileAsync(
    Office.FileType.Compressed, { sliceSize: FILE_SLICE_BYTES }, done,
  ));
  let bytes;
  try {
    evidence.details.archiveByteLength = file.size;
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > MAX_ARCHIVE_BYTES) {
      throw new Error("Compressed Office file has invalid size or exceeds 200 MB");
    }
    if (!Number.isSafeInteger(file.sliceCount) || file.sliceCount < 1 || file.sliceCount > file.size) {
      throw new Error("Compressed Office file has an invalid slice count");
    }
    bytes = new Uint8Array(file.size);
    let offset = 0;
    for (let index = 0; index < file.sliceCount; index++) {
      const slice = await officeAsync((done) => file.getSliceAsync(index, done));
      const data = Uint8Array.from(slice.data);
      if (slice.index !== index || data.length !== slice.size || !data.length ||
          data.length > bytes.length - offset) throw new Error(`Invalid Office file slice ${index}`);
      bytes.set(data, offset);
      offset += data.length;
    }
    if (offset !== bytes.length) throw new Error("Office file slices did not fill the reported file size");
  } finally {
    try {
      await officeAsync((done) => file.closeAsync(done));
    } catch (error) {
      evidence.details.closeError = errorText(error);
    }
  }
  const media = (await readZip(bytes)).filter(({ name }) => name.startsWith(prefix) && !name.endsWith("/"));
  if (!media.length) throw new Error(`The Office file contains no ${prefix} entries`);
  for (const { name, data } of media) evidence.add(data, { part: name });
}

async function wordSelectionOoxml(evidence) {
  requireSet("WordApi");
  const xml = await Word.run(async (context) => {
    const file = context.document.getSelection().getOoxml();
    await context.sync();
    return file.value;
  });
  const pictures = extractBinaryParts(xml).filter(({ name, contentType }) =>
    name.startsWith("/word/media/") || contentType.startsWith("image/"));
  if (!pictures.length) throw new Error("The selection OOXML contains no picture binary parts");
  for (const { name, contentType, bytes } of pictures) evidence.add(bytes, { part: name, contentType });
}

async function wordInlineImages(evidence) {
  requireSet("WordApi", "1.2");
  evidence.details.byteSource = "InlinePicture image API control";
  await Word.run(async (context) => {
    const pictures = context.document.getSelection().inlinePictures.load("items");
    await context.sync();
    if (!pictures.items.length) throw new Error("Select at least one inline picture");
    const images = pictures.items.map((picture) => picture.getBase64ImageSrc());
    await context.sync();
    for (const [index, image] of images.entries()) {
      if (!image.value) throw new Error(`Inline picture ${index + 1} returned no base64 image`);
      evidence.add(decodeBase64(image.value), { picture: index + 1 });
    }
  });
}

function wordSize(picture) {
  return { width: picture.width, height: picture.height, units: "pt" };
}

async function wordReplaceInline(evidence) {
  requireSet("WordApi", "1.2");
  const png = await replacement(evidence);
  await Word.run(async (context) => {
    const selection = context.document.getSelection();
    const pictures = selection.inlinePictures.load("items/width,items/height");
    await context.sync();
    evidence.details.before = wordSize(only(pictures.items, "selected inline picture"));
    const inserted = selection.insertInlinePictureFromBase64(png, "Replace").load("width,height");
    evidence.details.stage = "replacement requested";
    await context.sync();
    evidence.details.after = wordSize(inserted);
    evidence.details.stage = "replacement measured";
  });
}

const OPC = "http://schemas.microsoft.com/office/2006/xmlPackage";
const WORD = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WORD_DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const DRAWING = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const RELS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELS = "http://schemas.openxmlformats.org/package/2006/relationships";

function wordDrawing(flatOpc) {
  const xml = new DOMParser().parseFromString(flatOpc, "application/xml");
  if (xml.getElementsByTagName("parsererror").length) throw new Error("Invalid Word selection OOXML");
  const drawing = only([...xml.getElementsByTagNameNS(WORD, "drawing")], "selected Word drawing");
  const placement = only([...drawing.children].filter((child) =>
    child.namespaceURI === WORD_DRAWING && ["inline", "anchor"].includes(child.localName)), "drawing placement");
  const extent = only([...placement.getElementsByTagNameNS(WORD_DRAWING, "extent")], "drawing size");
  const cx = extent.getAttribute("cx");
  const cy = extent.getAttribute("cy");
  if (![cx, cy].every((value) => /^\d+$/.test(value) && Number(value) > 0)) {
    throw new Error("Selected drawing has an invalid size");
  }
  const picture = only([...placement.getElementsByTagNameNS(PIC, "pic")], "picture in the drawing");
  const blip = only([...picture.getElementsByTagNameNS(DRAWING, "blip")], "picture image reference");
  const position = (axis) => {
    const node = placement.getElementsByTagNameNS(WORD_DRAWING, `position${axis}`)[0];
    if (!node) return null;
    const value = node.firstElementChild;
    return { relativeFrom: node.getAttribute("relativeFrom"), kind: value?.localName, value: value?.textContent };
  };
  const state = {
    width: Number(cx) / 12700,
    height: Number(cy) / 12700,
    units: "pt",
    placement: placement.localName,
    wrapping: [...placement.children].find((child) => child.localName.startsWith("wrap"))?.localName ?? null,
    horizontal: position("H"),
    vertical: position("V"),
  };
  return { drawing, blip, state };
}

function replacementOoxml({ drawing, blip }, png) {
  blip.removeAttributeNS(RELS, "link");
  blip.setAttributeNS(RELS, "r:embed", "rIdImage");
  for (const element of [drawing, ...drawing.getElementsByTagName("*")]) {
    if ([...element.attributes].some((attr) => attr.namespaceURI === RELS &&
        !(element === blip && attr.localName === "embed"))) {
      throw new Error("Selected drawing needs additional relationship parts");
    }
  }
  const drawingXml = new XMLSerializer().serializeToString(drawing);
  const relationshipType = "application/vnd.openxmlformats-package.relationships+xml";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<pkg:package xmlns:pkg="${OPC}">
  <pkg:part pkg:name="/_rels/.rels" pkg:contentType="${relationshipType}">
    <pkg:xmlData><Relationships xmlns="${PACKAGE_RELS}">
      <Relationship Id="rIdDocument" Type="${RELS}/officeDocument" Target="word/document.xml"/>
    </Relationships></pkg:xmlData>
  </pkg:part>
  <pkg:part pkg:name="/word/document.xml"
            pkg:contentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml">
    <pkg:xmlData><w:document xmlns:w="${WORD}"><w:body><w:p><w:r>
      ${drawingXml}
    </w:r></w:p></w:body></w:document></pkg:xmlData>
  </pkg:part>
  <pkg:part pkg:name="/word/_rels/document.xml.rels" pkg:contentType="${relationshipType}">
    <pkg:xmlData><Relationships xmlns="${PACKAGE_RELS}">
      <Relationship Id="rIdImage" Type="${RELS}/image" Target="media/replacement.png"/>
    </Relationships></pkg:xmlData>
  </pkg:part>
  <pkg:part pkg:name="/word/media/replacement.png" pkg:contentType="image/png">
    <pkg:binaryData>${png}</pkg:binaryData>
  </pkg:part>
</pkg:package>`;
}

async function wordReplaceOoxml(evidence) {
  requireSet("WordApi");
  const png = await replacement(evidence);
  await Word.run(async (context) => {
    const selection = context.document.getSelection();
    const original = selection.getOoxml();
    await context.sync();
    const before = wordDrawing(original.value);
    evidence.details.before = before.state;
    const ooxml = replacementOoxml(before, png);
    const after = selection.insertOoxml(ooxml, "Replace").getOoxml();
    evidence.details.stage = "replacement requested";
    await context.sync();
    evidence.details.after = wordDrawing(after.value).state;
    evidence.details.stage = "replacement measured";
  });
}

const SHAPE_FIELDS = "id,name,type,left,top,width,height";
const POWERPOINT_API = "PowerPointApi";
const Z_ORDER_VERSION = "1.8";

function loadShape(shape, zOrder = true) {
  let fields = SHAPE_FIELDS;
  if (zOrder) fields += ",zOrderPosition";
  if (Office.context.requirements.isSetSupported(POWERPOINT_API, "1.10")) fields += ",rotation";
  shape.load(fields);
  shape.tags.load("items/key,items/value");
}

function shapeState(shape, zOrder = true) {
  const { id, name, type, left, top, width, height } = shape;
  return {
    id, name, type, left, top, width, height,
    rotation: Office.context.requirements.isSetSupported(POWERPOINT_API, "1.10") ? shape.rotation : null,
    zOrderPosition: zOrder ? shape.zOrderPosition : "unavailable (needs PowerPointApi 1.8)",
    tags: shape.tags.items.map(({ key, value }) => ({ key, value })),
  };
}

async function selectedShapes(context) {
  const shapes = context.presentation.getSelectedShapes().load("items/id");
  await context.sync();
  if (!shapes.items.length) throw new Error("Select a shape on the slide");
  return shapes.items;
}

async function selectedSlide(context) {
  const slides = context.presentation.getSelectedSlides().load("items/id");
  await context.sync();
  if (!slides.items.length) throw new Error("Office returned no active slide for the selected shape");
  return slides.items[0];
}

async function powerpointShapeDetails(evidence) {
  requireSet(POWERPOINT_API, "1.5");
  const hasZOrder = Office.context.requirements.isSetSupported(POWERPOINT_API, Z_ORDER_VERSION);
  await PowerPoint.run(async (context) => {
    const shapes = await selectedShapes(context);
    for (const shape of shapes) loadShape(shape, hasZOrder);
    await context.sync();
    evidence.details.shapes = shapes.map((shape) => shapeState(shape, hasZOrder));
    evidence.details.byteSource = "UTF-8 JSON of shapes";
    evidence.bytes = utf8.encode(JSON.stringify(evidence.details.shapes));
  });
}

async function powerpointSlideExport(evidence) {
  requireSet(POWERPOINT_API, "1.8");
  const exported = await PowerPoint.run(async (context) => {
    const shapes = await selectedShapes(context);
    const slide = await selectedSlide(context);
    const result = slide.exportAsBase64();
    await context.sync();
    return { shapeIds: shapes.map((shape) => shape.id), slideId: slide.id, base64: result.value };
  });
  evidence.details.slideId = exported.slideId;
  checkArchiveLength(exported.base64.length, true);
  const bytes = decodeBase64(exported.base64);
  checkArchiveLength(bytes.length);
  evidence.details.archiveByteLength = bytes.length;
  const entries = await readZip(bytes);
  const slide = only(entries.filter(({ name }) => /^ppt\/slides\/[^/]+\.xml$/.test(name)), "exported slide XML part");
  const slideName = slide.name.slice("ppt/slides/".length);
  const relsPath = `ppt/slides/_rels/${slideName}.rels`;
  const rels = entries.find(({ name }) => name === relsPath);
  if (!rels) throw new Error(`Missing exported slide relationships: ${relsPath}`);
  const slideXml = xmlText.decode(slide.data);
  const relsXml = xmlText.decode(rels.data);
  for (const shapeId of exported.shapeIds) {
    const part = findSlidePictureMedia(slideXml, relsXml, shapeId);
    const entry = entries.find(({ name }) => name === part);
    if (entry) evidence.add(entry.data, { shapeId, part });
    else evidence.add(null, { shapeId, part }, part ? `Missing exported picture part: ${part}` :
      `No embedded picture with ID ${shapeId} in ${slide.name}`);
  }
}

async function powerpointFill(evidence) {
  requireSet(POWERPOINT_API, Z_ORDER_VERSION);
  const png = await replacement(evidence);
  await PowerPoint.run(async (context) => {
    const shape = only(await selectedShapes(context), "selected shape");
    loadShape(shape);
    await context.sync();
    evidence.details.before = shapeState(shape);
    shape.fill.setImage(png);
    evidence.details.stage = "fill change requested";
    loadShape(shape);
    await context.sync();
    evidence.details.after = shapeState(shape);
    evidence.details.stage = "fill change measured";
  });
}

async function powerpointInsertDelete(evidence) {
  requireSet(POWERPOINT_API, Z_ORDER_VERSION);
  requireSet("ImageCoercion");
  const png = await replacement(evidence);
  const original = await PowerPoint.run(async (context) => {
    const shape = only(await selectedShapes(context), "selected shape");
    const slide = await selectedSlide(context);
    loadShape(shape);
    slide.shapes.load("items/id");
    await context.sync();
    const existing = new Set(slide.shapes.items.map(({ id }) => id));
    evidence.details.before = shapeState(shape);
    if (!existing.has(shape.id)) throw new Error("Select a top-level shape for insert and delete");
    return { slideId: slide.id, existing, before: evidence.details.before };
  });

  const { left, top, width, height } = original.before;
  const selectedDataOptions = {
    coercionType: Office.CoercionType.Image,
    imageLeft: left,
    imageTop: top,
    imageWidth: width,
    imageHeight: height,
  };
  await officeAsync((done) => Office.context.document.setSelectedDataAsync(png, selectedDataOptions, done));
  evidence.details.stage = "image inserted";

  await PowerPoint.run(async (context) => {
    const slide = context.presentation.slides.getItem(original.slideId);
    slide.shapes.load("items/id,items/zOrderPosition");
    await context.sync();
    const inserted = only(slide.shapes.items.filter(({ id }) => !original.existing.has(id)), "new slide shape");
    const old = slide.shapes.items.find(({ id }) => id === original.before.id);
    evidence.details.insertedId = inserted.id;
    if (!old) throw new Error("Original shape disappeared after image insertion");

    // Place the new shape directly above the old one so deleting the old shape
    // moves the new one to the original index.
    const target = old.zOrderPosition + Number(inserted.zOrderPosition > old.zOrderPosition);
    const delta = target - inserted.zOrderPosition;
    const operation = delta > 0 ? "BringForward" : "SendBackward";
    for (let step = 0; step < Math.abs(delta); step++) inserted.setZOrder(operation);
    for (const { key, value } of original.before.tags) inserted.tags.add(key, value);
    old.load("zOrderPosition");
    loadShape(inserted);
    evidence.details.stage = "z-order and tag changes requested";
    await context.sync();
    evidence.details.insertedBeforeDelete = shapeState(inserted);
    if (inserted.zOrderPosition !== old.zOrderPosition + 1 ||
        old.zOrderPosition !== original.before.zOrderPosition) {
      throw new Error("Could not restore the original stacking position. Both shapes remain on the slide.");
    }
    const tags = new Map(evidence.details.insertedBeforeDelete.tags.map(({ key, value }) => [key, value]));
    if (original.before.tags.some(({ key, value }) => tags.get(key) !== value)) {
      throw new Error("Could not copy the original tags. Both shapes remain on the slide.");
    }
    old.delete();
    loadShape(inserted);
    evidence.details.stage = "original deletion requested";
    await context.sync();
    const after = shapeState(inserted);
    evidence.details.after = after;
    const { tags: beforeTags, ...beforeFields } = original.before;
    const afterTags = new Map(after.tags.map(({ key, value }) => [key, value]));
    evidence.details.changed = Object.keys(beforeFields).filter((key) => beforeFields[key] !== after[key]);
    if (beforeTags.length !== afterTags.size || beforeTags.some(({ key, value }) => afterTags.get(key) !== value)) {
      evidence.details.changed.push("tags");
    }
    evidence.details.stage = "insert and delete measured";
  });
}

const WORD_ROUTES = [
  ["a", "getOoxml", "Read selection OOXML", wordSelectionOoxml],
  ["b", "InlinePicture.getBase64ImageSrc", "Read inline image control", wordInlineImages],
  ["c", "getFileAsync(Compressed DOCX)", "List DOCX media", (probe) => listDocumentMedia(probe, "word/media/")],
  ["d", "insertInlinePictureFromBase64(Replace)", "Replace inline picture", wordReplaceInline],
  ["e", "insertOoxml(Replace)", "Replace through OOXML", wordReplaceOoxml],
];
const POWERPOINT_ROUTES = [
  ["f", "getSelectedShapes", "Inspect selected shapes", powerpointShapeDetails],
  ["g", "slide.exportAsBase64", "Read pictures from slide export", powerpointSlideExport],
  ["h", "getFileAsync(Compressed PPTX)", "List PPTX media", (probe) => listDocumentMedia(probe, "ppt/media/")],
  ["i", "shape.fill.setImage", "Replace picture fill", powerpointFill],
  ["j", "setSelectedDataAsync + setZOrder + delete", "Insert and delete picture", powerpointInsertDelete],
];

async function appendResult(info, route, bytes, details, error = null) {
  let sha256 = null;
  if (bytes !== null) {
    try {
      const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
      sha256 = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
    } catch (cause) {
      error = [error, `SHA-256 failed: ${errorText(cause)}`].filter(Boolean).join(" | ");
    }
  }
  const row = {
    ...info, route, status: error ? "failed" : "ok", byteLength: bytes?.byteLength ?? null, sha256, error, details,
  };
  rows.push(row);
  copy.disabled = false;
  const item = document.createElement("li");
  const title = document.createElement("strong");
  const detail = document.createElement("pre");
  title.textContent = `${route} · ${row.status}`;
  detail.textContent = JSON.stringify({ byteLength: row.byteLength, sha256, error, ...details }, null, 2);
  item.append(title, detail);
  results.append(item);
}

async function runRoute(info, route, action) {
  const buttons = [...routes.querySelectorAll("button")];
  for (const button of buttons) button.disabled = true;
  status.textContent = `Running ${route}…`;
  const parts = [];
  const evidence = {
    bytes: null,
    details: {},
    add: (bytes, details, error = null) => parts.push({ bytes, details, error }),
  };
  const context = { ...info, runAt: new Date().toISOString() };
  try {
    let error = null;
    try {
      await action(evidence);
    } catch (cause) {
      error = errorText(cause);
    }
    for (const part of parts) {
      await appendResult(context, route, part.bytes, { ...evidence.details, ...part.details }, part.error);
    }
    if (!parts.length || error) await appendResult(context, route, evidence.bytes, evidence.details, error);
  } finally {
    status.textContent = `Office.js ready · ${info.host}`;
    for (const button of buttons) button.disabled = false;
  }
}

copy.addEventListener("click", async () => {
  const message = document.querySelector("#copy-status");
  const textarea = document.querySelector("#copy-text");
  const text = JSON.stringify(rows, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    textarea.hidden = true;
    message.textContent = "Results copied.";
  } catch {
    textarea.value = text;
    textarea.hidden = false;
    textarea.focus();
    textarea.select();
    if (document.execCommand?.("copy")) {
      textarea.hidden = true;
      message.textContent = "Results copied.";
    } else {
      message.textContent = "Copy the selected JSON with Cmd+C or Ctrl+C.";
    }
  }
});

async function initialize() {
  let timer;
  try {
    const officeReady = new Promise((resolve, reject) => {
      const start = () => {
        try {
          Office.onReady().then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      };
      if (globalThis.Office?.onReady) start();
      else document.querySelector("#office-js").addEventListener("load", start, { once: true });
    });
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Office.onReady did not resolve within 10 seconds.")), 10_000);
    });
    const { host, platform } = await Promise.race([officeReady, timeout]);
    const hostRoutes = host === Office.HostType.Word ? WORD_ROUTES :
      host === Office.HostType.PowerPoint ? POWERPOINT_ROUTES : null;
    if (!hostRoutes) throw new Error("Open this task pane in Word or PowerPoint.");
    const info = { host, platform, officeVersion: Office.context.diagnostics?.version ?? null };
    status.textContent = `Office.js ready · ${host}`;
    for (const [letter, name, label, action] of hostRoutes) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = `${letter.toUpperCase()}. ${label}`;
      button.addEventListener("click", () => runRoute(info, `${letter} ${name}`, action));
      routes.append(button);
    }
  } catch (error) {
    status.textContent = errorText(error);
    status.setAttribute("role", "alert");
  } finally {
    clearTimeout(timer);
  }
}

initialize();
