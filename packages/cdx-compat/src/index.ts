import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  ChemDraftDocumentSchema,
  DocumentSchemaVersion,
  createEmptyDocument,
  deserializeDocument,
  parseDocument,
  serializeDocument,
  type Anchor,
  type ArrowObject,
  type BondRef,
  type ChemDraftDocument,
  type CompatibilityWarning,
  type CrossingOverride,
  type DocumentObject,
  type DocumentPage,
  type GraphicObject,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type Point,
  type TextObject
} from "@chemdraft/chem-core";
import { sha256Hex, utf8Bytes, utf8String } from "./sha256";

export interface CompatibilityConversionWarning {
  code: string;
  message: string;
  sourceObjectId?: string;
}

export interface CdxmlExportOptions {
  creationProgram?: string;
}

export interface CdxmlExportResult {
  contents: string;
  warnings: CompatibilityConversionWarning[];
}

export type ChemDraftOpenSource = "native-payload" | "legacy-json" | "external-cdxml";

export interface ChemDraftOpenConflict {
  kind: "visible-layer-modified";
  embeddedDocument: ChemDraftDocument;
  visibleDocument?: ChemDraftDocument;
}

export interface ChemDraftOpenResult {
  document?: ChemDraftDocument;
  source: ChemDraftOpenSource;
  warnings: CompatibilityConversionWarning[];
  conflict?: ChemDraftOpenConflict;
}

export const CdxmlEnvelopeCodecVersion = "chemdraft.cdxml.v1";
export const ChemDraftObjectTagPrefix = "org.chemdraft/";
export const ChemDraftObjectTags = {
  codecVersion: "org.chemdraft/codec-version",
  schemaVersion: "org.chemdraft/schema-version",
  nativePayloadHash: "org.chemdraft/native-payload-hash",
  visibleCdxmlHash: "org.chemdraft/visible-cdxml-hash",
  nativeDocument: "org.chemdraft/native-document"
} as const;

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: false,
  commentPropName: "#comment",
  cdataPropName: "#cdata"
});

const base64UrlAlphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const cssPxPerInch = 96;
const cdxmlPointsPerInch = 72;
const cdxmlScale = cdxmlPointsPerInch / cssPxPerInch;
const nativeImportTimestamp = "2026-05-29T00:00:00.000Z";

type OrderedXmlNode = Record<string, unknown>;
type OrderedXmlTree = OrderedXmlNode[];

interface XmlElementView {
  name: string;
  children: OrderedXmlTree;
  attributes: Record<string, string>;
}

interface IdAllocator {
  next(): string;
}

interface VisibleExportContext {
  ids: Map<string, string>;
  bondIdsByRefKey: Map<string, string>;
  crossingPartnerKeysByRefKey: Map<string, Set<string>>;
  crossingFrontKeysByRefKey: Map<string, { front: number; back: number }>;
}

interface CdxmlCrossingImportHint {
  sourceBondId: string;
  partnerBondIds: string[];
}

interface ImportPageContext {
  bondRefsByCdxmlId: Map<string, BondRef>;
  zByRefKey: Map<string, number>;
  displayByRefKey: Map<string, string>;
  crossingHints: CdxmlCrossingImportHint[];
}

type DoubleBondSide = NonNullable<MoleculeBond["display"]>["doubleBondSide"];

export function exportDocumentToCdxml(
  document: ChemDraftDocument,
  options: CdxmlExportOptions = {}
): CdxmlExportResult {
  const parsedDocument = parseDocument(document);
  const warnings: CompatibilityConversionWarning[] = [];
  const creationProgram = options.creationProgram ?? "ChemDraft";
  const nativeJson = serializeDocument(parsedDocument);
  const nativePayloadHash = sha256Utf8Hex(nativeJson);
  const visiblePageChildren = parsedDocument.pages.map((page, pageIndex) => buildVisiblePageChildren(page, warnings, pageIndex));
  const visiblePages = parsedDocument.pages.map((page, pageIndex) => buildPageXml(page, visiblePageChildren[pageIndex]));
  const visibleEnvelope = buildCdxmlEnvelope(creationProgram, visiblePages);
  const visibleCdxmlHash = visibleHashForCdxml(visibleEnvelope);
  const metadata = buildMetadataObjectTags({
    codecVersion: CdxmlEnvelopeCodecVersion,
    schemaVersion: DocumentSchemaVersion,
    nativePayloadHash,
    visibleCdxmlHash,
    nativeDocument: encodeBase64UrlUtf8(nativeJson)
  });
  const envelopePages = parsedDocument.pages.map((page, pageIndex) =>
    buildPageXml(page, `${visiblePageChildren[pageIndex]}${pageIndex === 0 ? metadata : ""}`)
  );
  const contents = buildCdxmlEnvelope(creationProgram, envelopePages);
  const finalVisibleHash = visibleHashForCdxml(contents);

  if (finalVisibleHash !== visibleCdxmlHash) {
    warnings.push({
      code: "cdxml.visible_hash_internal_mismatch",
      message: "ChemDraft generated a CDXML envelope whose visible hash changed after metadata insertion."
    });
  }

  return { contents, warnings };
}

