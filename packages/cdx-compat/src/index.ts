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
  type GraphicMarker,
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

/** The codec version ChemDraft wrote while its 2D CDXML attributes were y-first. Still READ (the
 *  embedded native payload is JSON and unaffected by the visible layer's coordinate order); its
 *  visible layer is transposed back on import. Never written again. */
export const CdxmlEnvelopeCodecVersionV1 = "chemdraft.cdxml.v1";

/** Current codec: spec-order visible layer ("x y" points, "left top right bottom" rectangles). */
export const CdxmlEnvelopeCodecVersion = "chemdraft.cdxml.v2";

const SupportedCdxmlEnvelopeCodecVersions: ReadonlySet<string> = new Set([
  CdxmlEnvelopeCodecVersionV1,
  CdxmlEnvelopeCodecVersion
]);
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
const defaultCdxmlStrokeColor = "#000000";
const defaultCdxmlFillColor = "none";
const defaultCdxmlLineWidthPx = 0.8;
const defaultCdxmlBoldWidthPx = 2.68;
const defaultCdxmlCornerRadiusFactor = 100;
// Arrowhead sizes for imported arrows. CDXML's arrowhead attributes name a head's shape but not its
// size, so an imported head takes the native arrow tools' default (documentWorkflow's artShapeTool
// defaults) and is indistinguishable from a drawn one.
const defaultCdxmlArrowheadSizePx = 16;
const defaultCdxmlHalfArrowheadSizePx = 14;
const standardCdxmlColorTable = [
  "#ffffff",
  "#000000",
  "#ff0000",
  "#ffff00",
  "#00ff00",
  "#00ffff",
  "#0000ff",
  "#ff00ff"
] as const;

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

interface CdxmlColorTable {
  colorByIndex: Map<number, string>;
}

interface CdxmlCrossingImportHint {
  sourceBondId: string;
  partnerBondIds: string[];
}

interface ImportPageContext {
  /** Import warnings for this page, so object importers can report an approximation in place. */
  warnings: CompatibilityConversionWarning[];
  bondRefsByCdxmlId: Map<string, BondRef>;
  zByRefKey: Map<string, number>;
  displayByRefKey: Map<string, string>;
  crossingHints: CdxmlCrossingImportHint[];
  colorTable: CdxmlColorTable;
}

type DoubleBondSide = NonNullable<MoleculeBond["display"]>["doubleBondSide"];
type BondDisplayStyle = NonNullable<MoleculeBond["display"]>["bondStyle"];
type CdxmlImportTransform = "none" | "transpose-legacy-v1";

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
  // Accept every codec this build understands, not just the current one: v1 files keep opening
  // exactly as they always did (their payload is the authority, and their visible layer is
  // transposed back when it has to be imported). Read-only migration — nothing is rewritten until
  // the user saves.
  if (codecVersion === undefined || !SupportedCdxmlEnvelopeCodecVersions.has(codecVersion)) {
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
    buildStandardColorTableXml(),
    ...pages,
    "</CDXML>",
    ""
  ].join("\n");
}

function buildStandardColorTableXml(): string {
  return [
    "  <colortable>",
    ...standardCdxmlColorTable.map((color) => {
      const rgb = hexToRgb(color) ?? { r: 0, g: 0, b: 0 };
      return `    <color r="${formatColorComponent(rgb.r)}" g="${formatColorComponent(rgb.g)}" b="${formatColorComponent(rgb.b)}"/>`;
    }),
    "  </colortable>"
  ].join("\n");
}