export function openChemDraftPayload(contents: string): ChemDraftOpenResult {
  const normalized = stripByteOrderMark(contents).trimStart();

  if (normalized.length === 0) {
    return {
      source: "external-cdxml",
      warnings: [warning("cdxml.empty_payload", "Open failed because the file is empty.")]
    };
  }

  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    return openLegacyJsonDocument(normalized);
  }

  if (!normalized.startsWith("<")) {
    return {
      source: "external-cdxml",
      warnings: [
        warning("cdxml.unrecognized_payload", "Open failed because the file is neither native JSON nor CDXML XML.")
      ]
    };
  }

  let tree: OrderedXmlTree;
  try {
    tree = parseCdxml(contents);
  } catch (error) {
    return {
      source: "external-cdxml",
      warnings: [warning("cdxml.malformed_xml", `CDXML parse failed: ${errorMessage(error)}`)]
    };
  }

  const tags = findChemDraftObjectTags(tree);
  const nativePayload = tags[ChemDraftObjectTags.nativeDocument];
  if (!nativePayload) {
    const visibleImport = importVisibleCdxmlFromTree(tree);
    return {
      document: visibleImport.document,
      source: "external-cdxml",
      warnings: visibleImport.document
        ? [
            warning(
              "cdxml.external_subset_imported",
              "Opened an external CDXML subset; unsupported objects or chemistry may have been omitted."
            ),
            ...visibleImport.warnings
          ]
        : [
            warning("cdxml.external_import_not_implemented", "This CDXML file does not contain a ChemDraft payload and no supported visible objects were found."),
            ...visibleImport.warnings
          ]
    };
  }

  const codecVersion = tags[ChemDraftObjectTags.codecVersion];
  if (codecVersion !== CdxmlEnvelopeCodecVersion) {
    return {
      source: "native-payload",
      warnings: [
        warning(
          "cdxml.codec_version_unsupported",
          `This ChemDraft CDXML envelope uses unsupported codec version "${codecVersion ?? "<missing>"}".`
        )
      ]
    };
  }

  const schemaVersion = tags[ChemDraftObjectTags.schemaVersion];
  if (schemaVersion !== DocumentSchemaVersion) {
    return {
      source: "native-payload",
      warnings: [
        warning(
          "cdxml.schema_version_unsupported",
          `This ChemDraft file was written with unsupported document schema "${schemaVersion ?? "<missing>"}".`
        )
      ]
    };
  }

  let nativeJson: string;
  try {
    nativeJson = decodeBase64UrlUtf8(nativePayload);
  } catch (error) {
    return {
      source: "native-payload",
      warnings: [warning("cdxml.native_payload_invalid", `The embedded ChemDraft payload could not be decoded: ${errorMessage(error)}`)]
    };
  }

  const expectedNativeHash = tags[ChemDraftObjectTags.nativePayloadHash];
  const actualNativeHash = sha256Utf8Hex(nativeJson);
  if (!expectedNativeHash || expectedNativeHash !== actualNativeHash) {
    return {
      source: "native-payload",
      warnings: [
        warning("cdxml.native_payload_hash_mismatch", "The embedded ChemDraft payload hash does not match; the file may be corrupt or tampered with.")
      ]
    };
  }

  let embeddedDocument: ChemDraftDocument;
  try {
    embeddedDocument = deserializeDocument(nativeJson);
  } catch (error) {
    return {
      source: "native-payload",
      warnings: [warning("cdxml.native_payload_invalid", `The embedded ChemDraft document is invalid: ${errorMessage(error)}`)]
    };
  }

  const expectedVisibleHash = tags[ChemDraftObjectTags.visibleCdxmlHash];
  const actualVisibleHash = visibleHashForParsedTree(tree);
  if (!expectedVisibleHash || expectedVisibleHash !== actualVisibleHash) {
    const visibleImport = importVisibleCdxmlFromTree(tree);
    return {
      source: "external-cdxml",
      warnings: [
        warning(
          "cdxml.visible_layer_modified",
          "The visible CDXML layer was modified outside ChemDraft; choose whether to trust the embedded native payload or import the edited visible subset."
        ),
        ...visibleImport.warnings
      ],
      conflict: {
        kind: "visible-layer-modified",
        embeddedDocument,
        visibleDocument: visibleImport.document
      }
    };
  }

  return {
    document: embeddedDocument,
    source: "native-payload",
    warnings: []
  };
}

export function canonicalVisibleCdxml(contents: string): string {
  return canonicalizeXmlTree(stripChemDraftObjectTags(parseCdxml(contents)));
}

export function visibleHashForCdxml(contents: string): string {
  return sha256Utf8Hex(canonicalVisibleCdxml(contents));
}

export function sha256Utf8Hex(value: string): string {
  return sha256Hex(utf8Bytes(value));
}

export function encodeBase64UrlUtf8(value: string): string {
  return encodeBase64UrlBytes(utf8Bytes(value));
}

export function decodeBase64UrlUtf8(value: string): string {
  return utf8String(decodeBase64UrlBytes(value));
}

function openLegacyJsonDocument(contents: string): ChemDraftOpenResult {
  try {
    return {
      document: deserializeDocument(contents),
      source: "legacy-json",
      warnings: []
    };
  } catch (error) {
    const unsupportedSchemaWarning = unsupportedSchemaWarningFromJson(contents);
    if (unsupportedSchemaWarning) {
      return {
        source: "legacy-json",
        warnings: [unsupportedSchemaWarning]
      };
    }
    return {
      source: "legacy-json",
      warnings: [warning("cdxml.legacy_json_invalid", `Legacy ChemDraft JSON open failed: ${errorMessage(error)}`)]
    };
  }
}

function unsupportedSchemaWarningFromJson(contents: string): CompatibilityConversionWarning | undefined {
  try {
    const parsed = JSON.parse(contents) as unknown;
    if (isRecord(parsed) && typeof parsed.schema === "string" && parsed.schema !== DocumentSchemaVersion) {
      return warning(
        "cdxml.schema_version_unsupported",
        `This ChemDraft file was written with unsupported document schema "${parsed.schema}".`
      );
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function buildCdxmlEnvelope(creationProgram: string, pages: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">',
    `<CDXML CreationProgram="${escapeXmlAttribute(creationProgram)}">`,
    ...pages,
    "</CDXML>",
    ""
  ].join("\n");
}

function buildPageXml(page: DocumentPage, children: string): string {
  const attributes = [
    `id="${escapeXmlAttribute(page.id)}"`,
    `BoundingBox="${formatNumber(0)} ${formatNumber(0)} ${formatNumber(cssPxToCdxml(page.width))} ${formatNumber(cssPxToCdxml(page.height))}"`
  ];
  return `  <page ${attributes.join(" ")}>${children}</page>`;
}

function buildVisiblePageChildren(page: DocumentPage, warnings: CompatibilityConversionWarning[], pageIndex: number): string {
  const allocator = createIdAllocator(pageIndex);
  const context = createVisibleExportContext(page);
  const objectsById = new Map(page.objects.map((object) => [object.id, object]));
  const visibleChildren = page.objects
    .map((object) => exportVisibleObject(object, context, allocator, warnings, objectsById))
    .filter((child) => child.length > 0);
  return visibleChildren.length > 0 ? `\n${visibleChildren.map((child) => indent(child, 4)).join("\n")}\n  ` : "";
}

function exportVisibleObject(
  object: DocumentObject,
  context: VisibleExportContext,
  allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[],
  objectsById: ReadonlyMap<string, DocumentObject>
): string {
  if (object.type === "molecule") {
    return exportMoleculeObject(object, context, allocator, warnings);
  }
  if (object.type === "text") {
    return exportTextObject(object, context.ids, allocator);
  }
  if (object.type === "plus") {
    return exportTextObject({ ...object, type: "text", text: "+", spans: [] }, context.ids, allocator);
  }
  if (object.type === "reaction-arrow") {
    return exportReactionArrowObject(object, context.ids, allocator, objectsById);
  }
  if (object.type === "graphic") {
    return exportGraphicObject(object, context.ids, allocator);
  }
  if (object.type === "bracket") {
    return exportGraphicObject({ ...object, type: "graphic", graphicKind: "path", data: { bracketKind: object.bracketKind } }, context.ids, allocator);
  }
  if (object.type === "reaction") {
    warnings.push({
      code: "cdxml.reaction_scheme_export_partial",
      message: "Reaction scheme CDXML export is partial; visible components are exported independently.",
      sourceObjectId: object.id
    });
    return "";
  }
  if (object.type === "mechanism-arrow" || object.type === "electron-mark") {
    warnings.push({
      code: "cdxml.mechanism_payload_only",
      message: "Editable mechanism annotations remain in the ChemDraft payload until CDXML mapping is implemented.",
      sourceObjectId: object.id
    });
    return "";
  }
  warnings.push({
    code: "cdxml.object_export_unsupported",
    message: `Object type "${object.type}" remains available through the embedded ChemDraft payload but is not yet visible CDXML.`,
    sourceObjectId: object.id
  });
  return "";
}

function createVisibleExportContext(page: DocumentPage): VisibleExportContext {
  const crossingPartnerKeysByRefKey = new Map<string, Set<string>>();
  const crossingFrontKeysByRefKey = new Map<string, { front: number; back: number }>();

  page.crossings.forEach((crossing) => {
    const [left, right] = crossing.bonds;
    const leftKey = bondRefKey(left);
    const rightKey = bondRefKey(right);
    appendCrossingPartner(crossingPartnerKeysByRefKey, leftKey, rightKey);
    appendCrossingPartner(crossingPartnerKeysByRefKey, rightKey, leftKey);
    appendCrossingDepthCount(crossingFrontKeysByRefKey, leftKey, sameBondRef(crossing.front, left) ? "front" : "back");
    appendCrossingDepthCount(crossingFrontKeysByRefKey, rightKey, sameBondRef(crossing.front, right) ? "front" : "back");
  });

  return {
    ids: new Map(),
    bondIdsByRefKey: new Map(),
    crossingPartnerKeysByRefKey,
    crossingFrontKeysByRefKey
  };
}

function appendCrossingPartner(map: Map<string, Set<string>>, sourceKey: string, partnerKey: string): void {
  const partners = map.get(sourceKey) ?? new Set<string>();
  partners.add(partnerKey);
  map.set(sourceKey, partners);
}

function appendCrossingDepthCount(
  map: Map<string, { front: number; back: number }>,
  key: string,
  direction: "front" | "back"
): void {
  const current = map.get(key) ?? { front: 0, back: 0 };
  current[direction] += 1;
  map.set(key, current);
}

function exportMoleculeObject(
  molecule: MoleculeObject,
  context: VisibleExportContext,
  allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[]
): string {
  const fragmentId = idFor(context.ids, molecule.id, allocator);
  const atomIds = new Map<string, string>();
  const atomLines = molecule.atoms.map((atom) => {
    const nodeId = idFor(atomIds, atom.id, allocator);
    const elementNumber = atomicNumberForElement(atom.element);
    const attributes = [
      `id="${nodeId}"`,
      `p="${formatPoint(atom)}"`
    ];
    if (elementNumber !== undefined && atom.element !== "C") {
      attributes.push(`Element="${elementNumber}"`);
    }
    if (elementNumber === undefined) {
      attributes.push(`Element="${escapeXmlAttribute(atom.element)}"`);
      warnings.push({
        code: "cdxml.atom_element_symbol_exported",
        message: `Atom element "${atom.element}" was exported as a CDXML element label because no atomic number mapping exists.`,
        sourceObjectId: molecule.id
      });
    }
    if (atom.formalCharge !== 0) {
      attributes.push(`Charge="${atom.formalCharge}"`);
    }
    return `<n ${attributes.join(" ")}/>`;
  });
  const bondLines = molecule.bonds.map((bond) => exportBond(bond, molecule, atomIds, context, allocator, warnings));

  if (molecule.chemistry?.isotopeLabels.length || molecule.chemistry?.radicalCount || molecule.chemistry?.stereochemistry.length) {
    warnings.push({
      code: "cdxml.molecule_metadata_payload_only",
      message: "Molecule isotope, radical, or stereochemistry aggregates remain in the native payload until per-atom schema support exists.",
      sourceObjectId: molecule.id
    });
  }

  return [
    `<fragment id="${fragmentId}" BoundingBox="${formatBoundingBox(molecule)}">`,
    ...atomLines.map((line) => indent(line, 2)),
    ...bondLines.map((line) => indent(line, 2)),
    "</fragment>"
  ].join("\n");
}

function exportBond(
  bond: MoleculeBond,
  molecule: MoleculeObject,
  atomIds: ReadonlyMap<string, string>,
  context: VisibleExportContext,
  allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[]
): string {
  const nativeRef = { objectId: molecule.id, bondId: bond.id };
  const nativeRefKey = bondRefKey(nativeRef);
  const bondId = cdxmlBondIdForRef(nativeRef, context, allocator);
  const order = cdxmlBondOrder(bond.order, molecule.id, warnings);
  const attributes = [
    `id="${bondId}"`,
    `B="${atomIds.get(bond.fromAtomId) ?? escapeXmlAttribute(bond.fromAtomId)}"`,
    `E="${atomIds.get(bond.toAtomId) ?? escapeXmlAttribute(bond.toAtomId)}"`,
    `Order="${order}"`
  ];
  const bondStyle = bondStyleFromDisplay(bond.display);
  if (bondStyle) {
    attributes.push(`Display="${bondStyle}"`);
  }
  if (bond.display?.doubleBondSide) {
    attributes.push(`DoublePosition="${cdxmlDoublePositionName(bond.display.doubleBondSide)}"`);
  }
  const crossingPartnerIds = [...(context.crossingPartnerKeysByRefKey.get(nativeRefKey) ?? [])]
    .map((partnerKey) => cdxmlBondIdForRef(bondRefFromKey(partnerKey), context, allocator));
  if (crossingPartnerIds.length > 0) {
    attributes.push(`CrossingBonds="${crossingPartnerIds.map(escapeXmlAttribute).join(" ")}"`);
    const z = cdxmlCrossingZForRef(nativeRefKey, context, molecule.id, warnings);
    if (z) {
      attributes.push(`Z="${z}"`);
    }
  }
  return `<b ${attributes.join(" ")}/>`;
}

function cdxmlBondIdForRef(ref: BondRef, context: VisibleExportContext, allocator: IdAllocator): string {
  const key = bondRefKey(ref);
  const existing = context.bondIdsByRefKey.get(key);
  if (existing) {
    return existing;
  }
  const allocated = allocator.next();
  context.bondIdsByRefKey.set(key, allocated);
  return allocated;
}

function cdxmlCrossingZForRef(
  refKey: string,
  context: VisibleExportContext,
  sourceObjectId: string,
  warnings: CompatibilityConversionWarning[]
): "1" | "2" | undefined {
  const counts = context.crossingFrontKeysByRefKey.get(refKey);
  if (!counts) {
    return undefined;
  }
  if (counts.front > 0 && counts.back > 0) {
    warnings.push({
      code: "cdxml.crossing_z_conflict",
      message: "A bond is over one crossing and under another; CDXML Z was exported as the dominant visible depth with a warning.",
      sourceObjectId
    });
  }
  return counts.front >= counts.back ? "2" : "1";
}

function exportTextObject(text: TextObject, ids: Map<string, string>, allocator: IdAllocator): string {
  const textId = idFor(ids, text.id, allocator);
  return `<t id="${textId}" p="${formatPoint({ x: text.x, y: text.y })}">${escapeXmlText(text.text)}</t>`;
}

function exportReactionArrowObject(
  arrow: ArrowObject,
  ids: Map<string, string>,
  allocator: IdAllocator,
  objectsById: ReadonlyMap<string, DocumentObject>
): string {
  const graphicId = idFor(ids, arrow.id, allocator);
  const start = resolveAnchorPoint(arrow.start, objectsById) ?? { x: arrow.x, y: arrow.y + arrow.height / 2 };
  const end = resolveAnchorPoint(arrow.end, objectsById) ?? { x: arrow.x + arrow.width, y: arrow.y + arrow.height / 2 };
  return `<graphic id="${graphicId}" GraphicType="Line" ArrowType="${escapeXmlAttribute(arrow.arrowKind)}" BoundingBox="${formatLineBoundingBox(start, end)}" Start="${formatPoint(start)}" End="${formatPoint(end)}"/>`;
}

function exportGraphicObject(graphic: GraphicObject, ids: Map<string, string>, allocator: IdAllocator): string {
  const graphicId = idFor(ids, graphic.id, allocator);
  return `<graphic id="${graphicId}" GraphicType="${escapeXmlAttribute(graphic.graphicKind)}" BoundingBox="${formatBoundingBox(graphic)}"/>`;
}

function buildMetadataObjectTags(values: {
  codecVersion: string;
  schemaVersion: string;
  nativePayloadHash: string;
  visibleCdxmlHash: string;
  nativeDocument: string;
}): string {
  const tags = [
    [ChemDraftObjectTags.codecVersion, values.codecVersion],
    [ChemDraftObjectTags.schemaVersion, values.schemaVersion],
    [ChemDraftObjectTags.nativePayloadHash, values.nativePayloadHash],
    [ChemDraftObjectTags.visibleCdxmlHash, values.visibleCdxmlHash],
    [ChemDraftObjectTags.nativeDocument, values.nativeDocument]
  ] as const;
  return `\n${tags.map(([name, value]) => indent(`<objecttag Name="${name}" Persistent="yes" TagType="String" Value="${escapeXmlAttribute(value)}"/>`, 4)).join("\n")}\n  `;
}

function importVisibleCdxmlFromTree(tree: OrderedXmlTree): { document?: ChemDraftDocument; warnings: CompatibilityConversionWarning[] } {
  const warnings: CompatibilityConversionWarning[] = [];
  const pageElements = findElements(tree, "page");
  if (pageElements.length === 0) {
    return {
      warnings: [warning("cdxml.no_pages", "The CDXML file contains no page elements.")]
    };
  }

  const base = createEmptyDocument({ title: "Imported CDXML.chemdraft", now: nativeImportTimestamp });
  const importedPages = pageElements.map((pageElement, pageIndex) => {
    const pageTemplate = base.pages[0];
    const importedPage = importPageObjects(pageElement, pageIndex, warnings);
    return {
      ...pageTemplate,
      id: `page_${String(pageIndex + 1).padStart(3, "0")}`,
      objects: importedPage.objects,
      crossings: importedPage.crossings
    };
  });
  const objectCount = importedPages.reduce((count, page) => count + page.objects.length, 0);
  if (objectCount === 0) {
    return {
      warnings: [warning("cdxml.no_supported_visible_objects", "No supported visible CDXML objects were found.")]
    };
  }

  return {
    document: ChemDraftDocumentSchema.parse({
      ...base,
      pages: importedPages,
      selection: { objectIds: [] },
      compatibility: {
        warnings: warnings.map((item) => ({
          code: item.code,
          message: item.message,
          objectId: item.sourceObjectId
        }))
      }
    }),
    warnings
  };
}

function importPageObjects(
  pageElement: XmlElementView,
  pageIndex: number,
  warnings: CompatibilityConversionWarning[]
): { objects: DocumentObject[]; crossings: CrossingOverride[] } {
  const objects: DocumentObject[] = [];
  const context: ImportPageContext = {
    bondRefsByCdxmlId: new Map(),
    zByRefKey: new Map(),
    displayByRefKey: new Map(),
    crossingHints: []
  };
  let objectIndex = 1;
  for (const child of pageElement.children) {
    const element = elementView(child);
    if (!element || isChemDraftObjectTag(element)) {
      continue;
    }
    if (element.name === "fragment") {
      const molecule = importFragment(element, pageIndex, objectIndex, warnings, context);
      if (molecule) {
        objects.push(molecule);
        objectIndex += 1;
      }
      continue;
    }
    if (element.name === "t") {
      objects.push(importText(element, pageIndex, objectIndex));
      objectIndex += 1;
      continue;
    }
    if (element.name === "graphic") {
      objects.push(importGraphic(element, pageIndex, objectIndex));
      objectIndex += 1;
      continue;
    }
    if (element.name !== "objecttag") {
      objects.push(importUnknownCompatibilityObject(element, pageIndex, objectIndex));
      warnings.push({
        code: "cdxml.object_import_unsupported",
        message: `Imported unsupported CDXML object "${element.name}" as an unknown compatibility object.`
      });
      objectIndex += 1;
    }
  }
  return {
    objects,
    crossings: resolveImportedCrossingOverrides(context, warnings)
  };
}

function importFragment(
  fragment: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  warnings: CompatibilityConversionWarning[],
  context: ImportPageContext
): MoleculeObject | undefined {
  const atomElements = childElements(fragment, "n");
  const bondElements = childElements(fragment, "b");
  if (atomElements.length === 0) {
    warnings.push({
      code: "cdxml.empty_fragment_skipped",
      message: "Skipped a CDXML fragment without atoms."
    });
    return undefined;
  }

  const objectId = `cdxml_molecule_${pageIndex + 1}_${objectIndex}`;
  const atomIdByCdxmlId = new Map<string, string>();
  const atoms: MoleculeAtom[] = atomElements.map((atomElement, atomIndex) => {
    const atomId = `atom_${String(atomIndex + 1).padStart(3, "0")}`;
    const cdxmlId = atomElement.attributes.id ?? atomId;
    atomIdByCdxmlId.set(cdxmlId, atomId);
    const point = parseCdxmlPoint(atomElement.attributes.p);
    const element = elementFromCdxmlAtom(atomElement.attributes.Element);
    return {
      id: atomId,
      element,
      x: point.x,
      y: point.y,
      formalCharge: parseInteger(atomElement.attributes.Charge) ?? 0
    };
  });
  const atomByCdxmlId = new Map<string, MoleculeAtom>(
    atomElements.map((atomElement, atomIndex) => [atomElement.attributes.id ?? atoms[atomIndex].id, atoms[atomIndex]])
  );
  const bonds: MoleculeBond[] = bondElements.map((bondElement, bondIndex) => {
    const order = moleculeBondOrderFromCdxml(bondElement.attributes.Order, warnings, objectId);
    const bondId = `bond_${String(bondIndex + 1).padStart(3, "0")}`;
    const bond: MoleculeBond = {
      id: bondId,
      fromAtomId: atomIdByCdxmlId.get(bondElement.attributes.B ?? "") ?? bondElement.attributes.B ?? "",
      toAtomId: atomIdByCdxmlId.get(bondElement.attributes.E ?? "") ?? bondElement.attributes.E ?? "",
      order
    };
    const cdxmlBondId = bondElement.attributes.id ?? bondId;
    const ref = { objectId, bondId };
    context.bondRefsByCdxmlId.set(cdxmlBondId, ref);
    const z = parseInteger(bondElement.attributes.Z);
    if (z !== undefined) {
      context.zByRefKey.set(bondRefKey(ref), z);
    }
    if (bondElement.attributes.Display) {
      context.displayByRefKey.set(bondRefKey(ref), bondElement.attributes.Display);
    }
    const crossingPartnerIds = splitCdxmlIdList(bondElement.attributes.CrossingBonds);
    if (crossingPartnerIds.length > 0) {
      context.crossingHints.push({ sourceBondId: cdxmlBondId, partnerBondIds: crossingPartnerIds });
    }
    const doubleBondSide =
      doubleBondSideFromCdxmlDoublePosition(bondElement.attributes.DoublePosition)
      ?? (order === "double" ? doubleBondSideFromCircularOrdering(bondElement, bondElements, atomByCdxmlId) : undefined);
    if (doubleBondSide) {
      bond.display = { ...(bond.display ?? {}), doubleBondSide };
    }
    if (bondElement.attributes.Display) {
      warnings.push({
        code: "cdxml.bond_display_unsupported",
        message: `CDXML bond display "${bondElement.attributes.Display}" is not represented in the current ChemDraft molecule schema.`,
        sourceObjectId: objectId
      });
    }
    return bond;
  });
  const bounds = boundsForAtoms(atoms);
  const compatibilityWarning: CompatibilityWarning = {
    code: "cdxml.structure_string_not_derived",
    message: "Imported CDXML atom/bond graph without deriving a canonical structure string.",
    objectId
  };
  warnings.push({
    code: compatibilityWarning.code,
    message: compatibilityWarning.message,
    sourceObjectId: objectId
  });

  return {
    id: objectId,
    type: "molecule",
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    style: {},
    structureFormat: "unknown",
    structure: "",
    atoms,
    bonds,
    superatoms: [],
    rGroups: [],
    compatibility: {
      sourceFormat: "cdxml",
      originalId: fragment.attributes.id,
      warnings: [compatibilityWarning],
      unknown: {}
    }
  };
}

function doubleBondSideFromCdxmlDoublePosition(value: string | undefined): DoubleBondSide | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "right" || normalized === "1" || normalized === "257") {
    return "right";
  }
  if (normalized === "left" || normalized === "2" || normalized === "258") {
    return "left";
  }
  return undefined;
}