function buildPageXml(page: DocumentPage, children: string): string {
  const attributes = [
    `id="${escapeXmlAttribute(page.id)}"`,
    // "left top right bottom": a portrait page must export as width-then-height, or every
    // spec-conforming reader sees it as landscape.
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
    return exportReactionArrowObject(object, context.ids, allocator, objectsById, warnings);
  }
  if (object.type === "graphic") {
    return exportGraphicObject(object, context.ids, allocator, warnings);
  }
  if (object.type === "bracket") {
    warnings.push({
      code: "cdxml.bracket_payload_only",
      message: `Native ${object.bracketKind} brackets have no CDXML equivalent; the exported file keeps only a placeholder graphic, and the bracket is preserved exactly only in the embedded ChemDraft payload.`,
      sourceObjectId: object.id
    });
    return exportGraphicObject({
      id: object.id,
      type: "graphic",
      x: object.x,
      y: object.y,
      width: object.width,
      height: object.height,
      rotation: object.rotation,
      style: {},
      compatibility: object.compatibility,
      graphicKind: "path",
      data: {}
    }, context.ids, allocator, warnings);
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
  const bondStyle = cdxmlBondDisplayForBondStyle(bond.display);
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
  objectsById: ReadonlyMap<string, DocumentObject>,
  warnings: CompatibilityConversionWarning[]
): string {
  const graphicId = idFor(ids, arrow.id, allocator);
  const start = resolveAnchorPoint(arrow.start, objectsById) ?? { x: arrow.x, y: arrow.y + arrow.height / 2 };
  const end = resolveAnchorPoint(arrow.end, objectsById) ?? { x: arrow.x + arrow.width, y: arrow.y + arrow.height / 2 };
  const arrowType = cdxmlArrowTypeForKind(arrow.arrowKind);
  if (arrowType === undefined) {
    // "unknown" means the source document's arrow type was not one this build understands. Writing
    // a concrete spelling would launder that into a claim — a plain reaction arrow — that survives
    // every later round trip. Omitting the attribute keeps the line and leaves the type unstated.
    warnings.push({
      code: "cdxml.arrow_type_unknown",
      message:
        "A reaction arrow of an unrecognized type was exported as a plain line with no ArrowType, " +
        "because inventing a type would misstate the original.",
      sourceObjectId: arrow.id
    });
  }
  const arrowTypeAttribute = arrowType === undefined ? "" : ` ArrowType="${escapeXmlAttribute(arrowType)}"`;
  return `<graphic id="${graphicId}" GraphicType="Line"${arrowTypeAttribute} BoundingBox="${formatLineBoundingBox(start, end)}" Start="${formatPoint(start)}" End="${formatPoint(end)}"/>`;
}

function exportGraphicObject(
  graphic: GraphicObject,
  ids: Map<string, string>,
  allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[]
): string {
  const graphicId = idFor(ids, graphic.id, allocator);
  warnForGraphicCdxmlLimitations(graphic, warnings);
  if (isSemanticReactionArrowGraphic(graphic)) {
    return exportSemanticReactionArrowGraphic(graphic, graphicId, warnings);
  }
  if (graphic.compatibility?.unknown.cdxmlElementName === "arrow") {
    return exportGraphicAsCdxmlArrow(graphic, graphicId, warnings);
  }
  return exportGraphicAsCdxmlGraphic(graphic, graphicId, warnings);
}

/** The chemical arrow kind an art arrow stands in for, or undefined for a plain (decorative) art
 *  arrow. Reaction/resonance arrows are drawn with the art-arrow tools for their rich editing but
 *  carry their chemistry in `artToolId`, which is how the CDXML layer knows to write/read them as
 *  reaction arrows rather than generic graphics. */
function semanticReactionArrowKind(
  graphic: GraphicObject
): "forward" | "resonance" | "equilibrium" | "retrosynthesis" | undefined {
  if (
    graphic.data.artToolId === "reactionArrow" ||
    graphic.data.artToolId === "reactionArrowBold" ||
    graphic.data.artToolId === "reactionArrowDashed"
  ) {
    return "forward";
  }
  if (graphic.data.artToolId === "resonanceArrow") {
    return "resonance";
  }
  if (graphic.data.artToolId === "equilibriumArrow") {
    return "equilibrium";
  }
  if (graphic.data.artToolId === "retroArrow") {
    return "retrosynthesis";
  }
  return undefined;
}

function isSemanticReactionArrowGraphic(graphic: GraphicObject): boolean {
  return semanticReactionArrowKind(graphic) !== undefined;
}

/** Export a reaction/resonance-tagged art arrow as the standard CDXML reaction arrow
 *  (`<graphic GraphicType="Line" ArrowType=…>`) so other programs read it as a reaction arrow. The
 *  exact art geometry (arc, arrowhead size, style) still round-trips within ChemDraft via the
 *  embedded native payload; this is purely the interop representation. */
function exportSemanticReactionArrowGraphic(
  graphic: GraphicObject,
  graphicId: string,
  warnings: CompatibilityConversionWarning[]
): string {
  const line = graphicLineEndpointsForCdxml(graphic);
  const arrowKind = semanticReactionArrowKind(graphic) ?? "forward";
  const arrowType = cdxmlArrowTypeByKind[arrowKind];
  // Appearance rides the same helpers every other graphic export uses; without them a dashed or
  // coloured reaction arrow reopened elsewhere as a default solid black one, silently and with no
  // warning. The colour helper also raises the out-of-table warning, so this path stops reporting
  // clean on a lossy export.
  const attributes = [
    `id="${graphicId}"`,
    `GraphicType="Line"`,
    `ArrowType="${escapeXmlAttribute(arrowType)}"`,
    ...cdxmlGraphicColorAttribute(graphic, warnings),
    ...cdxmlLineTypeAttributes(graphic),
    `BoundingBox="${formatLineBoundingBox(line.start, line.end)}"`,
    `Start="${formatPoint(line.start)}"`,
    `End="${formatPoint(line.end)}"`
  ];
  warnForSemanticArrowHeadLoss(graphic, arrowKind, warnings);
  return `<graphic ${attributes.join(" ")}/>`;
}

/** Standard CDXML carries an arrow's heads in the closed `ArrowType` enum, so a head the user
 *  removed or swapped (a bare tail, a bar head) cannot be represented — it reopens elsewhere as the
 *  kind's default. Say so rather than exporting a silent lie. */
function warnForSemanticArrowHeadLoss(
  graphic: GraphicObject,
  arrowKind: "forward" | "resonance" | "equilibrium" | "retrosynthesis",
  warnings: CompatibilityConversionWarning[]
): void {
  const headKind = graphic.data.markerEnd?.kind;
  const tailKind = graphic.data.markerStart?.kind;
  const expectsTail = arrowKind === "resonance" || arrowKind === "equilibrium";
  const headMissing = arrowKind !== "retrosynthesis" && (headKind === undefined || headKind === "none");
  const tailMismatch = expectsTail
    ? tailKind === undefined || tailKind === "none"
    : tailKind !== undefined && tailKind !== "none";
  if (!headMissing && !tailMismatch) {
    return;
  }

  warnings.push({
    code: "cdxml.arrow_head_payload_only",
    message: `Arrowhead changes on this ${arrowKind} arrow are preserved exactly only in the embedded ChemDraft payload; standard CDXML reopens it with the default heads for ArrowType.`,
    sourceObjectId: graphic.id
  });
}

function warnForGraphicCdxmlLimitations(
  graphic: GraphicObject,
  warnings: CompatibilityConversionWarning[]
): void {
  const color = graphic.style.strokeColor ?? graphic.style.color ?? graphic.style.fillColor;
  if (typeof color === "string" && color.length > 0 && color.toLowerCase() !== "none" && cdxmlColorIndexForHex(color) === undefined) {
    warnings.push({
      code: "cdxml.graphic_color_approximation",
      message: `Native graphic color "${color}" is not in the standard ChemDraw color table and is preserved exactly only in the embedded ChemDraft payload.`,
      sourceObjectId: graphic.id
    });
  }

  if (graphic.style.fillMode === "gloss" && graphic.graphicKind !== "ellipse") {
    warnings.push({
      code: "cdxml.graphic_gloss_payload_only",
      message: "Native non-oval gloss graphics are preserved exactly only in the embedded ChemDraft payload.",
      sourceObjectId: graphic.id
    });
  }

  if (graphic.style.effect === "reflection") {
    warnings.push({
      code: "cdxml.graphic_effect_payload_only",
      message: "Native reflection graphics are preserved exactly only in the embedded ChemDraft payload.",
      sourceObjectId: graphic.id
    });
  }

  const tiltX = typeof graphic.style.tiltXDegrees === "number" ? graphic.style.tiltXDegrees : 0;
  const tiltY = typeof graphic.style.tiltYDegrees === "number" ? graphic.style.tiltYDegrees : 0;
  if (Math.abs(tiltX) >= 0.001 || Math.abs(tiltY) >= 0.001) {
    warnings.push({
      code: "cdxml.graphic_tilt_payload_only",
      message: "Native X/Y tilt is preserved exactly only in the embedded ChemDraft payload.",
      sourceObjectId: graphic.id
    });
  }

  if (graphic.data.pathD && !graphic.data.artPathKind) {
    warnings.push({
      code: "cdxml.graphic_custom_path_payload_only",
      message: "Native custom graphic paths are preserved exactly only in the embedded ChemDraft payload.",
      sourceObjectId: graphic.id
    });
  }

  // Bezier, polyline, and freehand geometry has no CDXML graphic type, so it exports as
  // GraphicType="Unknown" with only a bounding box. The earlier pathD check misses these because
  // they carry an artPathKind — which is how the orbital tools' curves left silently.
  const hasPathGeometry = Boolean(
    (graphic.data.pathNodes && graphic.data.pathNodes.length > 0) ||
      graphic.data.pathD ||
      graphic.data.freehandOptions
  );
  if (hasPathGeometry && cdxmlGraphicTypeForNativeGraphic(graphic) === "Unknown") {
    warnings.push({
      code: "cdxml.graphic_shape_payload_only",
      message: `Native ${graphic.data.artPathKind ?? graphic.graphicKind} geometry has no CDXML graphic type; the exported file keeps only its bounding box, and the shape is preserved exactly only in the embedded ChemDraft payload.`,
      sourceObjectId: graphic.id
    });
  }

  if (graphic.data.pathControlPoint) {
    warnings.push({
      code: "cdxml.graphic_path_control_payload_only",
      message: "Native path bend control points are preserved exactly only in the embedded ChemDraft payload.",
      sourceObjectId: graphic.id
    });
  }
}

function exportGraphicAsCdxmlGraphic(
  graphic: GraphicObject,
  graphicId: string,
  warnings: CompatibilityConversionWarning[]
): string {
  const type = cdxmlGraphicTypeForNativeGraphic(graphic);
  const attrs = [
    `id="${graphicId}"`,
    ...cdxmlGraphicColorAttribute(graphic, warnings),
    `GraphicType="${type}"`,
    `BoundingBox="${escapeXmlAttribute(cdxmlBoundingBoxForGraphic(graphic, objectCornerPoints(graphic)))}"`,
    ...(type === "Line" || type === "Arc" ? cdxmlLineTypeAttributes(graphic) : []),
    ...cdxmlShapeSubtypeAttributes(graphic)
  ];
  if (type === "Oval" || type === "Rectangle") {
    attrs.push(...cdxmlAxisAttributes(graphic));
  }
  if (type === "Line" || type === "Arc") {
    attrs.push(...cdxmlGraphicLineAttributes(graphic));
  }
  return `<graphic ${attrs.join(" ")}/>`;
}

function exportGraphicAsCdxmlArrow(
  graphic: GraphicObject,
  graphicId: string,
  warnings: CompatibilityConversionWarning[]
): string {
  const line = graphicLineEndpointsForCdxml(graphic);
  const isArc = graphic.data.artPathKind === "arc" && !pointMetadata(graphic.data.pathControlPoint);
  const attrs = [
    `id="${graphicId}"`,
    `BoundingBox="${escapeXmlAttribute(cdxmlBoundingBoxForGraphic(graphic, [line.start, line.end]))}"`,
    ...cdxmlGraphicColorAttribute(graphic, warnings),
    ...cdxmlLineTypeAttributes(graphic),
    'FillType="None"',
    ...cdxmlArrowheadAttributes(graphic, warnings),
    ...(isArc ? [`AngularSize="${escapeXmlAttribute(cdxmlAngularSizeForGraphic(graphic))}"`] : []),
    `Head3D="${formatXyPoint(line.end)}"`,
    `Tail3D="${formatXyPoint(line.start)}"`,
    ...cdxmlLineAxisAttributes(line.start, line.end)
  ];
  return `<arrow ${attrs.join(" ")}/>`;
}

/** The write side of {@link cdxmlArrowMarkers}: name which ends are headed and how, so an arrow
 *  keeps its head across a round trip. Every exported `<arrow>` used to claim `ArrowheadType="Solid"`
 *  with no `ArrowheadHead`, which reads back — correctly — as a headless line.
 *
 *  `ArrowheadType` is written even when neither end is headed, matching what ChemDraw itself writes
 *  for a plain line arrow. */
function cdxmlArrowheadAttributes(
  graphic: GraphicObject,
  warnings: CompatibilityConversionWarning[]
): string[] {
  const head = cdxmlArrowheadForMarker(graphic.data.markerEnd);
  const tail = cdxmlArrowheadForMarker(graphic.data.markerStart);
  warnForUnrepresentableArrowheads(graphic, warnings);
  return [
    ...(head ? [`ArrowheadHead="${head.head}"`] : []),
    ...(tail ? [`ArrowheadTail="${tail.head}"`] : []),
    `ArrowheadType="${head?.type ?? tail?.type ?? "Solid"}"`
  ];
}

function cdxmlArrowheadForMarker(marker: GraphicMarker | undefined): { head: string; type: string } | undefined {
  switch (marker?.kind) {
    case "filled-arrow":
      return { head: "Full", type: "Solid" };
    case "open-arrow":
      return { head: "Full", type: "Angle" };
    // CDXML's half heads are handed and the native one is not, so this picks a side rather than
    // inventing one from geometry; the native payload carries the exact head for ChemDraft readers.
    case "half-arrow":
      return { head: "HalfLeft", type: "Solid" };
    default:
      return undefined;
  }
}

/** CDXML's arrowhead enum covers full, half, and unfilled heads and nothing else, so the decorative
 *  native heads have no spelling. Drop them with a warning rather than exporting a full head that
 *  claims the user drew something they didn't. */
function warnForUnrepresentableArrowheads(
  graphic: GraphicObject,
  warnings: CompatibilityConversionWarning[]
): void {
  const dropped = [graphic.data.markerEnd, graphic.data.markerStart].filter(
    (marker): marker is GraphicMarker =>
      marker !== undefined && marker.kind !== "none" && cdxmlArrowheadForMarker(marker) === undefined
  );
  if (dropped.length === 0) {
    return;
  }
  warnings.push({
    code: "cdxml.arrow_marker_payload_only",
    message: `Native ${[...new Set(dropped.map((marker) => marker.kind))].join(" and ")} arrowheads have no CDXML spelling; the exported arrow has no head there, and they are preserved exactly only in the embedded ChemDraft payload.`,
    sourceObjectId: graphic.id
  });
}

function cdxmlGraphicTypeForNativeGraphic(graphic: GraphicObject): "Arc" | "Line" | "Oval" | "Rectangle" | "Unknown" {
  if (graphic.graphicKind === "ellipse") {
    return "Oval";
  }
  if (graphic.graphicKind === "rect") {
    return "Rectangle";
  }
  if (graphic.data.artPathKind === "arc" && !pointMetadata(graphic.data.pathControlPoint)) {
    return "Arc";
  }
  if (
    graphic.graphicKind === "line" ||
    graphic.data.artPathKind === "line" ||
    graphic.data.artPathKind === "wavy" ||
    graphic.data.artPathKind === "quadratic"
  ) {
    return "Line";
  }
  return "Unknown";
}

function cdxmlShapeSubtypeAttributes(graphic: GraphicObject): string[] {
  const attrs: string[] = [];
  if (graphic.graphicKind === "ellipse") {
    const ovalType = cdxmlOvalTypeForGraphic(graphic);
    if (ovalType) {
      attrs.push(`OvalType="${ovalType}"`);
    }
  }
  if (graphic.graphicKind === "rect") {
    const rectangleType = cdxmlRectangleTypeForGraphic(graphic);
    if (rectangleType) {
      attrs.push(`RectangleType="${rectangleType}"`);
    }
    if (graphic.data.cornerRadiusPx !== undefined) {
      attrs.push(`CornerRadius="${formatNumber(cssPxToCdxml(graphic.data.cornerRadiusPx) * defaultCdxmlCornerRadiusFactor)}"`);
    }
  }
  if (graphic.style.effect === "shadow") {
    attrs.push('ShadowSize="400"');
  }
  return attrs;
}

function cdxmlOvalTypeForGraphic(graphic: GraphicObject): string | undefined {
  if (graphic.style.fillMode === "gloss") {
    return graphic.width > 0 && Math.abs(graphic.width - graphic.height) / graphic.width < 0.05
      ? "Circle Shaded"
      : "Shaded";
  }
  if (graphic.style.effect === "shadow") {
    return "Shadowed";
  }
  if (graphicHasVisibleFill(graphic)) {
    return "Filled";
  }
  return undefined;
}

function cdxmlRectangleTypeForGraphic(graphic: GraphicObject): string | undefined {
  const roundEdge = typeof graphic.data.cornerRadiusPx === "number" && graphic.data.cornerRadiusPx > 0;
  const dashed = Boolean(graphic.style.strokeDasharray);
  const shadow = graphic.style.effect === "shadow";
  if (roundEdge && shadow) {
    return "RoundEdge Shadow";
  }
  if (roundEdge && dashed) {
    return "RoundEdge Dashed";
  }
  if (roundEdge) {
    return "RoundEdge";
  }
  if (shadow) {
    return "Shadow";
  }
  if (graphicHasVisibleFill(graphic)) {
    return "Filled";
  }
  return dashed ? "Dashed" : undefined;
}

function cdxmlLineTypeAttributes(graphic: GraphicObject): string[] {
  const lineType = cdxmlLineTypeForGraphic(graphic);
  return lineType ? [`LineType="${lineType}"`] : [];
}

function cdxmlLineTypeForGraphic(graphic: GraphicObject): string | undefined {
  if (graphic.data.artPathKind === "wavy") {
    return "Wavy";
  }
  if (graphic.style.strokeDasharray) {
    return "Dashed";
  }
  const strokeWidth = typeof graphic.style.strokeWidth === "number" ? graphic.style.strokeWidth : defaultCdxmlLineWidthPx;
  return strokeWidth >= defaultCdxmlBoldWidthPx ? "Bold" : undefined;
}

function cdxmlGraphicColorAttribute(
  graphic: GraphicObject,
  warnings: CompatibilityConversionWarning[]
): string[] {
  // CDXML graphics carry a single color attribute. On import it becomes the stroke color, and only
  // for "Filled"/"Shaded" subtypes does it also become the fill. So those shapes must export their
  // fill color (not stroke) to round-trip the visible fill; every other subtype keeps the stroke.
  const subtype = cdxmlShapeSubtypeForColor(graphic);
  const fillDerivedFromColor = subtype.includes("filled") || subtype.includes("shaded");
  const strokeColor = graphic.style.strokeColor ?? graphic.style.color;
  const fillColor = graphic.style.fillColor;
  const color = fillDerivedFromColor
    ? fillColor ?? graphic.style.color ?? strokeColor
    : strokeColor ?? fillColor;
  if (
    fillDerivedFromColor &&
    strokeColor &&
    fillColor &&
    normalizeHexColor(strokeColor) !== normalizeHexColor(fillColor)
  ) {
    warnings.push({
      code: "cdxml.graphic_single_color",
      message: "CDXML graphics store a single color; the visible fill was preserved and the distinct stroke color was dropped.",
      sourceObjectId: graphic.id
    });
  }
  if (!color || color.toLowerCase() === "none") {
    return [];
  }
  const index = cdxmlColorIndexForHex(color);
  if (index === undefined) {
    return [];
  }
  return [`color="${index}"`];
}

function cdxmlShapeSubtypeForColor(graphic: GraphicObject): string {
  const subtype = graphic.graphicKind === "ellipse"
    ? cdxmlOvalTypeForGraphic(graphic)
    : graphic.graphicKind === "rect"
      ? cdxmlRectangleTypeForGraphic(graphic)
      : undefined;
  return (subtype ?? "").toLowerCase();
}

function cdxmlBoundingBoxForGraphic(graphic: GraphicObject, fallbackPoints: readonly Point[]): string {
  const imported = graphic.compatibility?.unknown.cdxmlBoundingBox;
  if (typeof imported === "string") {
    const importedBounds = parseCdxmlXyBoundingBox(imported);
    if (importedBounds && boxesApproximatelyEqual(importedBounds, graphic)) {
      return imported;
    }
  }
  return formatXyBoundingBox(fallbackPoints);
}

function boxesApproximatelyEqual(
  left: { x: number; y: number; width: number; height: number },
  right: { x: number; y: number; width: number; height: number }
): boolean {
  return nearlyEqual(left.x, right.x) &&
    nearlyEqual(left.y, right.y) &&
    nearlyEqual(left.width, right.width) &&
    nearlyEqual(left.height, right.height);
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.01;
}

function cdxmlColorIndexForHex(color: string): number | undefined {
  const normalized = normalizeHexColor(color);
  if (!normalized) {
    return undefined;
  }
  if (normalized === "#000000") {
    return 0;
  }
  if (normalized === "#ffffff") {
    return 1;
  }
  const index = standardCdxmlColorTable.findIndex((candidate) => candidate === normalized);
  return index >= 0 ? index + 2 : undefined;
}

function normalizeHexColor(color: string): string | undefined {
  const rgb = hexToRgb(color);
  return rgb ? rgbToHexColor(rgb.r, rgb.g, rgb.b) : undefined;
}

function graphicHasVisibleFill(graphic: GraphicObject): boolean {
  const fill = graphic.style.fillColor;
  return typeof fill === "string" && fill.length > 0 && fill.toLowerCase() !== "none";
}

function cdxmlAxisAttributes(graphic: GraphicObject): string[] {
  const center = objectCenter(graphic);
  return [
    `Center3D="${formatXyPoint(center)}"`,
    `MajorAxisEnd3D="${formatXyPoint({ x: graphic.x + graphic.width, y: center.y })}"`,
    `MinorAxisEnd3D="${formatXyPoint({ x: center.x, y: graphic.y + graphic.height })}"`
  ];
}

function cdxmlGraphicLineAttributes(graphic: GraphicObject): string[] {
  const line = graphicLineEndpointsForCdxml(graphic);
  return [
    `Start="${formatPoint(line.start)}"`,
    `End="${formatPoint(line.end)}"`,
    ...(graphic.data.artPathKind === "arc" && !pointMetadata(graphic.data.pathControlPoint) ? [`AngularSize="${escapeXmlAttribute(cdxmlAngularSizeForGraphic(graphic))}"`] : [])
  ];
}

function cdxmlAngularSizeForGraphic(graphic: GraphicObject): string {
  const imported = graphic.compatibility?.unknown.cdxmlAngularSize;
  if (graphic.data.arcSweepRadians === undefined && typeof imported === "string" && imported.trim().length > 0) {
    return imported;
  }
  return formatNumber(radiansToDegrees(clampArcSweepRadians(graphic.data.arcSweepRadians ?? Math.PI)));
}

function cdxmlLineAxisAttributes(start: Point, end: Point): string[] {
  const center = {
    x: (start.x + end.x) / 2,
    y: (start.y + end.y) / 2
  };
  const length = Math.max(Math.hypot(end.x - start.x, end.y - start.y), 1);
  return [
    `Center3D="${formatXyPoint(center)}"`,
    `MajorAxisEnd3D="${formatXyPoint({ x: center.x + length, y: center.y })}"`,
    `MinorAxisEnd3D="${formatXyPoint({ x: center.x, y: center.y + length })}"`
  ];
}

function graphicLineEndpointsForCdxml(graphic: GraphicObject): { start: Point; end: Point } {
  if (graphic.data.artPathKind === "arc" && !pointMetadata(graphic.data.pathControlPoint)) {
    return circularGraphicArcEndpoints(graphic);
  }

  const start = pointMetadata(graphic.data.lineStart);
  const end = pointMetadata(graphic.data.lineEnd);
  return start && end
    ? { start, end }
    : {
        start: { x: graphic.x, y: graphic.y },
        end: { x: graphic.x + graphic.width, y: graphic.y + graphic.height }
      };
}

function circularGraphicArcEndpoints(graphic: GraphicObject): { start: Point; end: Point } {
  const angles = nativeGraphicArcAngles(graphic);
  const center = objectCenter(graphic);
  const rx = Math.max(graphic.width / 2 - 4, 1);
  const ry = Math.max(graphic.height / 2 - 4, 1);
  return {
    start: ellipsePointAtRadians(center, rx, ry, angles.startRadians),
    end: ellipsePointAtRadians(center, rx, ry, angles.endRadians)
  };
}

function nativeGraphicArcAngles(graphic: GraphicObject): { startRadians: number; sweepRadians: number; endRadians: number } {
  const sweepRadians = clampArcSweepRadians(graphic.data.arcSweepRadians ?? Math.PI);
  const startRadians = typeof graphic.data.arcStartRadians === "number" && Number.isFinite(graphic.data.arcStartRadians)
    ? graphic.data.arcStartRadians
    : -Math.PI / 2 - sweepRadians / 2;
  return {
    startRadians,
    sweepRadians,
    endRadians: startRadians + sweepRadians
  };
}

function pointMetadata(value: unknown): Point | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const point = value as Record<string, unknown>;
  const x = point.x;
  const y = point.y;
  return typeof x === "number" && Number.isFinite(x) && typeof y === "number" && Number.isFinite(y)
    ? { x, y }
    : undefined;
}