function doubleBondSideFromCircularOrdering(
  bondElement: XmlElementView,
  bondElements: readonly XmlElementView[],
  atomByCdxmlId: ReadonlyMap<string, MoleculeAtom>
): DoubleBondSide | undefined {
  const ordering = bondElement.attributes.BondCircularOrdering?.trim().split(/\s+/) ?? [];
  if (ordering.length === 0 || !cdxmlBondIsInCycle(bondElement, bondElements)) {
    return undefined;
  }

  const bondElementById = new Map<string, XmlElementView>();
  bondElements.forEach((element) => {
    if (element.attributes.id) {
      bondElementById.set(element.attributes.id, element);
    }
  });

  // ChemDraw's circular-order slots 0/3 and 1/2 are the same-side pairs for
  // ring double bonds; prefer the first resolvable pair to mimic its auto side.
  return (
    consistentSideForCircularOrderingGroup([ordering[0], ordering[3]], bondElement, bondElementById, atomByCdxmlId)
    ?? consistentSideForCircularOrderingGroup([ordering[1], ordering[2]], bondElement, bondElementById, atomByCdxmlId)
  );
}

function consistentSideForCircularOrderingGroup(
  ids: readonly (string | undefined)[],
  bondElement: XmlElementView,
  bondElementById: ReadonlyMap<string, XmlElementView>,
  atomByCdxmlId: ReadonlyMap<string, MoleculeAtom>
): DoubleBondSide | undefined {
  const sides = ids
    .filter((id): id is string => id !== undefined && id !== "0")
    .map((id) => sideForAttachedCdxmlBond(id, bondElement, bondElementById, atomByCdxmlId))
    .filter((side): side is DoubleBondSide => side !== undefined);
  if (sides.length === 0) {
    return undefined;
  }
  return sides.every((side) => side === sides[0]) ? sides[0] : undefined;
}