function objectCenter(object: { x: number; y: number; width: number; height: number }): Point {
  return {
    x: object.x + object.width / 2,
    y: object.y + object.height / 2
  };
}

function ellipsePointAtRadians(center: Point, rx: number, ry: number, radians: number): Point {
  return {
    x: center.x + Math.cos(radians) * rx,
    y: center.y + Math.sin(radians) * ry
  };
}

function ellipseAngleRadiansForPoint(center: Point, rx: number, ry: number, point: Point): number {
  return Math.atan2((point.y - center.y) / Math.max(ry, 1), (point.x - center.x) / Math.max(rx, 1));
}

function degreesToRadians(degrees: number): number {
  return degrees * Math.PI / 180;
}

function radiansToDegrees(radians: number): number {
  return radians * 180 / Math.PI;
}

function clampArcSweepRadians(radians: number): number {
  // Clamp the sweep magnitude but keep its direction; a negative sweep encodes a clockwise arc and
  // both the exported endpoints and the AngularSize must preserve that sign to stay faithful.
  const magnitude = Math.max(Math.PI / 180, Math.min(Math.PI * 2 - Math.PI / 1800, Math.abs(radians)));
  return radians < 0 ? -magnitude : magnitude;
}

function objectCornerPoints(object: { x: number; y: number; width: number; height: number }): Point[] {
  return [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y + object.height }
  ];
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

  const importTransform = importTransformForTree(tree);
  const colorTable = importCdxmlColorTable(tree);
  const base = createEmptyDocument({ title: "Imported CDXML.chemdraft", now: nativeImportTimestamp });
  const importedPages = pageElements.map((pageElement, pageIndex) => {
    const pageTemplate = base.pages[0];
    const importedPage = applyImportTransformToPageObjects(
      importPageObjects(pageElement, pageIndex, warnings, colorTable),
      importTransform
    );
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
  warnings: CompatibilityConversionWarning[],
  colorTable: CdxmlColorTable
): { objects: DocumentObject[]; crossings: CrossingOverride[] } {
  const objects: DocumentObject[] = [];
  const context: ImportPageContext = {
    warnings,
    bondRefsByCdxmlId: new Map(),
    zByRefKey: new Map(),
    displayByRefKey: new Map(),
    crossingHints: [],
    colorTable
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
      const graphic = importGraphic(element, pageIndex, objectIndex, context);
      if (graphic) {
        objects.push(graphic);
        objectIndex += 1;
      }
      continue;
    }
    if (element.name === "arrow") {
      objects.push(importArrowGraphic(element, pageIndex, objectIndex, context));
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

function applyImportTransformToPageObjects(
  page: { objects: DocumentObject[]; crossings: CrossingOverride[] },
  transform: CdxmlImportTransform
): { objects: DocumentObject[]; crossings: CrossingOverride[] } {
  if (transform === "none" || page.objects.length === 0) {
    return page;
  }

  return {
    ...page,
    objects: page.objects.map((object) => transposeImportedObject(object))
  };
}

/**
 * Undo a codec-v1 misread. ChemDraft wrote every 2D CDXML attribute y-first through v1; reading such
 * a file with the (correct) x-first parsers yields the exact TRANSPOSE of the true geometry, so
 * swapping x/y back recovers it — no rotation, no reflection, and it is its own inverse.
 *
 * This replaced a CCW-90 rotation applied to any file whose CreationProgram said "ChemDraw". That
 * rotation existed to paper over the same y-first misread, but transpose ∘ rotation has determinant
 * −1: the net import of a real ChemDraw file was a MIRROR. Wedge/hash geometry flipped while `AS`
 * R/S strings imported verbatim, so the document claimed R over a depiction showing S.
 */
function transposeImportedObject(object: DocumentObject): DocumentObject {
  if (object.type === "molecule") {
    const atoms = object.atoms.map((atom) => {
      const point = transposePoint(atom);
      if (!atom.labelOffset) {
        return { ...atom, ...point };
      }
      return {
        ...atom,
        ...point,
        labelOffset: { x: atom.labelOffset.y, y: atom.labelOffset.x }
      };
    });
    return {
      ...object,
      ...boundsForAtoms(atoms),
      atoms
    };
  }

  if (object.type === "reaction-arrow") {
    const start = object.start.kind === "point" && object.start.point
      ? { ...object.start, point: transposePoint(object.start.point) }
      : object.start;
    const end = object.end.kind === "point" && object.end.point
      ? { ...object.end, point: transposePoint(object.end.point) }
      : object.end;
    const pointBounds = start.kind === "point" && start.point && end.kind === "point" && end.point
      ? boundsForPoints([start.point, end.point])
      : transposeBox(object);
    return { ...object, ...pointBounds, start, end };
  }

  if (object.type === "graphic") {
    const data = { ...object.data };
    for (const key of ["lineStart", "lineEnd", "pathControlPoint", "arcCenter"] as const) {
      const point = data[key];
      if (point && typeof point === "object" && typeof point.x === "number" && typeof point.y === "number") {
        data[key] = transposePoint(point);
      }
    }
    return { ...object, ...transposeBox(object), data };
  }

  return { ...object, ...transposeBox(object) } as DocumentObject;
}

function transposeBox(
  box: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  return { x: box.y, y: box.x, width: box.height, height: box.width };
}

function transposePoint(point: Point): Point {
  return { x: point.y, y: point.x };
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
  const cdxmlAtomStereochemistryByAtomId: Record<string, { assignment: "R" | "S"; cdxmlAtomId: string; geometry?: string }> = {};
  const atoms: MoleculeAtom[] = atomElements.map((atomElement, atomIndex) => {
    const atomId = `atom_${String(atomIndex + 1).padStart(3, "0")}`;
    const cdxmlId = atomElement.attributes.id ?? atomId;
    atomIdByCdxmlId.set(cdxmlId, atomId);
    const point = parseCdxmlPoint(atomElement.attributes.p);
    const labelPoint = cdxmlAtomLabelPoint(atomElement);
    const element = elementFromCdxmlAtom(atomElement.attributes.Element);
    const stereoAssignment = cdxmlAtomStereoAssignment(atomElement.attributes.AS);
    if (stereoAssignment) {
      const geometry = atomElement.attributes.Geometry?.trim();
      cdxmlAtomStereochemistryByAtomId[atomId] = {
        assignment: stereoAssignment,
        cdxmlAtomId: cdxmlId,
        ...(geometry ? { geometry } : {})
      };
    }
    return {
      id: atomId,
      element,
      x: point.x,
      y: point.y,
      formalCharge: parseInteger(atomElement.attributes.Charge) ?? 0,
      ...(labelPoint ? { labelOffset: { x: labelPoint.x - point.x, y: labelPoint.y - point.y } } : {})
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
    const bondDisplay = cdxmlBondDisplay(bondElement.attributes.Display);
    if (bondDisplay) {
      bond.display = { ...(bond.display ?? {}), bondStyle: bondDisplay.bondStyle };
      if (bondDisplay.narrowAtEnd) {
        // CDXML WedgeEnd/WedgedHashEnd put the narrow (stereocenter) end at E; ChemDraft
        // keeps the narrow end at fromAtomId, so swap B/E to preserve the wedge direction.
        const narrowAtomId = bond.toAtomId;
        bond.toAtomId = bond.fromAtomId;
        bond.fromAtomId = narrowAtomId;
      }
    } else if (bondElement.attributes.Display) {
      warnings.push({
        code: "cdxml.bond_display_unsupported",
        message: `CDXML bond display "${bondElement.attributes.Display}" is not represented in the current ChemDraft molecule schema.`,
        sourceObjectId: objectId
      });
    }
    return bond;
  });
  const normalizedBonds = refreshImportedCyclicDoubleBondSides(atoms, bonds);
  const atomStereochemistry = Object.entries(cdxmlAtomStereochemistryByAtomId).map(
    ([atomId, stereo]) => `${atomId}:${stereo.assignment}`
  );
  const chemistry: MoleculeObject["chemistry"] | undefined = atomStereochemistry.length > 0
    ? {
        atomCount: atoms.length,
        bondCount: normalizedBonds.length,
        radicalCount: 0,
        isotopeLabels: [],
        stereochemistry: atomStereochemistry,
        warnings: []
      }
    : undefined;
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
    ...(chemistry ? { chemistry } : {}),
    atoms,
    bonds: normalizedBonds,
    superatoms: [],
    rGroups: [],
    compatibility: {
      sourceFormat: "cdxml",
      originalId: fragment.attributes.id,
      warnings: [compatibilityWarning],
      unknown: Object.keys(cdxmlAtomStereochemistryByAtomId).length > 0
        ? { cdxmlAtomStereochemistryByAtomId }
        : {}
    }
  };
}

interface ImportedRingCycle {
  atomIds: string[];
  bondIds: string[];
  center: Point;
}

function refreshImportedCyclicDoubleBondSides(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[]
): MoleculeBond[] {
  const cycles = findImportedRingCycles(atoms, bonds, new Set([5, 6]));
  if (cycles.length === 0) {
    return [...bonds];
  }

  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const cyclesByBondId = new Map<string, ImportedRingCycle[]>();
  cycles.forEach((cycle) => {
    cycle.bondIds.forEach((bondId) => {
      cyclesByBondId.set(bondId, [...(cyclesByBondId.get(bondId) ?? []), cycle]);
    });
  });

  return bonds.map((bond) => {
    if (bond.order !== "double") {
      return bond;
    }

    const owningCycles = cyclesByBondId.get(bond.id) ?? [];
    const fromAtom = atomById.get(bond.fromAtomId);
    const toAtom = atomById.get(bond.toAtomId);
    if (owningCycles.length === 0 || !fromAtom || !toAtom) {
      return bond;
    }

    const currentSide = bond.display?.doubleBondSide;
    // Prefer the ring whose centroid already matches the current side; otherwise place the
    // secondary line in the smallest owning ring (the conventional choice for fused systems),
    // with a stable secondary key so the result is deterministic regardless of traversal order.
    const cycle =
      owningCycles.find((candidate) => sideForPointRelativeToBond(fromAtom, toAtom, candidate.center) === currentSide)
      ?? [...owningCycles].sort(
        (left, right) =>
          left.atomIds.length - right.atomIds.length ||
          canonicalImportedRingCycleKey(left.bondIds).localeCompare(canonicalImportedRingCycleKey(right.bondIds))
      )[0];
    const side = cycle ? sideForPointRelativeToBond(fromAtom, toAtom, cycle.center) : undefined;
    if (!side || currentSide === side) {
      return bond;
    }

    return {
      ...bond,
      display: { ...(bond.display ?? {}), doubleBondSide: side }
    };
  });
}

const IMPORTED_RING_CYCLE_VISIT_LIMIT = 250_000;

function findImportedRingCycles(
  atoms: readonly MoleculeAtom[],
  bonds: readonly MoleculeBond[],
  ringSizes: ReadonlySet<number>
): ImportedRingCycle[] {
  const targetSizes = [...ringSizes].filter((size) => Number.isInteger(size) && size >= 3).sort((a, b) => a - b);
  const maxRingSize = targetSizes[targetSizes.length - 1];
  if (maxRingSize === undefined) {
    return [];
  }

  const atomById = new Map(atoms.map((atom) => [atom.id, atom]));
  const adjacency = new Map<string, { atomId: string; bondId: string }[]>();
  bonds.forEach((bond) => {
    if (!atomById.has(bond.fromAtomId) || !atomById.has(bond.toAtomId)) {
      return;
    }

    adjacency.set(bond.fromAtomId, [
      ...(adjacency.get(bond.fromAtomId) ?? []),
      { atomId: bond.toAtomId, bondId: bond.id }
    ]);
    adjacency.set(bond.toAtomId, [
      ...(adjacency.get(bond.toAtomId) ?? []),
      { atomId: bond.fromAtomId, bondId: bond.id }
    ]);
  });

  const cycles = new Map<string, ImportedRingCycle>();
  // Bound the path enumeration: dense polycyclic graphs (e.g. metal-organic cages) can make
  // the DFS combinatorial. Normal organic structures never approach this budget; pathological
  // inputs degrade gracefully (some cyclic double-bond sides left un-normalized) instead of hanging.
  let visitBudget = IMPORTED_RING_CYCLE_VISIT_LIMIT;
  const visit = (startAtomId: string, atomId: string, atomIds: string[], bondIds: string[]) => {
    if (visitBudget <= 0) {
      return;
    }
    visitBudget -= 1;
    if (ringSizes.has(atomIds.length)) {
      const closingBond = (adjacency.get(atomId) ?? []).find((edge) => edge.atomId === startAtomId);
      if (closingBond) {
        const cycleBondIds = [...bondIds, closingBond.bondId];
        const key = canonicalImportedRingCycleKey(cycleBondIds);
        if (!cycles.has(key)) {
          const cycleAtomIds = [...atomIds];
          cycles.set(key, {
            atomIds: cycleAtomIds,
            bondIds: cycleBondIds,
            center: centroidOfImportedAtoms(cycleAtomIds.map((id) => atomById.get(id)).filter((atom): atom is MoleculeAtom => Boolean(atom)))
          });
        }
      }
    }

    if (atomIds.length >= maxRingSize) {
      return;
    }

    (adjacency.get(atomId) ?? []).forEach((edge) => {
      if (edge.atomId === startAtomId || atomIds.includes(edge.atomId)) {
        return;
      }

      visit(startAtomId, edge.atomId, [...atomIds, edge.atomId], [...bondIds, edge.bondId]);
    });
  };

  atoms.forEach((atom) => {
    visit(atom.id, atom.id, [atom.id], []);
  });

  return [...cycles.values()];
}

function canonicalImportedRingCycleKey(bondIds: readonly string[]): string {
  return [...bondIds].sort().join("|");
}

function centroidOfImportedAtoms(atoms: readonly MoleculeAtom[]): Point {
  if (atoms.length === 0) {
    return { x: 0, y: 0 };
  }

  return atoms.reduce<Point>(
    (sum, atom) => ({ x: sum.x + atom.x / atoms.length, y: sum.y + atom.y / atoms.length }),
    { x: 0, y: 0 }
  );
}

function cdxmlAtomLabelPoint(atomElement: XmlElementView): Point | undefined {
  const labelElement = childElements(atomElement, "t")[0];
  if (!labelElement) {
    return undefined;
  }

  if (labelElement.attributes.BoundingBox) {
    const box = parseBoundingBox(labelElement.attributes.BoundingBox);
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }

  return labelElement.attributes.p ? parseCdxmlPoint(labelElement.attributes.p) : undefined;
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

function importGraphic(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext
): GraphicObject | ArrowObject | undefined {
  if (element.attributes.SupersededBy) {
    return undefined;
  }

  const box = parseBoundingBox(element.attributes.BoundingBox);
  if (element.attributes.GraphicType === "Line" && element.attributes.ArrowType) {
    // ArrowType="HalfHead" is a single-barbed (fishhook) arrow: one electron, not two. Mapping it
    // onto a full reaction arrow asserted different chemistry, and a re-export then laundered it to
    // ArrowType="FullHead" with nothing said. Native fishhooks are one-sided but not
    // left/right-handed, so this is an approximation and is reported as one.
    if (normalizedCdxmlToken(element.attributes.ArrowType) === "halfhead") {
      return importHalfHeadArrowAsFishhook(element, pageIndex, objectIndex, context);
    }
    const arrowKind = arrowKindFromCdxml(element.attributes.ArrowType);
    // Reaction and resonance arrows come in as editable art arrows (draggable ends, arc, arrowhead
    // size), tagged so a later export re-emits them as reaction arrows. Equilibrium, retrosynthesis,
    // and unknown stay the legacy `reaction-arrow` object until they're migrated in a later pass.
    if (arrowKind === "forward" || arrowKind === "resonance" || arrowKind === "equilibrium" || arrowKind === "retrosynthesis") {
      return importReactionArrowAsArtArrow(element, pageIndex, objectIndex, context, arrowKind);
    }
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
      arrowKind,
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

  return importShapeGraphic(element, pageIndex, objectIndex, context, "graphic");
}

/** Import a CDXML reaction/resonance arrow as an editable art-arrow graphic (the reverse of
 *  {@link exportSemanticReactionArrowGraphic}). Reuses the line-graphic importer for correct
 *  geometry/style, then tags it: single filled head for a reaction (forward) arrow, heads at both
 *  ends for a resonance arrow, plus the `artToolId` that round-trips its chemical identity. */
function importReactionArrowAsArtArrow(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext,
  arrowKind: "forward" | "resonance" | "equilibrium" | "retrosynthesis"
): GraphicObject {
  const graphic = importShapeGraphic(element, pageIndex, objectIndex, context, "graphic");
  // The two-shaft forms: equilibrium is opposed half-arrows, one head per shaft; retrosynthesis runs
  // both shafts the same way under a single open head.
  const equilibrium = arrowKind === "equilibrium";
  const retro = arrowKind === "retrosynthesis";
  // Sizes and gaps mirror the native arrow tools (documentWorkflow's artShapeTool defaults) so an
  // imported arrow is indistinguishable from a drawn one — an imported retro arrow used to carry an
  // 80%-wider shaft gap, and imported heads were 10px against the tools' 16px.
  const marker = equilibrium
    ? { kind: "half-arrow" as const, sizePx: defaultCdxmlHalfArrowheadSizePx }
    : { kind: "filled-arrow" as const, sizePx: defaultCdxmlArrowheadSizePx };
  const artToolId = equilibrium
    ? "equilibriumArrow"
    : retro
      ? "retroArrow"
      : arrowKind === "resonance" ? "resonanceArrow" : "reactionArrow";
  return {
    ...graphic,
    graphicKind: "path",
    data: {
      ...graphic.data,
      artPathKind: "line",
      // A retrosynthetic arrow has no marker: its "=>" head is part of the path geometry.
      ...(retro ? {} : { markerEnd: marker }),
      ...(arrowKind === "resonance" || equilibrium ? { markerStart: marker } : {}),
      ...(equilibrium ? { dualShaft: true, dualShaftGapPx: 7 } : {}),
      ...(retro ? { dualShaft: true, dualShaftParallel: true, dualShaftGapPx: 5 } : {}),
      artToolId
    }
  };
}

/** Import `ArrowType="HalfHead"` as a native fishhook: a `half-arrow` head on the fishhook tool,
 *  which is the honest representation of a one-electron arrow. It is deliberately NOT tagged as a
 *  semantic reaction arrow — that tagging is what made a re-export write `ArrowType="FullHead"`. */
function importHalfHeadArrowAsFishhook(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext
): GraphicObject {
  const graphic = importShapeGraphic(element, pageIndex, objectIndex, context, "graphic");
  context.warnings.push(
    warning(
      "cdxml.half_head_arrow_import_approximation",
      "A half-headed (fishhook) arrow was imported as ChemDraft's fishhook arrow. Its single-barb chemistry is preserved, but the barb's left/right handedness is not, and re-exporting writes it as a plain line rather than ArrowType=\"HalfHead\"."
    )
  );
  return {
    ...graphic,
    graphicKind: "path",
    data: {
      ...graphic.data,
      artPathKind: "line",
      markerEnd: { kind: "half-arrow", sizePx: defaultCdxmlHalfArrowheadSizePx },
      artToolId: "fishhookArrow"
    }
  };
}

function importArrowGraphic(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext
): GraphicObject {
  const graphic = importShapeGraphic(element, pageIndex, objectIndex, context, "arrow");
  return { ...graphic, data: { ...graphic.data, ...cdxmlArrowMarkers(element) } };
}

/** A standalone `<arrow>` carries its heads in three attributes rather than the closed `ArrowType`
 *  enum a `<graphic GraphicType="Line">` reaction arrow uses: `ArrowheadHead`/`ArrowheadTail` say
 *  which ends are headed, and `ArrowheadType` says how they are drawn. Keying only off `ArrowType`
 *  — which an `<arrow>` element never carries — imported every ChemDraw arrow as a bare line. */
function cdxmlArrowMarkers(element: XmlElementView): Pick<GraphicObject["data"], "markerStart" | "markerEnd"> {
  const arrowheadType = normalizedCdxmlToken(element.attributes.ArrowheadType);
  const markerEnd = cdxmlArrowMarker(element.attributes.ArrowheadHead, arrowheadType);
  const markerStart = cdxmlArrowMarker(element.attributes.ArrowheadTail, arrowheadType);
  return {
    ...(markerEnd ? { markerEnd } : {}),
    ...(markerStart ? { markerStart } : {})
  };
}

function cdxmlArrowMarker(arrowhead: string | undefined, arrowheadType: string): GraphicMarker | undefined {
  const head = normalizedCdxmlToken(arrowhead);
  // An absent attribute and "Unspecified" both mean the end is unheaded — which is why ChemDraw
  // writes a plain line arrow as `ArrowheadType="Solid"` with no `ArrowheadHead` at all.
  if (head === "" || head === "none" || head === "unspecified") {
    return undefined;
  }
  if (head === "halfleft" || head === "halfright") {
    // Native fishhook heads are one-sided but not left/right-handed, so both spellings land on the
    // same marker; a ChemDraft-authored arrow keeps its exact head in the embedded payload.
    return { kind: "half-arrow", sizePx: defaultCdxmlHalfArrowheadSizePx };
  }
  // "Full" (and any head spelling this build doesn't know) draws a head; `ArrowheadType` picks which
  // one. "Hollow" and "Angle" are both unfilled, and `open-arrow` is the nearest native head to
  // either; an unstated type means ChemDraw's default solid head.
  return {
    kind: arrowheadType === "hollow" || arrowheadType === "angle" ? "open-arrow" : "filled-arrow",
    sizePx: defaultCdxmlArrowheadSizePx
  };
}

function importShapeGraphic(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext,
  elementName: "graphic" | "arrow"
): GraphicObject {
  const id = `cdxml_graphic_${pageIndex + 1}_${objectIndex}`;
  const type = elementName === "arrow"
    ? graphicTypeForCdxmlArrow(element)
    : element.attributes.GraphicType;
  const linePoints = cdxmlLinePointsForShape(element);
  const box = graphicBoundsForCdxmlShape(element, type, linePoints);
  const style = graphicStyleFromCdxmlShape(element, context.colorTable);
  const data = graphicDataFromCdxmlShape(element, type, linePoints, box);
  const graphicKind = graphicKindFromCdxmlShape(type, data);

  return {
    id,
    type: "graphic",
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    rotation: 0,
    style,
    graphicKind,
    data,
    compatibility: {
      sourceFormat: "cdxml",
      originalId: element.attributes.id,
      warnings: [],
      unknown: {
        cdxmlElementName: elementName,
        cdxmlGraphicType: type,
        ...(element.attributes.OvalType ? { cdxmlOvalType: element.attributes.OvalType } : {}),
        ...(element.attributes.RectangleType ? { cdxmlRectangleType: element.attributes.RectangleType } : {}),
        ...(element.attributes.LineType ? { cdxmlLineType: element.attributes.LineType } : {}),
        ...(element.attributes.AngularSize ? { cdxmlAngularSize: element.attributes.AngularSize } : {}),
        ...(element.attributes.CornerRadius ? { cdxmlCornerRadius: element.attributes.CornerRadius } : {}),
        ...(element.attributes.ShadowSize ? { cdxmlShadowSize: element.attributes.ShadowSize } : {}),
        ...(element.attributes.BoundingBox ? { cdxmlBoundingBox: element.attributes.BoundingBox } : {}),
        ...(element.attributes.color ? { cdxmlColor: element.attributes.color } : {}),
        cdxmlCoordinateSpace: "xy"
      }
    }
  };
}

function graphicTypeForCdxmlArrow(element: XmlElementView): string {
  return element.attributes.AngularSize ? "Arc" : "Line";
}

function cdxmlLinePointsForShape(element: XmlElementView): { start: Point; end: Point } | undefined {
  // Tail3D/Head3D are 3D "x y z"; Start/End are 2D "x y". Both are x-first, so one parser order
  // serves all four — the real ChemDraw file that settled this carries an <arrow> with Head3D
  // "341 232 0" / Tail3D "260 232 0" and a BoundingBox "260 227.62 341 235.38" that only agrees
  // with those endpoints read left-top-right-bottom.
  const tail = parseCdxmlXyPoint(element.attributes.Tail3D) ?? parseCdxmlXyPoint(element.attributes.Start);
  const head = parseCdxmlXyPoint(element.attributes.Head3D) ?? parseCdxmlXyPoint(element.attributes.End);
  return tail && head ? { start: tail, end: head } : undefined;
}

function graphicBoundsForCdxmlShape(
  element: XmlElementView,
  type: string | undefined,
  linePoints: { start: Point; end: Point } | undefined
): { x: number; y: number; width: number; height: number } {
  if (type === "Line" || type === "Arc") {
    return parseCdxmlXyBoundingBox(element.attributes.BoundingBox)
      ?? (linePoints ? paddedBoundsForPoints([linePoints.start, linePoints.end], type === "Arc" ? 12 : 1) : undefined)
      ?? parseBoundingBox(element.attributes.BoundingBox);
  }

  const axisBounds = graphicAxisBounds(element);
  if (axisBounds) {
    return axisBounds;
  }

  return parseCdxmlXyBoundingBox(element.attributes.BoundingBox) ?? parseBoundingBox(element.attributes.BoundingBox);
}

function graphicAxisBounds(element: XmlElementView): { x: number; y: number; width: number; height: number } | undefined {
  const center = parseCdxmlXyPoint(element.attributes.Center3D);
  const majorAxisEnd = parseCdxmlXyPoint(element.attributes.MajorAxisEnd3D);
  const minorAxisEnd = parseCdxmlXyPoint(element.attributes.MinorAxisEnd3D);
  if (!center || !majorAxisEnd || !minorAxisEnd) {
    return undefined;
  }

  const radiusX = Math.max(Math.abs(majorAxisEnd.x - center.x), Math.abs(minorAxisEnd.x - center.x), 0.5);
  const radiusY = Math.max(Math.abs(majorAxisEnd.y - center.y), Math.abs(minorAxisEnd.y - center.y), 0.5);
  return {
    x: center.x - radiusX,
    y: center.y - radiusY,
    width: radiusX * 2,
    height: radiusY * 2
  };
}

function paddedBoundsForPoints(points: readonly Point[], padding: number): { x: number; y: number; width: number; height: number } {
  const bounds = boundsForPoints(points);
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: Math.max(1, bounds.width + padding * 2),
    height: Math.max(1, bounds.height + padding * 2)
  };
}

function graphicStyleFromCdxmlShape(
  element: XmlElementView,
  colorTable: CdxmlColorTable
): GraphicObject["style"] {
  const strokeColor = colorForCdxmlIndex(element.attributes.color, colorTable) ?? defaultCdxmlStrokeColor;
  const style: GraphicObject["style"] = {
    strokeColor,
    fillColor: defaultCdxmlFillColor,
    strokeWidth: defaultCdxmlLineWidthPx
  };
  const lineType = normalizedCdxmlToken(element.attributes.LineType);
  const ovalType = normalizedCdxmlToken(element.attributes.OvalType);
  const rectangleType = normalizedCdxmlToken(element.attributes.RectangleType);

  if (lineType === "dashed" || rectangleType.includes("dashed")) {
    style.strokeDasharray = "3 4";
  }
  if (lineType === "bold") {
    style.strokeWidth = defaultCdxmlBoldWidthPx;
  }
  if (ovalType.includes("filled") || rectangleType.includes("filled")) {
    style.fillColor = strokeColor;
    style.fillMode = "solid";
  }
  if (ovalType.includes("shaded")) {
    style.fillColor = strokeColor;
    style.fillMode = "gloss";
    style.strokeWidth = 1.5;
  }
  if (ovalType.includes("shadow") || rectangleType.includes("shadow")) {
    style.effect = "shadow";
    style.fillColor = rectangleType.includes("shadow") ? "#ffffff" : defaultCdxmlFillColor;
  }

  return style;
}

function graphicDataFromCdxmlShape(
  element: XmlElementView,
  type: string | undefined,
  linePoints: { start: Point; end: Point } | undefined,
  box: { x: number; y: number; width: number; height: number }
): GraphicObject["data"] {
  const data: GraphicObject["data"] = {};
  const lineType = normalizedCdxmlToken(element.attributes.LineType);
  const rectangleType = normalizedCdxmlToken(element.attributes.RectangleType);

  if (linePoints && type !== "Arc") {
    data.lineStart = linePoints.start;
    data.lineEnd = linePoints.end;
  }
  if (type === "Arc") {
    data.artPathKind = "arc";
    data.arcSweepRadians = clampArcSweepRadians(degreesToRadians(parseNumber(element.attributes.AngularSize) ?? 180));
    if (linePoints) {
      const center = objectCenter(box);
      const rx = Math.max(box.width / 2 - 4, 1);
      const ry = Math.max(box.height / 2 - 4, 1);
      data.arcStartRadians = ellipseAngleRadiansForPoint(center, rx, ry, linePoints.start);
    }
  } else if (lineType === "wavy") {
    data.artPathKind = "wavy";
  } else if (type === "Line") {
    data.artPathKind = "line";
  }
  if (rectangleType.includes("roundedge") || element.attributes.CornerRadius) {
    data.cornerRadiusPx = cdxmlCornerRadiusToCssPx(element.attributes.CornerRadius);
  }

  return data;
}

function graphicKindFromCdxmlShape(type: string | undefined, data: GraphicObject["data"]): GraphicObject["graphicKind"] {
  if (type === "Oval") {
    return "ellipse";
  }
  if (type === "Rectangle") {
    return "rect";
  }
  if (type === "Arc" || data.artPathKind === "wavy" || data.artPathKind === "arc") {
    return "path";
  }
  if (type === "Line") {
    return "line";
  }
  return graphicKindFromCdxml(type);
}

function normalizedCdxmlToken(value: string | undefined): string {
  return value?.replace(/\s+/g, "").toLowerCase() ?? "";
}

function cdxmlCornerRadiusToCssPx(value: string | undefined): number {
  const radius = parseNumber(value);
  if (radius === undefined) {
    return 0;
  }
  return cdxmlToCssPx(radius / defaultCdxmlCornerRadiusFactor);
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

// ChemDraw encodes wedge/hash stereo on <b> via Display. The "Begin" variants put the
// narrow (stereocenter) end at B; the "End" variants put it at E. ChemDraft keeps the
// narrow end at fromAtomId, so the "End" variants import with B/E swapped. Older and
// alternate visible styles such as Hash, Dash, and Bold map into ChemDraft's native
// display styles without warning.
const cdxmlBondDisplays: Record<string, { bondStyle: BondDisplayStyle; narrowAtEnd: boolean }> = {
  Bold: { bondStyle: "bold", narrowAtEnd: false },
  Dash: { bondStyle: "dashed", narrowAtEnd: false },
  Hash: { bondStyle: "hashed", narrowAtEnd: false },
  WedgeBegin: { bondStyle: "wedge", narrowAtEnd: false },
  WedgeEnd: { bondStyle: "wedge", narrowAtEnd: true },
  WedgedHashBegin: { bondStyle: "hashed", narrowAtEnd: false },
  WedgedHashEnd: { bondStyle: "hashed", narrowAtEnd: true }
};

const cdxmlBeginDisplayByBondStyle = {
  bold: "Bold",
  dashed: "Dash",
  wedge: "WedgeBegin",
  hashed: "WedgedHashBegin"
} as const;

function cdxmlBondDisplay(
  display: string | undefined
): { bondStyle: BondDisplayStyle; narrowAtEnd: boolean } | undefined {
  return display ? cdxmlBondDisplays[display] : undefined;
}

function cdxmlBondDisplayForBondStyle(display: MoleculeBond["display"]): string | undefined {
  const bondStyle = display?.bondStyle;
  if (!bondStyle) {
    return undefined;
  }
  return cdxmlBeginDisplayByBondStyle[bondStyle];
}

function cdxmlAtomStereoAssignment(value: string | undefined): "R" | "S" | undefined {
  const normalized = value?.trim().toUpperCase();
  return normalized === "R" || normalized === "S" ? normalized : undefined;
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

/** Only ChemDraft's own codec-v1 files carry a y-first visible layer; every other producer (and our
 *  own v2 output) writes spec order and needs no correction. Keyed off the codec tag rather than
 *  CreationProgram so a foreign file can never be transposed by accident. */
function importTransformForTree(tree: OrderedXmlTree): CdxmlImportTransform {
  const tags = findChemDraftObjectTags(tree);
  return tags[ChemDraftObjectTags.codecVersion] === CdxmlEnvelopeCodecVersionV1
    ? "transpose-legacy-v1"
    : "none";
}

function importCdxmlColorTable(tree: OrderedXmlTree): CdxmlColorTable {
  const colorByIndex = new Map<number, string>([
    [0, "#000000"],
    [1, "#ffffff"]
  ]);
  const colorElements = childElements(findElements(tree, "colortable")[0] ?? { name: "colortable", attributes: {}, children: [] }, "color");
  const colors = colorElements.length > 0
    ? colorElements.map((element) => rgbToHexColor(
        colorComponentFromCdxml(element.attributes.r),
        colorComponentFromCdxml(element.attributes.g),
        colorComponentFromCdxml(element.attributes.b)
      ))
    : [...standardCdxmlColorTable];
  colors.forEach((color, index) => {
    colorByIndex.set(index + 2, color);
  });
  return { colorByIndex };
}

function colorForCdxmlIndex(value: string | undefined, colorTable: CdxmlColorTable): string | undefined {
  const index = parseInteger(value);
  return index === undefined ? undefined : colorTable.colorByIndex.get(index);
}

function colorComponentFromCdxml(value: string | undefined): number {
  const parsed = parseNumber(value) ?? 0;
  return Math.max(0, Math.min(255, Math.round(parsed * 255)));
}

function rgbToHexColor(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((component) => component.toString(16).padStart(2, "0")).join("")}`;
}

function hexToRgb(value: string): { r: number; g: number; b: number } | undefined {
  const match = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const hex = match[1];
  return {
    r: Number.parseInt(hex.slice(0, 2), 16),
    g: Number.parseInt(hex.slice(2, 4), 16),
    b: Number.parseInt(hex.slice(4, 6), 16)
  };
}

function formatColorComponent(value: number): string {
  return formatNumber(Math.max(0, Math.min(255, value)) / 255);
}

/** CDXML 2D positions are "x y" — see the CDXCoordinates note that the y-first order belongs to
 *  BINARY CDX, not CDXML. ChemDraft wrote y-first through codec v1; v2 writes spec order, and a v1
 *  file's visible layer is transposed on import (see {@link transposeImportedObject}). */
function formatPoint(point: Point): string {
  return `${formatNumber(cssPxToCdxml(point.x))} ${formatNumber(cssPxToCdxml(point.y))}`;
}

function formatXyPoint(point: Point): string {
  return `${formatNumber(cssPxToCdxml(point.x))} ${formatNumber(cssPxToCdxml(point.y))} 0`;
}

function parseCdxmlXyPoint(point: string | undefined): Point | undefined {
  if (!point) {
    return undefined;
  }
  const [x, y] = point.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return undefined;
  }
  return {
    x: cdxmlToCssPx(x),
    y: cdxmlToCssPx(y)
  };
}

/** Spec-order 2D position: "x y", falling back to the origin when absent or malformed. */
function parseCdxmlPoint(point: string | undefined): Point {
  return parseCdxmlXyPoint(point) ?? { x: 0, y: 0 };
}


function formatXyBoundingBox(points: readonly Point[]): string {
  const bounds = boundsForPoints(points);
  return [
    formatNumber(cssPxToCdxml(bounds.x)),
    formatNumber(cssPxToCdxml(bounds.y)),
    formatNumber(cssPxToCdxml(bounds.x + bounds.width)),
    formatNumber(cssPxToCdxml(bounds.y + bounds.height))
  ].join(" ");
}

/** CDXRectangle is "left top right bottom". */
function formatBoundingBox(object: { x: number; y: number; width: number; height: number }): string {
  return `${formatNumber(cssPxToCdxml(object.x))} ${formatNumber(cssPxToCdxml(object.y))} ${formatNumber(cssPxToCdxml(object.x + object.width))} ${formatNumber(cssPxToCdxml(object.y + object.height))}`;
}

function formatLineBoundingBox(start: Point, end: Point): string {
  return `${formatNumber(cssPxToCdxml(Math.min(start.x, end.x)))} ${formatNumber(cssPxToCdxml(Math.min(start.y, end.y)))} ${formatNumber(cssPxToCdxml(Math.max(start.x, end.x)))} ${formatNumber(cssPxToCdxml(Math.max(start.y, end.y)))}`;
}

/** Spec-order rectangle: "left top right bottom", falling back to a 1x1 frame at the origin when
 *  the attribute is absent or malformed. One reader, so a corner-reversed box normalizes the same
 *  way everywhere. */
function parseBoundingBox(box: string | undefined): { x: number; y: number; width: number; height: number } {
  return parseCdxmlXyBoundingBox(box) ?? { x: 0, y: 0, width: 1, height: 1 };
}

function parseCdxmlXyBoundingBox(box: string | undefined): { x: number; y: number; width: number; height: number } | undefined {
  if (!box) {
    return undefined;
  }
  const [x1, y1, x2, y2] = box.trim().split(/\s+/).map(Number);
  if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) {
    return undefined;
  }
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return {
    x: cdxmlToCssPx(left),
    y: cdxmlToCssPx(top),
    width: Math.max(1, cdxmlToCssPx(right - left)),
    height: Math.max(1, cdxmlToCssPx(bottom - top))
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

function boundsForDocumentObjects(objects: readonly DocumentObject[]): { x: number; y: number; width: number; height: number } {
  return boundsForPoints(objects.flatMap((object) => [
    { x: object.x, y: object.y },
    { x: object.x + object.width, y: object.y + object.height }
  ]));
}

function boundsForPoints(points: readonly Point[]): { x: number; y: number; width: number; height: number } {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return {
    x: minX,
    y: minY,
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY)
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

/**
 * CDXML `ArrowType` spellings, which are what other programs actually write and read.
 *
 * Earlier ChemDraft builds emitted the internal lowercase kind names instead, so those are still
 * accepted on import — otherwise documents this app itself wrote would come back as `unknown`.
 */
const cdxmlArrowTypeByKind: Readonly<Record<Exclude<ArrowObject["arrowKind"], "unknown">, string>> = {
  forward: "FullHead",
  resonance: "Resonance",
  equilibrium: "Equilibrium",
  retrosynthesis: "RetroSynthetic"
};

const arrowKindByCdxmlArrowType: ReadonlyMap<string, ArrowObject["arrowKind"]> = new Map([
  // Real CDXML spellings.
  ["fullhead", "forward"],
  ["halfhead", "forward"],
  ["resonance", "resonance"],
  ["equilibrium", "equilibrium"],
  ["retrosynthetic", "retrosynthesis"],
  // Legacy ChemDraft output.
  ["forward", "forward"],
  ["retrosynthesis", "retrosynthesis"]
] as const);

/** The CDXML spelling for a kind, or `undefined` for `"unknown"` — which has no honest spelling. */
export function cdxmlArrowTypeForKind(arrowKind: ArrowObject["arrowKind"]): string | undefined {
  return arrowKind === "unknown" ? undefined : cdxmlArrowTypeByKind[arrowKind];
}

function arrowKindFromCdxml(value: string): ArrowObject["arrowKind"] {
  return arrowKindByCdxmlArrowType.get(value.trim().toLowerCase()) ?? "unknown";
}

function graphicKindFromCdxml(value: string | undefined): GraphicObject["graphicKind"] {
  if (value === "line" || value === "rect" || value === "ellipse" || value === "path" || value === "image") {
    return value;
  }
  if (value === "Line") {
    return "line";
  }
  if (value === "Rectangle") {
    return "rect";
  }
  if (value === "Oval") {
    return "ellipse";
  }
  if (value === "Arc") {
    return "path";
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

function parseNumber(value: string | undefined): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
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