function sideForAttachedCdxmlBond(
  attachedBondId: string,
  bondElement: XmlElementView,
  bondElementById: ReadonlyMap<string, XmlElementView>,
  atomByCdxmlId: ReadonlyMap<string, MoleculeAtom>
): DoubleBondSide | undefined {
  const attachedBond = bondElementById.get(attachedBondId);
  const beginId = bondElement.attributes.B;
  const endId = bondElement.attributes.E;
  const fromAtom = beginId ? atomByCdxmlId.get(beginId) : undefined;
  const toAtom = endId ? atomByCdxmlId.get(endId) : undefined;
  if (!attachedBond || !beginId || !endId || !fromAtom || !toAtom) {
    return undefined;
  }

  const attachedBeginId = attachedBond.attributes.B;
  const attachedEndId = attachedBond.attributes.E;
  const otherAtomId = attachedBeginId === beginId || attachedBeginId === endId
    ? attachedEndId
    : attachedEndId === beginId || attachedEndId === endId
      ? attachedBeginId
      : undefined;
  const otherAtom = otherAtomId ? atomByCdxmlId.get(otherAtomId) : undefined;
  return otherAtom ? sideForPointRelativeToBond(fromAtom, toAtom, otherAtom) : undefined;
}

function cdxmlBondIsInCycle(bondElement: XmlElementView, bondElements: readonly XmlElementView[]): boolean {
  const beginId = bondElement.attributes.B;
  const endId = bondElement.attributes.E;
  if (!beginId || !endId) {
    return false;
  }

  const adjacency = new Map<string, Set<string>>();
  bondElements.forEach((candidate) => {
    if (candidate === bondElement) {
      return;
    }
    const candidateBeginId = candidate.attributes.B;
    const candidateEndId = candidate.attributes.E;
    if (!candidateBeginId || !candidateEndId) {
      return;
    }
    appendAdjacency(adjacency, candidateBeginId, candidateEndId);
    appendAdjacency(adjacency, candidateEndId, candidateBeginId);
  });

  const queue = [beginId];
  const visited = new Set<string>(queue);
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === endId) {
      return true;
    }
    for (const next of adjacency.get(current ?? "") ?? []) {
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

function appendAdjacency(map: Map<string, Set<string>>, fromId: string, toId: string): void {
  const neighbors = map.get(fromId) ?? new Set<string>();
  neighbors.add(toId);
  map.set(fromId, neighbors);
}

function sideForPointRelativeToBond(fromAtom: MoleculeAtom, toAtom: MoleculeAtom, point: Point): DoubleBondSide | undefined {
  const dx = toAtom.x - fromAtom.x;
  const dy = toAtom.y - fromAtom.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return undefined;
  }
  const normal = { x: -dy / length, y: dx / length };
  const midpoint = { x: (fromAtom.x + toAtom.x) / 2, y: (fromAtom.y + toAtom.y) / 2 };
  const score = (point.x - midpoint.x) * normal.x + (point.y - midpoint.y) * normal.y;
  return score >= 0 ? "left" : "right";
}

function cdxmlDoublePositionName(side: DoubleBondSide): "Left" | "Right" {
  return side === "left" ? "Left" : "Right";
}

function resolveImportedCrossingOverrides(
  context: ImportPageContext,
  warnings: CompatibilityConversionWarning[]
): CrossingOverride[] {
  const crossings = new Map<string, CrossingOverride>();

  context.crossingHints.forEach((hint) => {
    const sourceRef = context.bondRefsByCdxmlId.get(hint.sourceBondId);
    if (!sourceRef) {
      warnings.push(warning(
        "cdxml.crossing_bond_unresolved",
        `CDXML CrossingBonds source "${hint.sourceBondId}" did not resolve to an imported native bond.`
      ));
      return;
    }

    hint.partnerBondIds.forEach((partnerBondId) => {
      const partnerRef = context.bondRefsByCdxmlId.get(partnerBondId);
      if (!partnerRef) {
        warnings.push(warning(
          "cdxml.crossing_bond_unresolved",
          `CDXML CrossingBonds target "${partnerBondId}" did not resolve to an imported native bond.`
        ));
        return;
      }

      if (sameBondRef(sourceRef, partnerRef)) {
        return;
      }

      const bonds = canonicalBondRefs([sourceRef, partnerRef]);
      const key = crossingPairKey(bonds);
      if (crossings.has(key)) {
        return;
      }
      crossings.set(key, {
        bonds,
        front: frontBondRefFromCdxmlDepth(sourceRef, partnerRef, context)
      });
    });
  });

  return [...crossings.values()].sort((left, right) => crossingPairKey(left.bonds).localeCompare(crossingPairKey(right.bonds)));
}

function frontBondRefFromCdxmlDepth(left: BondRef, right: BondRef, context: ImportPageContext): BondRef {
  const leftKey = bondRefKey(left);
  const rightKey = bondRefKey(right);
  const leftZ = context.zByRefKey.get(leftKey);
  const rightZ = context.zByRefKey.get(rightKey);
  if (leftZ !== undefined || rightZ !== undefined) {
    return (leftZ ?? 0) >= (rightZ ?? 0) ? left : right;
  }

  const leftDisplay = context.displayByRefKey.get(leftKey);
  const rightDisplay = context.displayByRefKey.get(rightKey);
  if (leftDisplay === "Bold" && rightDisplay !== "Bold") {
    return left;
  }
  if (rightDisplay === "Bold" && leftDisplay !== "Bold") {
    return right;
  }

  return bondRefKey(left).localeCompare(bondRefKey(right)) >= 0 ? left : right;
}

function importText(textElement: XmlElementView, pageIndex: number, objectIndex: number): TextObject {
  const point = parseCdxmlPoint(textElement.attributes.p);
  const text = textContent(textElement.children);
  return {
    id: `cdxml_text_${pageIndex + 1}_${objectIndex}`,
    type: "text",
    x: point.x,
    y: point.y,
    width: Math.max(36, text.length * 8),
    height: 24,
    rotation: 0,
    style: {},
    text,
    spans: [],
    compatibility: {
      sourceFormat: "cdxml",
      originalId: textElement.attributes.id,
      warnings: [],
      unknown: {}
    }
  };
}

function importGraphic(element: XmlElementView, pageIndex: number, objectIndex: number): GraphicObject | ArrowObject {
  const box = parseBoundingBox(element.attributes.BoundingBox);
  if (element.attributes.GraphicType === "Line" && element.attributes.ArrowType) {
    const start = parseCdxmlPoint(element.attributes.Start) ?? { x: box.x, y: box.y };
    const end = parseCdxmlPoint(element.attributes.End) ?? { x: box.x + box.width, y: box.y + box.height };
    return {
      id: `cdxml_arrow_${pageIndex + 1}_${objectIndex}`,
      type: "reaction-arrow",
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      rotation: 0,
      style: {},
      arrowKind: arrowKindFromCdxml(element.attributes.ArrowType),
      start: { kind: "point", point: start },
      end: { kind: "point", point: end },
      labels: [],
      compatibility: {
        sourceFormat: "cdxml",
        originalId: element.attributes.id,
        warnings: [],
        unknown: {}
      }
    };
  }

  return {
    id: `cdxml_graphic_${pageIndex + 1}_${objectIndex}`,
    type: "graphic",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    style: {},
    graphicKind: graphicKindFromCdxml(element.attributes.GraphicType),
    data: {},
    compatibility: {
      sourceFormat: "cdxml",
      originalId: element.attributes.id,
      warnings: [],
      unknown: {}
    }
  };
}

function importUnknownCompatibilityObject(element: XmlElementView, pageIndex: number, objectIndex: number): DocumentObject {
  return {
    id: `cdxml_unknown_${pageIndex + 1}_${objectIndex}`,
    type: "unknown-compatibility-object",
    x: 0,
    y: 0,
    width: 1,
    height: 1,
    rotation: 0,
    style: {},
    sourceFormat: "cdxml",
    sourceObjectType: element.name,
    warning: `Unsupported CDXML object "${element.name}" was preserved as an unknown compatibility object.`,
    raw: element,
    compatibility: {
      sourceFormat: "cdxml",
      originalId: element.attributes.id,
      warnings: [],
      unknown: {}
    }
  };
}

function parseCdxml(contents: string): OrderedXmlTree {
  const xml = stripByteOrderMark(contents);
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    throw new Error(validation.err.msg);
  }
  const parsed = xmlParser.parse(xml) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("CDXML parser returned an unexpected document shape.");
  }
  return parsed as OrderedXmlTree;
}

function visibleHashForParsedTree(tree: OrderedXmlTree): string {
  return sha256Utf8Hex(canonicalizeXmlTree(stripChemDraftObjectTags(tree)));
}

function stripChemDraftObjectTags(tree: OrderedXmlTree): OrderedXmlTree {
  return tree.flatMap((node) => {
    const element = elementView(node);
    if (!element) {
      return keepCanonicalNode(node) ? [node] : [];
    }
    if (isChemDraftObjectTag(element)) {
      return [];
    }
    return [
      {
        [element.name]: stripChemDraftObjectTags(element.children),
        ...(Object.keys(element.attributes).length > 0 ? { ":@": element.attributes } : {})
      }
    ];
  });
}

function canonicalizeXmlTree(tree: OrderedXmlTree): string {
  return tree.map(canonicalizeNode).join("");
}

function canonicalizeNode(node: OrderedXmlNode): string {
  if (typeof node["#text"] === "string") {
    const text = node["#text"];
    return text.trim().length === 0 ? "" : escapeXmlText(text);
  }
  const cdata = cdataContent(node["#cdata"]);
  if (cdata !== undefined) {
    return escapeXmlText(cdata);
  }

  const element = elementView(node);
  if (!element || element.name.startsWith("?") || element.name === "#comment") {
    return "";
  }

  const attributes = Object.entries(element.attributes)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join("");
  const children = canonicalizeXmlTree(element.children);
  return children.length === 0
    ? `<${element.name}${attributes}/>`
    : `<${element.name}${attributes}>${children}</${element.name}>`;
}

function keepCanonicalNode(node: OrderedXmlNode): boolean {
  if (typeof node["#text"] === "string") {
    return node["#text"].trim().length > 0;
  }
  if (typeof node["#comment"] === "string") {
    return false;
  }
  const cdata = cdataContent(node["#cdata"]);
  if (cdata !== undefined) {
    return cdata.trim().length > 0;
  }
  const element = elementView(node);
  return element === undefined || !element.name.startsWith("?");
}

function findChemDraftObjectTags(tree: OrderedXmlTree): Record<string, string> {
  const tags: Record<string, string> = {};
  for (const element of findElements(tree, "objecttag")) {
    const name = element.attributes.Name;
    if (!name?.startsWith(ChemDraftObjectTagPrefix)) {
      continue;
    }
    tags[name] = element.attributes.Value ?? textContent(element.children);
  }
  return tags;
}

function findElements(tree: OrderedXmlTree, name: string): XmlElementView[] {
  const matches: XmlElementView[] = [];
  for (const node of tree) {
    const element = elementView(node);
    if (!element) {
      continue;
    }
    if (element.name === name) {
      matches.push(element);
    }
    matches.push(...findElements(element.children, name));
  }
  return matches;
}

function childElements(parent: XmlElementView, name: string): XmlElementView[] {
  return parent.children.flatMap((node) => {
    const element = elementView(node);
    return element?.name === name ? [element] : [];
  });
}

function elementView(node: OrderedXmlNode): XmlElementView | undefined {
  const name = Object.keys(node).find((key) => key !== ":@");
  if (!name || name === "#text" || name === "#comment" || name === "#cdata") {
    return undefined;
  }
  const rawChildren = node[name];
  const children = Array.isArray(rawChildren) ? rawChildren as OrderedXmlTree : [];
  const attributes = attributesFromNode(node);
  return { name, children, attributes };
}

function attributesFromNode(node: OrderedXmlNode): Record<string, string> {
  const raw = node[":@"];
  if (!isRecord(raw)) {
    return {};
  }
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, String(value)]));
}

function isChemDraftObjectTag(element: XmlElementView): boolean {
  return element.name === "objecttag" && element.attributes.Name?.startsWith(ChemDraftObjectTagPrefix) === true;
}

function textContent(children: OrderedXmlTree): string {
  return children.map((child) => {
    if (typeof child["#text"] === "string") {
      return child["#text"];
    }
    const cdata = cdataContent(child["#cdata"]);
    if (cdata !== undefined) {
      return cdata;
    }
    const element = elementView(child);
    return element ? textContent(element.children) : "";
  }).join("");
}

function cdataContent(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (isRecord(item) && typeof item["#text"] === "string") {
        return item["#text"];
      }
      return "";
    }).join("");
  }
  return undefined;
}

function encodeBase64UrlBytes(bytes: Uint8Array): string {
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = bytes[index + 1];
    const third = bytes[index + 2];
    const triple = (first << 16) | ((second ?? 0) << 8) | (third ?? 0);
    encoded += base64UrlAlphabet[(triple >> 18) & 0x3f];
    encoded += base64UrlAlphabet[(triple >> 12) & 0x3f];
    if (index + 1 < bytes.length) {
      encoded += base64UrlAlphabet[(triple >> 6) & 0x3f];
    }
    if (index + 2 < bytes.length) {
      encoded += base64UrlAlphabet[triple & 0x3f];
    }
  }
  return encoded;
}

function decodeBase64UrlBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
    throw new Error("Invalid base64url payload.");
  }
  const bytes: number[] = [];
  for (let index = 0; index < value.length; index += 4) {
    const a = decodeBase64UrlChar(value[index]);
    const b = decodeBase64UrlChar(value[index + 1]);
    const c = value[index + 2] === undefined ? 0 : decodeBase64UrlChar(value[index + 2]);
    const d = value[index + 3] === undefined ? 0 : decodeBase64UrlChar(value[index + 3]);
    const triple = (a << 18) | (b << 12) | (c << 6) | d;
    bytes.push((triple >> 16) & 0xff);
    if (value[index + 2] !== undefined) {
      bytes.push((triple >> 8) & 0xff);
    }
    if (value[index + 3] !== undefined) {
      bytes.push(triple & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function decodeBase64UrlChar(char: string | undefined): number {
  if (char === undefined) {
    throw new Error("Invalid base64url payload length.");
  }
  const value = base64UrlAlphabet.indexOf(char);
  if (value < 0) {
    throw new Error("Invalid base64url character.");
  }
  return value;
}

function createIdAllocator(pageIndex: number): IdAllocator {
  let nextId = pageIndex * 10000 + 1;
  return {
    next() {
      const value = String(nextId);
      nextId += 1;
      return value;
    }
  };
}

function idFor(ids: Map<string, string>, nativeId: string, allocator: IdAllocator): string {
  const existing = ids.get(nativeId);
  if (existing) {
    return existing;
  }
  const allocated = allocator.next();
  ids.set(nativeId, allocated);
  return allocated;
}

function bondRefKey(ref: BondRef): string {
  return `${ref.objectId}::${ref.bondId}`;
}

function bondRefFromKey(key: string): BondRef {
  const separatorIndex = key.indexOf("::");
  return {
    objectId: separatorIndex >= 0 ? key.slice(0, separatorIndex) : key,
    bondId: separatorIndex >= 0 ? key.slice(separatorIndex + 2) : ""
  };
}

function crossingPairKey(bonds: [BondRef, BondRef]): string {
  return canonicalBondRefs(bonds).map(bondRefKey).join("|");
}

function canonicalBondRefs(bonds: [BondRef, BondRef]): [BondRef, BondRef] {
  const [left, right] = bonds;
  return bondRefKey(left).localeCompare(bondRefKey(right)) <= 0 ? [left, right] : [right, left];
}

function sameBondRef(left: BondRef, right: BondRef): boolean {
  return left.objectId === right.objectId && left.bondId === right.bondId;
}

function splitCdxmlIdList(value: string | undefined): string[] {
  return value?.trim().split(/\s+/).filter((item) => item.length > 0) ?? [];
}

function cdxmlBondOrder(
  order: MoleculeBond["order"],
  sourceObjectId: string,
  warnings: CompatibilityConversionWarning[]
): string {
  if (order === "single") {
    return "1";
  }
  if (order === "double") {
    return "2";
  }
  if (order === "triple") {
    return "3";
  }
  if (order === "aromatic") {
    warnings.push({
      code: "cdxml.aromatic_bond_approximation",
      message: "Aromatic bond display was exported as CDXML Order=\"1.5\"; ChemDraft did not rewrite the native chemical graph.",
      sourceObjectId
    });
    return "1.5";
  }
  warnings.push({
    code: "cdxml.unknown_bond_order",
    message: "Unknown bond order was exported as CDXML Order=\"1\" with a compatibility warning.",
    sourceObjectId
  });
  return "1";
}

function moleculeBondOrderFromCdxml(
  order: string | undefined,
  warnings: CompatibilityConversionWarning[],
  sourceObjectId: string
): MoleculeBond["order"] {
  if (order === "1" || order === undefined) {
    return "single";
  }
  if (order === "2") {
    return "double";
  }
  if (order === "3") {
    return "triple";
  }
  if (order === "1.5" || order?.toLowerCase() === "aromatic") {
    warnings.push({
      code: "cdxml.aromatic_bond_import_approximation",
      message: "Imported aromatic CDXML bond as native aromatic bond; no Kekule conversion was performed.",
      sourceObjectId
    });
    return "aromatic";
  }
  warnings.push({
    code: "cdxml.bond_order_import_unsupported",
    message: `Unsupported CDXML bond order "${order}" was imported as unknown.`,
    sourceObjectId
  });
  return "unknown";
}

function bondStyleFromDisplay(display: MoleculeBond["display"]): string | undefined {
  const maybeDisplay = display as { bondStyle?: string } | undefined;
  if (!maybeDisplay?.bondStyle) {
    return undefined;
  }
  return maybeDisplay.bondStyle;
}

function atomicNumberForElement(element: string): number | undefined {
  return elementToAtomicNumber[element];
}

function elementFromCdxmlAtom(element: string | undefined): string {
  if (!element) {
    return "C";
  }
  const numeric = Number(element);
  if (Number.isInteger(numeric)) {
    return atomicNumberToElement[numeric] ?? "C";
  }
  return element;
}

function formatPoint(point: Point): string {
  return `${formatNumber(cssPxToCdxml(point.x))} ${formatNumber(cssPxToCdxml(point.y))}`;
}

function parseCdxmlPoint(point: string | undefined): Point {
  if (!point) {
    return { x: 0, y: 0 };
  }
  const [horizontal, vertical] = point.trim().split(/\s+/).map(Number);
  return {
    x: cdxmlToCssPx(Number.isFinite(horizontal) ? horizontal : 0),
    y: cdxmlToCssPx(Number.isFinite(vertical) ? vertical : 0)
  };
}

function formatBoundingBox(object: { x: number; y: number; width: number; height: number }): string {
  return `${formatNumber(cssPxToCdxml(object.x))} ${formatNumber(cssPxToCdxml(object.y))} ${formatNumber(cssPxToCdxml(object.x + object.width))} ${formatNumber(cssPxToCdxml(object.y + object.height))}`;
}

function formatLineBoundingBox(start: Point, end: Point): string {
  return `${formatNumber(cssPxToCdxml(Math.min(start.x, end.x)))} ${formatNumber(cssPxToCdxml(Math.min(start.y, end.y)))} ${formatNumber(cssPxToCdxml(Math.max(start.x, end.x)))} ${formatNumber(cssPxToCdxml(Math.max(start.y, end.y)))}`;
}

function parseBoundingBox(box: string | undefined): { x: number; y: number; width: number; height: number } {
  if (!box) {
    return { x: 0, y: 0, width: 1, height: 1 };
  }
  const [left, top, right, bottom] = box.trim().split(/\s+/).map(Number);
  const x = cdxmlToCssPx(Number.isFinite(left) ? left : 0);
  const y = cdxmlToCssPx(Number.isFinite(top) ? top : 0);
  return {
    x,
    y,
    width: Math.max(1, cdxmlToCssPx(Number.isFinite(right) ? right : left) - x),
    height: Math.max(1, cdxmlToCssPx(Number.isFinite(bottom) ? bottom : top) - y)
  };
}

function cssPxToCdxml(value: number): number {
  return value * cdxmlScale;
}

function cdxmlToCssPx(value: number): number {
  return value / cdxmlScale;
}

function formatNumber(value: number): string {
  const fixed = value.toFixed(4);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function boundsForAtoms(atoms: readonly MoleculeAtom[]): { x: number; y: number; width: number; height: number } {
  const xs = atoms.map((atom) => atom.x);
  const ys = atoms.map((atom) => atom.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX - 8,
    y: minY - 8,
    width: Math.max(16, maxX - minX + 16),
    height: Math.max(16, maxY - minY + 16)
  };
}

function resolveAnchorPoint(anchor: Anchor, objectsById: ReadonlyMap<string, DocumentObject>): Point | undefined {
  if (anchor.kind === "point" && anchor.point) {
    return anchor.point;
  }
  if (anchor.objectId) {
    const object = objectsById.get(anchor.objectId);
    if (object) {
      return { x: object.x + object.width / 2, y: object.y + object.height / 2 };
    }
  }
  return undefined;
}

function arrowKindFromCdxml(value: string): ArrowObject["arrowKind"] {
  if (value === "forward" || value === "equilibrium" || value === "retrosynthesis") {
    return value;
  }
  return "unknown";
}

function graphicKindFromCdxml(value: string | undefined): GraphicObject["graphicKind"] {
  if (value === "line" || value === "rect" || value === "ellipse" || value === "path" || value === "image") {
    return value;
  }
  if (value === "Line") {
    return "line";
  }
  return "unknown";
}

function parseInteger(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttribute(value: string): string {
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function indent(value: string, spaces: number): string {
  const prefix = " ".repeat(spaces);
  return value.split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function warning(code: string, message: string): CompatibilityConversionWarning {
  return { code, message };
}

function stripByteOrderMark(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const elementToAtomicNumber: Record<string, number> = {
  H: 1,
  He: 2,
  Li: 3,
  Be: 4,
  B: 5,
  C: 6,
  N: 7,
  O: 8,
  F: 9,
  Ne: 10,
  Na: 11,
  Mg: 12,
  Al: 13,
  Si: 14,
  P: 15,
  S: 16,
  Cl: 17,
  Ar: 18,
  K: 19,
  Ca: 20,
  Br: 35,
  I: 53
};

const atomicNumberToElement = Object.fromEntries(
  Object.entries(elementToAtomicNumber).map(([element, atomicNumber]) => [atomicNumber, element])
) as Record<number, string>;
