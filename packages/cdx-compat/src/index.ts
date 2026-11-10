import { XMLParser, XMLValidator } from "fast-xml-parser";
import {
  ChemDraftDocumentSchema,
  DocumentSchemaVersion,
  atomicNumberForElementSymbol,
  createEmptyDocument,
  deserializeDocument,
  drawnLabelBondSide,
  elementSymbolForAtomicNumber,
  isDativeBond,
  isEngineDocument,
  nativeTextStyleFromObjectStyle,
  normalizeAtomIsotope,
  parseDocument,
  withBracketChemistryWarnings,
  type Anchor,
  type ArrowObject,
  type BondRef,
  type BracketObject,
  type ChemDraftDocument,
  type CompatibilityWarning,
  type CrossingOverride,
  type DocumentObject,
  type GroupObject,
  type DocumentPage,
  type GraphicMarker,
  type GraphicObject,
  type GraphicPathNode,
  type MoleculeAtom,
  type MoleculeBond,
  type MoleculeObject,
  type Point,
  type ReactionObject,
  type TextObject,
  type TableObject,
  type UnknownCompatibilityObject
} from "@chemdraft/chem-core";
import { measureTextRun, planTableLayout } from "@chemdraft/layout-engine";
import { bondedElementLabelMeaning } from "@chemdraft/template-library";
import { planMoleculeAtomLabels } from "@chemdraft/layout-engine";
import { sha256Hex, utf8Bytes, utf8String } from "./sha256";
import {
  CDX_NATIVE_ENVELOPE_ATTRIBUTE,
  cdxElementFromOrderedTree,
  cdxElementToCdxml,
  hex,
  readCdx,
  writeCdx,
  type CdxElement
} from "./cdxBinary";

export interface CompatibilityConversionWarning {
  code: string;
  message: string;
  sourceObjectId?: string;
  /** Native atoms of `sourceObjectId` the warning is about, when it is about particular atoms. */
  atomIds?: string[];
  /** Native bonds of `sourceObjectId` the warning is about, when it is about particular bonds. */
  bondIds?: string[];
}

export interface CdxmlExportOptions {
  creationProgram?: string;
  /** CDXML saves embed by default; interchange CDX explicitly disables this. */
  embedNativePayload?: boolean;
}

export interface CdxmlExportResult {
  contents: string;
  warnings: CompatibilityConversionWarning[];
  /** SHA-256 of the native document the envelope embeds: an identity for what was saved, already
   *  computed for the envelope, so a caller need not hash the megabytes of `contents` again. */
  nativePayloadHash: string;
}

export interface CdxExportOptions extends CdxmlExportOptions {
  /** Save As includes the exact native document; interchange Export omits it. Defaults to false. */
  embedNativePayload?: boolean;
}

export interface CdxExportResult {
  bytes: Uint8Array;
  warnings: CompatibilityConversionWarning[];
}

/** Binary decoding feeds the same CDXML open path, including native-envelope integrity checks. */
export function importCdx(bytes: Uint8Array): ChemDraftOpenResult {
  const warnings: CompatibilityConversionWarning[] = [];
  try {
    const integrity: { visibleBinaryHash?: string } = {};
    const root = readCdx(bytes, true, warnings, integrity);
    const encoded = root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    delete root.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE];
    if (encoded !== undefined) {
      try {
        if (!encoded.startsWith("|x|") || (encoded.length - 3) % 2 || !/^[0-9a-f]+$/i.test(encoded.slice(3))) throw new Error("invalid envelope bytes");
        const data = new Uint8Array((encoded.length - 3) / 2);
        for (let k = 0; k < data.length; k++) data[k] = parseInt(encoded.slice(3 + 2 * k, 5 + 2 * k), 16);
        const envelope: unknown = JSON.parse(utf8String(data));
        if (!envelope || typeof envelope !== "object" || !("format" in envelope) || envelope.format !== "org.chemdraft/cdx-envelope.v1" || !("tags" in envelope) || !Array.isArray(envelope.tags)) {
          throw new Error("unrecognized envelope format");
        }
        const page = root.kids.find((child) => child.name === "page");
        if (!page) throw new Error("native envelope has no document page");
        const tags: CdxElement[] = envelope.tags.map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string" || !Object.values(ChemDraftObjectTags).includes(entry[0] as typeof ChemDraftObjectTags[keyof typeof ChemDraftObjectTags])) {
            throw new Error("invalid native envelope tag");
          }
          return { name: "objecttag", attrs: { Name: entry[0], Value: entry[1], TagType: "String", Persistent: "yes" }, kids: [], text: "" };
        });
        const envelopeHashVersion = "visibleHashVersion" in envelope ? envelope.visibleHashVersion : undefined;
        const visibleHashVersion = root.attrs[VisibleHashVersionAttribute];
        const versionMatches = envelopeHashVersion === undefined && visibleHashVersion === undefined
          || envelopeHashVersion === VisibleHashVersion && visibleHashVersion === EncodedVisibleHashVersion;
        if (!("visibleBinaryHash" in envelope) || envelope.visibleBinaryHash !== integrity.visibleBinaryHash || !versionMatches) {
          // Even a change to the legacy text hidden by its UTF-8 copy must defeat native restoration.
          for (const tag of tags) if (tag.attrs.Name === ChemDraftObjectTags.visibleCdxmlHash) tag.attrs.Value = "";
          warnings.push(warning("cdx.native_payload_modified", "CDX import: binary content changed, its integrity hash is missing, or its hash version disagrees with the visible layer; the embedded native document requires conflict review."));
        }
        // Keep the stored XML hash intact: a matching binary hash must also agree with the
        // visible layer recorded beside the native payload. The hashed root version selects
        // exactly one XML canonicalization without rebasing away a real discrepancy.
        page.kids.push(...tags);
      } catch (error) {
        warnings.push(warning("cdx.native_payload_invalid", `CDX import: native envelope could not be decoded: ${errorMessage(error)}`));
      }
    }
    const opened = openChemDraftPayload(cdxElementToCdxml(root));
    return { ...opened, warnings: [...warnings, ...opened.warnings] };
  } catch (error) {
    return { source: "external-cdxml", warnings: [...warnings, warning("cdx.invalid_binary", errorMessage(error))] };
  }
}

/** Native → the existing CDXML writer → binary CDX. No separate chemistry conversion. */
export function exportDocumentToCdx(document: ChemDraftDocument, options: CdxExportOptions = {}): CdxExportResult {
  const cdxml = exportDocumentToCdxml(document, { ...options, embedNativePayload: options.embedNativePayload ?? false });
  const warnings = [...cdxml.warnings];
  const root = cdxElementFromOrderedTree(parseCdxml(cdxml.contents));
  const checkRepeatCounts = (element: CdxElement) => {
    const text = element.attrs.RepeatCount;
    if (text !== undefined && (!/^\d+$/.test(text.trim()) || !Number.isSafeInteger(Number(text)) || Number(text) <= 0)) {
      throw new Error(`CDX export refused: RepeatCount "${text}" is not a safe positive integer; its original text cannot be preserved in the binary numeric property. Save as CDXML to retain the source data.`);
    }
    element.kids.forEach(checkRepeatCounts);
  };
  checkRepeatCounts(root);
  const tags: [string, string][] = [];
  const strip = (x: CdxElement) => {
    x.kids = x.kids.filter((child) => {
      if (child.name === "objecttag" && child.attrs.Name?.startsWith(ChemDraftObjectTagPrefix)) {
        tags.push([child.attrs.Name, child.attrs.Value]);
        return false;
      }
      strip(child);
      return true;
    });
  };
  strip(root);
  if (!options.embedNativePayload) delete root.attrs[VisibleHashVersionAttribute];
  const visibleBytes = writeCdx(root, warnings);
  if (!options.embedNativePayload) return { bytes: visibleBytes, warnings };
  // Binary encoding normalizes IDs, fixed-point coordinates, styles and table precision. Hash that
  // actual visible layer, so subsequent external edits still take the existing conflict path.
  const normalized = readCdx(visibleBytes);
  const visibleHash = visibleHashForCdxml(cdxElementToCdxml(normalized));
  const visibleBinaryHash = sha256Hex(writeCdx(normalized));
  const envelope = { format: "org.chemdraft/cdx-envelope.v1", visibleHashVersion: VisibleHashVersion, visibleBinaryHash, tags: tags.map(([name, value]) => [name, name === ChemDraftObjectTags.visibleCdxmlHash ? visibleHash : value]) };
  normalized.attrs[CDX_NATIVE_ENVELOPE_ATTRIBUTE] = `|x|${hex(utf8Bytes(JSON.stringify(envelope)))}`;
  return { bytes: writeCdx(normalized, warnings), warnings };
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

// User-defined CDX property 0x4345 stores UTF-8 "2", represented by the same opaque CDXML
// root attribute. Unlike payload objecttags / property 0x4344, it stays in BOTH visible hashes.
// Removing/changing the selector therefore cannot switch semantics while keeping a stored hash.
// Older readers preserve unknown root attributes/properties and ignore extra envelope fields.
const VisibleHashVersionAttribute = "attrib4345";
const VisibleHashVersion = "2";
const EncodedVisibleHashVersion = "|x|32";

const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  parseAttributeValue: false,
  trimValues: false,
  // Decode references once in text and attributes, without enabling named HTML entities.
  // The custom decoder also leaves document-defined entities unexpanded.
  entityDecoder: {
    decode: decodeXmlReferences,
    reset() {},
    setExternalEntities() {},
    addInputEntities() {},
    setXmlVersion() {}
  },
  commentPropName: "#comment",
  cdataPropName: "#cdata"
});

// Frozen parser options from the released origin/main hash path. In particular its default
// decoder leaves numeric references literal. Do not substitute the current XML decoder here.
const legacyVisibleXmlParser = new XMLParser({
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
  sourceId(value: string): string;
}

interface VisibleExportContext {
  ids: Map<string, string>;
  curveColors: readonly string[];
  bondIdsByRefKey: Map<string, string>;
  atomIdsByObjectId: Map<string, Map<string, string>>;
  sourceIds: Map<string, string>;
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
  curveLineDefaults: Record<string, string>;
  preserveReactionIds: boolean;
}

type DoubleBondSide = NonNullable<MoleculeBond["display"]>["doubleBondSide"];
type BondDisplayStyle = NonNullable<MoleculeBond["display"]>["bondStyle"];
type CdxmlImportTransform = "none" | "transpose-legacy-v1";

export function exportDocumentToCdxml(
  document: ChemDraftDocument,
  options: CdxmlExportOptions = {}
): CdxmlExportResult {
  // A document the patch engine produced is validated and normalized already; re-parsing it cost a
  // full schema pass over every object on each save, and autosave runs after every pause in editing.
  const parsedDocument = isEngineDocument(document) ? document : parseDocument(document);
  const warnings: CompatibilityConversionWarning[] = [];
  const creationProgram = options.creationProgram ?? "ChemDraft";
  // Compact, not serializeDocument's indented form: the JSON is base64-encoded into an attribute
  // nobody reads by eye, and indentation grew a large drawing's file ~1.8x. `parsedDocument` is
  // validated already, so stringifying it directly also skips serializeDocument's second parse of
  // a document that was not an engine document. Older, indented payloads still open — the reader
  // hashes and parses whatever JSON bytes the envelope carries.
  const nativeJson = JSON.stringify(parsedDocument);
  const nativePayloadHash = sha256Utf8Hex(nativeJson);
  const fonts = [...new Set(parsedDocument.pages.flatMap(page => page.objects
    .filter((object): object is TableObject => object.type === "table")
    .map(object => nativeTextStyleFromObjectStyle(object.style).fontFamily)))];
  // Keep the existing palette indices stable; curves can carry arbitrary source colors.
  const curveColors: string[] = [...standardCdxmlColorTable];
  for (const page of parsedDocument.pages) {
    for (const object of page.objects) {
      const unknown = object.compatibility?.unknown;
      const curveColor = object.type === "graphic" && unknown?.cdxmlElementName === "curve"
        ? object.style.strokeColor ?? defaultCdxmlStrokeColor
        : unknown?.cdxmlCurveColor;
      const color = typeof curveColor === "string" ? normalizeHexColor(curveColor) : undefined;
      if (color && !curveColors.includes(color)) curveColors.push(color);
    }
  }
  // Source reaction lists use document-wide ids. Reserve them before allocating any new ids,
  // including atom/bond ids carried by opaque atom-mapping attributes.
  const preserveReferenceIds = parsedDocument.pages.some(page => page.objects.some(object => object.type === "reaction" || object.type === "bracket"));
  const reactionIds = new Set<string>(parsedDocument.pages.map(page => page.id));
  for (const page of parsedDocument.pages) {
    for (const object of page.objects) {
      if (object.compatibility?.originalId) reactionIds.add(object.compatibility.originalId);
      const source = object.compatibility?.unknown;
      if (typeof source?.cdxmlSchemeId === "string") reactionIds.add(source.cdxmlSchemeId);
      for (const key of ["cdxmlAtomIdsByAtomId", "cdxmlBondIdsByBondId"]) {
        for (const id of Object.values(preservedCurveAttributes(source?.[key]))) reactionIds.add(id);
      }
      if (object.type === "bracket") {
        const pending: unknown[] = [source?.bracketedGroup, source?.cdxmlBracket];
        while (pending.length) {
          const value = pending.pop();
          if (Array.isArray(value)) { for (const child of value) pending.push(child); }
          else if (isRecord(value)) for (const [key, field] of Object.entries(value)) {
            if (["id", "GraphicID", "BondID", "InnerAtomID", "BracketedObjectIDs"].includes(key) && typeof field === "string") {
              splitCdxmlIdList(field).forEach(id => reactionIds.add(id));
            } else if (typeof field === "object") pending.push(field);
          }
        }
      }
    }
  }
  const reactionAllocator = createIdAllocator(0, reactionIds);
  for (const page of parsedDocument.pages) reactionAllocator.sourceId(page.id);
  const visiblePageChildren = parsedDocument.pages.map((page, pageIndex) => buildVisiblePageChildren(page, warnings, fonts, curveColors,
    preserveReferenceIds ? reactionAllocator : createIdAllocator(pageIndex)));
  const visiblePages = parsedDocument.pages.map((page, pageIndex) => buildPageXml(page, visiblePageChildren[pageIndex]));
  const visibleEnvelope = buildCdxmlEnvelope(creationProgram, visiblePages, fonts, curveColors);
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
  const contents = buildCdxmlEnvelope(creationProgram, envelopePages, fonts, curveColors);
  // No runtime self-check that the metadata leaves the visible hash alone. The one this replaced
  // re-parsed and re-hashed the whole finished envelope, payload included — a full XML parse of
  // megabytes on every save — and a textual stand-in could never fire, since `contents` is the
  // visible envelope plus exactly this insertion. What must hold is that the reader strips the
  // metadata back to the same visible hash; the round-trip tests (a save reopens as its native
  // payload, not as an externally edited file) are what enforce it.

  if (options.embedNativePayload === false) {
    // Interchange has no recovery envelope. Never promise that omitted data was kept.
    for (const item of warnings) if (/payload/i.test(item.message)) {
      const visibleDetail = item.message.split(/(?<=[.;])\s+/).filter(part => !/payload/i.test(part)).join(" ");
      const feature = item.code.replace(/^cdxml\./, "").replace(/_payload_only$/, "").replaceAll("_", " ");
      item.message = `${visibleDetail ? `${visibleDetail} ` : ""}Unsupported ${feature} data${item.sourceObjectId ? ` on ${item.sourceObjectId}` : ""} is NOT written; no native payload is embedded.`;
    }
  }
  return { contents: options.embedNativePayload === false ? visibleEnvelope : contents, warnings, nativePayloadHash };
}

export function openChemDraftPayload(contents: string): ChemDraftOpenResult {
  const normalized = stripByteOrderMark(contents).trimStart();

  if (normalized.length === 0) {
    return {
      source: "external-cdxml",
      warnings: [warning("cdxml.empty_payload", "The file is empty.")]
    };
  }

  if (normalized.startsWith("{") || normalized.startsWith("[")) {
    return openLegacyJsonDocument(normalized);
  }

  // Binary CDX must reach importCdx as bytes, before any text decoding can damage its contents.
  // "VmpDRDAx" is the same signature base64-encoded, the form CDX takes in some interchange files.
  if (normalized.startsWith("VjCD") || normalized.startsWith("VmpDRDAx")) {
    return {
      source: "external-cdxml",
      warnings: [
        warning(
          "cdx.binary_not_supported",
          "This is a binary CDX file. Open it as bytes with importCdx; the app must use that path for Open and Save As CDX."
        )
      ]
    };
  }

  if (!normalized.startsWith("<")) {
    return {
      source: "external-cdxml",
      warnings: [
        warning("cdxml.unrecognized_payload", "The file is neither a ChemDraft document nor CDXML: it is not JSON or XML.")
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

  // XML that is not CDXML at all — `.cdxml` is also PowerShell's cmdlet-definition extension, and
  // those files are XML too. Name what the file is instead of reporting "no page elements".
  const rootName = xmlRootElementName(tree);
  if (rootName !== undefined && rootName.toLowerCase() !== "cdxml") {
    return {
      source: "external-cdxml",
      warnings: [
        warning(
          "cdxml.not_cdxml_xml",
          `This XML file is not ChemDraw CDXML: its top-level element is <${rootName}>, not <CDXML>.`
        )
      ]
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
        // A refusal that already names its reason stands alone; the generic "no supported objects"
        // sentence would be false for it and would bury the real cause.
        : visibleImport.warnings.some(({ code }) => code === "cdxml.values_out_of_range")
          ? visibleImport.warnings
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
  const visibleHashVersion = tree.map(elementView).find(element => element?.name.toLowerCase() === "cdxml")?.attributes[VisibleHashVersionAttribute];
  let visibleHashMatches = false;
  if (expectedVisibleHash) {
    try {
      if (visibleHashVersion === undefined) {
        // Known, accepted legacy limitation: only a line break can be swapped for literal text
        // '&#10;' (or similar numeric references) without changing this hash. This is cosmetic,
        // never changes chemistry, and must not prompt on unchanged legacy files. Re-saving
        // upgrades the file to v2, whose current canonicalization distinguishes these forms.
        visibleHashMatches = expectedVisibleHash === legacyVisibleCdxmlHash(contents);
      } else if (visibleHashVersion === EncodedVisibleHashVersion) {
        visibleHashMatches = expectedVisibleHash === visibleHashForParsedTree(tree);
      }
      // An unknown version always requires conflict review, even if a hash would match.
    } catch {
      // A legacy parser refusal cannot authorize native restoration; use conflict review below.
    }
  }
  if (!visibleHashMatches) {
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
    warnings: embeddedDocument.compatibility.warnings.filter(item => item.code === "document.bracket_partner_missing")
      .map(item => ({ code: item.code, message: item.message, sourceObjectId: item.objectId }))
  };
}

export function canonicalVisibleCdxml(contents: string): string {
  return canonicalizeXmlTree(stripChemDraftObjectTags(parseCdxml(contents)));
}

export function visibleHashForCdxml(contents: string): string {
  return sha256Utf8Hex(canonicalVisibleCdxml(contents));
}

/** Read-only compatibility with hashes written by the released app. Keep this canonicalizer,
 * parser and escaping frozen: changing current XML decoding or serialization must not invalidate
 * unchanged saved documents. Hash the original XML, never a tree decoded by the current parser.
 * Structural tag stripping and tree access retain the same semantics as origin/main. */
export function legacyVisibleCdxmlHash(contents: string): string {
  return sha256Utf8Hex(legacyCanonicalizeVisibleXmlTree(stripChemDraftObjectTags(parseCdxml(contents, legacyVisibleXmlParser))));
}

function legacyCanonicalizeVisibleXmlTree(tree: OrderedXmlTree): string {
  return tree.map((node) => {
    if (typeof node["#text"] === "string") {
      const text = node["#text"];
      return text.trim().length === 0 ? "" : legacyEscapeXmlText(text);
    }
    const cdata = cdataContent(node["#cdata"]);
    if (cdata !== undefined) return legacyEscapeXmlText(cdata);

    const element = elementView(node);
    if (!element || element.name.startsWith("?") || element.name === "#comment") return "";
    const attributes = Object.entries(element.attributes)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => ` ${name}="${legacyEscapeXmlAttribute(value)}"`)
      .join("");
    const children = legacyCanonicalizeVisibleXmlTree(element.children);
    return children.length === 0
      ? `<${element.name}${attributes}/>`
      : `<${element.name}${attributes}>${children}</${element.name}>`;
  }).join("");
}

function legacyEscapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function legacyEscapeXmlAttribute(value: string): string {
  return legacyEscapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
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
    const document = deserializeDocument(contents);
    return {
      document,
      source: "legacy-json",
      warnings: document.compatibility.warnings.filter(item => item.code === "document.bracket_partner_missing")
        .map(item => ({ code: item.code, message: item.message, sourceObjectId: item.objectId }))
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

function buildCdxmlEnvelope(creationProgram: string, pages: readonly string[], fonts: readonly string[], colors: readonly string[]): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE CDXML SYSTEM "http://www.cambridgesoft.com/xml/cdxml.dtd">',
    `<CDXML CreationProgram="${escapeXmlAttribute(creationProgram)}" ${VisibleHashVersionAttribute}="${EncodedVisibleHashVersion}">`,
    buildStandardColorTableXml(colors),
    ...(fonts.length ? ["  <fonttable>", ...fonts.map((font, index) =>
      `    <font id="${index + 1}" charset="iso-8859-1" name="${escapeXmlAttribute(font)}"/>`), "  </fonttable>"] : []),
    ...pages,
    "</CDXML>",
    ""
  ].join("\n");
}

function buildStandardColorTableXml(colors: readonly string[]): string {
  return [
    "  <colortable>",
    ...colors.map((color) => {
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

function buildVisiblePageChildren(page: DocumentPage, warnings: CompatibilityConversionWarning[], fonts: readonly string[], curveColors: readonly string[], allocator: IdAllocator): string {
  const context = createVisibleExportContext(page, curveColors);
  const objectsById = new Map(page.objects.map((object) => [object.id, object]));
  const preserveSourceIds = page.objects.some(object => object.type === "reaction" || object.type === "bracket");
  for (const object of page.objects) {
    const sourceId = object.compatibility?.originalId;
    if (preserveSourceIds && sourceId) {
      const exportedId = allocator.sourceId(sourceId);
      context.ids.set(object.id, exportedId);
      context.sourceIds.set(sourceId, exportedId);
      if (exportedId !== sourceId) warnings.push({ code: "cdxml.source_id_remapped", sourceObjectId: object.id,
        message: `CDXML source id "${sourceId}" is duplicated or invalid; exported as "${exportedId}".` });
    }
    if (object.type === "molecule") {
      const sourceBonds = preservedCurveAttributes(object.compatibility?.unknown.cdxmlBondIdsByBondId);
      for (const bond of object.bonds) {
        if (sourceBonds[bond.id]) {
          const id = allocator.sourceId(sourceBonds[bond.id]);
          context.bondIdsByRefKey.set(bondRefKey({ objectId: object.id, bondId: bond.id }), id);
          context.sourceIds.set(sourceBonds[bond.id], id);
          if (id !== sourceBonds[bond.id]) warnings.push({ code: "cdxml.source_id_remapped", sourceObjectId: object.id,
            message: `CDXML source bond id "${sourceBonds[bond.id]}" is duplicated or invalid; exported as "${id}".` });
        }
      }
    }
  }
  const groupedIds = new Set(page.objects.flatMap(object => object.type === "group" ? object.childObjectIds : []));
  const emitted = new Set<string>();
  const emit = (object: DocumentObject): string => {
    if (emitted.has(object.id)) return "";
    emitted.add(object.id);
    if (object.type !== "group") return exportVisibleObject(object, context, allocator, warnings, objectsById, fonts);
    const attributes = preservedCurveAttributes(object.compatibility?.unknown.attributes);
    attributes.id = idFor(context.ids, object.id, allocator);
    const children = object.childObjectIds.flatMap(id => {
      const child = objectsById.get(id);
      return child ? [emit(child)] : [];
    }).join("");
    return `<group ${xmlAttributes(attributes)}>${children}</group>`;
  };
  const visibleChildren = page.objects.filter(object => !groupedIds.has(object.id)).map(emit).filter(Boolean);
  // Cyclic or multiply-owned native groups still export each drawable at most once.
  for (const object of page.objects) if (!emitted.has(object.id)) visibleChildren.push(emit(object));
  visibleChildren.push(...exportReactionSchemes(page, context.ids, allocator, warnings, objectsById));
  visibleChildren.push(...exportBracketPairs(page, context, allocator, warnings));
  return visibleChildren.length > 0 ? `\n${visibleChildren.map((child) => indent(child, 4)).join("\n")}\n  ` : "";
}

const reactionListAttributes = [
  "ReactionStepReactants", "ReactionStepProducts", "ReactionStepArrows",
  "ReactionStepObjectsAboveArrow", "ReactionStepObjectsBelowArrow", "ReactionStepPlusses"
] as const;
type ReactionListAttribute = typeof reactionListAttributes[number];

function xmlAttributes(attributes: Record<string, string>): string {
  return Object.entries(attributes).filter(([name]) => /^[A-Za-z_][\w.:-]*$/.test(name))
    .map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`).join(" ");
}

/** Resolve containers to the same page objects, never clones of a molecule used by another step. */
function reactionReferenceLeaves(rootIds: readonly string[], objects: ReadonlyMap<string, DocumentObject>): DocumentObject[] {
  const pending = [...rootIds].reverse();
  const visited = new Set<string>();
  const leaves: DocumentObject[] = [];
  while (pending.length) {
    const id = pending.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const object = objects.get(id);
    if (!object) continue;
    if (object.type === "group") {
      for (let index = object.childObjectIds.length - 1; index >= 0; index--) pending.push(object.childObjectIds[index]);
    } else {
      leaves.push(object);
    }
  }
  return leaves;
}

function isReactionParticipant(object: DocumentObject): boolean {
  // Explicit role lists may name a reagent by text instead of a molecular graph.
  // Containers resolve above; decorative members of those containers are not participants.
  return ["molecule", "text", "superatom", "r-group-label"].includes(object.type);
}

function importReactionStep(
  scheme: XmlElementView, step: XmlElementView, pageIndex: number, schemeIndex: number, stepIndex: number,
  rootsBySourceId: ReadonlyMap<string, string[]>, objects: ReadonlyMap<string, DocumentObject>,
  warnings: CompatibilityConversionWarning[]
): ReactionObject {
  const id = `cdxml_reaction_${pageIndex + 1}_${schemeIndex + 1}_${stepIndex + 1}`;
  const components: ReactionObject["components"] = [];
  const componentKeys = new Set<string>();
  const addComponent = (role: ReactionObject["components"][number]["role"], objectId: string) => {
    const key = `${role}:${objectId}`;
    if (componentKeys.has(key)) return;
    componentKeys.add(key);
    components.push({ role, objectId });
  };
  const conditionsTextObjectIds: string[] = [];
  const arrowObjectIds: string[] = [];
  const plusObjectIds: string[] = [];
  const references: Partial<Record<ReactionListAttribute, string[]>> = {};
  const linkedObjects = new Map<string, DocumentObject>();
  for (const attribute of reactionListAttributes) {
    const roots: string[] = [];
    for (const sourceId of splitCdxmlIdList(step.attributes[attribute])) {
      const resolved = rootsBySourceId.get(sourceId);
      if (!resolved?.length) {
        warnings.push({ code: "cdxml.reaction_reference_unresolved", sourceObjectId: id,
          message: `CDXML step ${step.attributes.id ?? id}: ${attribute} id "${sourceId}" does not resolve to an imported object; ignored.` });
        continue;
      }
      roots.push(...resolved);
    }
    references[attribute] = roots;
    for (const object of reactionReferenceLeaves(roots, objects)) {
      linkedObjects.set(object.id, object);
      if (attribute === "ReactionStepReactants" || attribute === "ReactionStepProducts") {
        const role = attribute === "ReactionStepReactants" ? "reactant" : "product";
        if (isReactionParticipant(object)) addComponent(role, object.id);
        else warnings.push({ code: "cdxml.reaction_object_role_unsupported", sourceObjectId: id,
          message: `CDXML step ${step.attributes.id ?? id}: ${attribute} object "${object.compatibility?.originalId ?? object.id}" is ${object.type}; its source reference is preserved in compatibility metadata without assigning a participant role.` });
      } else if (attribute === "ReactionStepArrows") {
        arrowObjectIds.push(object.id);
      } else if (attribute === "ReactionStepPlusses") {
        plusObjectIds.push(object.id);
      } else if (object.type === "molecule") {
        addComponent("agent", object.id);
      } else if (object.type === "text") {
        conditionsTextObjectIds.push(object.id);
      } else {
        warnings.push({ code: "cdxml.reaction_object_role_unsupported", sourceObjectId: id,
          message: `CDXML step ${step.attributes.id ?? id}: ${attribute} object "${object.compatibility?.originalId ?? object.id}" is ${object.type}; its placement is preserved in compatibility metadata without assigning an agent or condition role.` });
      }
    }
  }
  for (const attribute of Object.keys(step.attributes)) {
    if (attribute.startsWith("ReactionStep") && !reactionListAttributes.some(known => known === attribute)) {
      warnings.push({ code: "cdxml.reaction_step_attribute_preserved", sourceObjectId: id,
        message: `CDXML step ${step.attributes.id ?? id}: ${attribute} is preserved as source metadata; its semantics are not interpreted.` });
    }
  }
  const { id: _schemeId, ...schemeAttributes } = scheme.attributes;
  const { id: _stepId, ...stepAttributes } = step.attributes;
  const extraSchemeChildren = canonicalizeXmlTree(scheme.children.filter(node => elementView(node)?.name !== "step"));
  const extraStepChildren = canonicalizeXmlTree(step.children);
  if (extraStepChildren || (stepIndex === 0 && extraSchemeChildren)) {
    warnings.push({ code: "cdxml.reaction_children_payload_only", sourceObjectId: id,
      message: `CDXML step ${step.attributes.id ?? id} or its scheme contains unrecognized child content, preserved only in the native payload.` });
  }
  return {
    id, type: "reaction", ...(unionObjectBounds([...linkedObjects.values()]) ?? { x: 0, y: 0, width: 0, height: 0 }),
    rotation: 0, style: {}, components,
    conditionsTextObjectIds: [...new Set(conditionsTextObjectIds)],
    arrowObjectIds: [...new Set(arrowObjectIds)], plusObjectIds: [...new Set(plusObjectIds)],
    mappingState: step.attributes.ReactionStepAtomMap ? "unknown" : "absent",
    compatibility: {
      sourceFormat: "cdxml", originalId: step.attributes.id, warnings: [], unknown: {
        cdxmlSchemeKey: `cdxml_scheme_${pageIndex + 1}_${schemeIndex + 1}`,
        cdxmlSchemeId: scheme.attributes.id,
        cdxmlSchemeAttributes: schemeAttributes, cdxmlStepIndex: stepIndex,
        cdxmlStepAttributes: stepAttributes, cdxmlStepReferences: references,
        ...(extraSchemeChildren ? { cdxmlSchemeExtraChildren: extraSchemeChildren } : {}),
        ...(extraStepChildren ? { cdxmlStepExtraChildren: extraStepChildren } : {})
      }
    }
  };
}

function exportReactionSchemes(
  page: DocumentPage, ids: Map<string, string>, allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[], objects: ReadonlyMap<string, DocumentObject>
): string[] {
  const schemes = new Map<string, { id: string; attributes: Record<string, string>; reactions: ReactionObject[] }>();
  for (const reaction of page.objects) {
    if (reaction.type !== "reaction") continue;
    const source = reaction.compatibility?.unknown;
    const key = typeof source?.cdxmlSchemeKey === "string" ? source.cdxmlSchemeKey : `native_scheme_${page.id}_${reaction.id}`;
    let scheme = schemes.get(key);
    if (!scheme) {
      scheme = {
        id: typeof source?.cdxmlSchemeId === "string" ? allocator.sourceId(source.cdxmlSchemeId) : allocator.next(),
        attributes: preservedCurveAttributes(source?.cdxmlSchemeAttributes), reactions: []
      };
      schemes.set(key, scheme);
    }
    scheme.reactions.push(reaction);
  }
  return [...schemes.values()].map(scheme => {
    scheme.reactions.sort((left, right) => {
      const l = left.compatibility?.unknown.cdxmlStepIndex;
      const r = right.compatibility?.unknown.cdxmlStepIndex;
      return (typeof l === "number" ? l : 0) - (typeof r === "number" ? r : 0);
    });
    const steps = scheme.reactions.map(reaction => {
      const source = reaction.compatibility?.unknown;
      const attributes = preservedCurveAttributes(source?.cdxmlStepAttributes);
      if (source?.cdxmlStepExtraChildren || source?.cdxmlSchemeExtraChildren) {
        warnings.push({ code: "cdxml.reaction_children_payload_only", sourceObjectId: reaction.id,
          message: `Reaction ${reaction.id} has unrecognized source child content preserved only in the native payload.` });
      }
      if (reaction.mappingState === "absent") delete attributes.ReactionStepAtomMap;
      for (const attribute of Object.keys(attributes)) {
        if (attribute.startsWith("ReactionStep") && !reactionListAttributes.some(known => known === attribute)) {
          warnings.push({ code: "cdxml.reaction_step_attribute_preserved", sourceObjectId: reaction.id,
            message: `Reaction ${reaction.id}: ${attribute} is exported opaquely from source metadata; it has not been interpreted or updated for native edits.` });
        }
      }
      const references = isRecord(source?.cdxmlStepReferences) ? source.cdxmlStepReferences : {};
      const sourceRoots = (attribute: ReactionListAttribute): string[] => {
        const value = references[attribute];
        return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
      };
      const aboveIds = new Set(reactionReferenceLeaves(sourceRoots("ReactionStepObjectsAboveArrow"), objects).map(object => object.id));
      const belowIds = new Set(reactionReferenceLeaves(sourceRoots("ReactionStepObjectsBelowArrow"), objects).map(object => object.id));
      const auxiliaryIds = [...reaction.components.filter(component => component.role === "agent").map(component => component.objectId), ...reaction.conditionsTextObjectIds];
      const arrows = reaction.arrowObjectIds ?? [];
      const arrow = objects.get(arrows[0]);
      const arrowY = arrow ? arrow.y + arrow.height / 2 : reaction.y + reaction.height / 2;
      const above: string[] = [], below: string[] = [];
      // Drawables without a native agent/condition role keep their explicit source placement.
      for (const [sourceIds, target] of [[aboveIds, above], [belowIds, below]] as const) {
        for (const id of sourceIds) {
          const object = objects.get(id);
          if (object && object.type !== "molecule" && object.type !== "text") target.push(id);
        }
      }
      for (const id of auxiliaryIds) {
        const object = objects.get(id);
        if (aboveIds.has(id)) above.push(id);
        if (belowIds.has(id)) below.push(id);
        if (!aboveIds.has(id) && !belowIds.has(id)) {
          (object && object.y + object.height / 2 > arrowY ? below : above).push(id);
        }
      }
      const desired: Record<ReactionListAttribute, string[]> = {
        ReactionStepReactants: reaction.components.filter(component => component.role === "reactant").map(component => component.objectId),
        ReactionStepProducts: reaction.components.filter(component => component.role === "product").map(component => component.objectId),
        ReactionStepArrows: arrows, ReactionStepObjectsAboveArrow: above, ReactionStepObjectsBelowArrow: below,
        ReactionStepPlusses: reaction.plusObjectIds ?? []
      };
      // Preserve explicitly linked decorative source objects without assigning them chemistry.
      // This also lets an unchanged mixed group keep its source container id on export.
      for (const attribute of ["ReactionStepReactants", "ReactionStepProducts"] as const) {
        desired[attribute].push(...reactionReferenceLeaves(sourceRoots(attribute), objects)
          .filter(object => !isReactionParticipant(object)).map(object => object.id));
      }
      attributes.id = idFor(ids, reaction.id, allocator);
      for (const attribute of reactionListAttributes) {
        const remaining = new Set(desired[attribute]);
        const exported: string[] = [];
        for (const rootId of sourceRoots(attribute)) {
          const leaves = reactionReferenceLeaves([rootId], objects);
          if (!leaves.length || !leaves.every(object => remaining.has(object.id))) continue;
          exported.push(idFor(ids, rootId, allocator));
          for (const object of leaves) remaining.delete(object.id);
        }
        for (const id of remaining) {
          if (objects.has(id)) exported.push(idFor(ids, id, allocator));
          else warnings.push({ code: "cdxml.reaction_reference_unresolved", sourceObjectId: reaction.id,
            message: `Native reaction ${reaction.id}: ${attribute} object "${id}" is missing; ignored on export.` });
        }
        const value = exported.join(" ");
        if (value || attributes[attribute] !== undefined) {
          // Keep original list whitespace too when no semantic or id edit requires rewriting it.
          if (splitCdxmlIdList(attributes[attribute]).join(" ") !== value) attributes[attribute] = value;
          else attributes[attribute] ??= value;
        }
      }
      if (reaction.mappingState !== "absent" && !attributes.ReactionStepAtomMap) {
        warnings.push({ code: "cdxml.reaction_mapping_payload_only", sourceObjectId: reaction.id,
          message: `Reaction ${reaction.id} has mapping state "${reaction.mappingState}" without an atom map; only the native payload preserves this state.` });
      }
      return `<step ${xmlAttributes(attributes)}/>`;
    }).join("");
    return `<scheme ${xmlAttributes({ ...scheme.attributes, id: scheme.id })}>${steps}</scheme>`;
  });
}

function exportVisibleObject(
  object: DocumentObject,
  context: VisibleExportContext,
  allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[],
  objectsById: ReadonlyMap<string, DocumentObject>,
  fonts: readonly string[]
): string {
  if (object.type === "unknown-compatibility-object" && object.sourceObjectType === "curve") {
    const sourceAttributes = object.compatibility?.unknown.cdxmlCurveAttributes;
    if (isRecord(sourceAttributes)) {
      const attributes = preservedCurveAttributes(sourceAttributes);
      attributes.id = idFor(context.ids, object.id, allocator);
      const sourceColor = object.compatibility?.unknown.cdxmlCurveColor;
      const colorIndex = typeof sourceColor === "string" ? context.curveColors.indexOf(sourceColor) : -1;
      if (colorIndex >= 0) attributes.color = String(colorIndex + 2);
      return curveXml(attributes);
    }
  }
  if (object.type === "table") {
    return exportTableObject(object, context.ids, allocator, warnings, fonts);
  }
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
    return exportGraphicObject(object, context.ids, allocator, warnings, context.curveColors);
  }
  if (object.type === "bracket") {
    if (!canExportBracketGlyph(object)) warnings.push({
      code: "cdxml.bracket_geometry_approximated",
      message: `Bracket ${object.id} has unsupported ${object.bracketKind} shape, rotation or tilt; its glyph is approximated by an axis-aligned ${object.bracketKind === "round" ? "round" : "square"} bounding box.`,
      sourceObjectId: object.id
    });
    if (!exportableBracketPair(object, objectsById)) {
      const records = object.compatibility?.unknown.cdxmlBracketCrossings;
      if (Array.isArray(records)) for (const record of records) if (isRecord(record)) {
        const attrs = preservedCurveAttributes(record.attributes);
        warnings.push({ code: "cdxml.bracket_crossing_dropped", sourceObjectId: object.id,
          message: `Bracket crossing BondID "${attrs.BondID}" has no complete bracket pair and is NOT written.` });
      }
    }
    return exportBracketGlyph(object, context, allocator);
  }
  if (object.type === "reaction") {
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

function canExportBracketGlyph(object: BracketObject): boolean {
  return (object.bracketKind === "square" || object.bracketKind === "round") && object.rotation === 0 &&
    !(Number(object.style.tiltXDegrees) || Number(object.style.tiltYDegrees));
}

function hasUnmappedBracketStyle(attributes: Record<string, unknown>): boolean {
  // Every attribute is re-emitted, including appearance that the model does not interpret.
  return attributes.LineType !== undefined || attributes.color !== undefined ||
    attributes.LineWidth !== undefined && Number(attributes.LineWidth) !== cssPxToCdxml(1.5);
}

function exportableBracketPair(object: BracketObject, objects: ReadonlyMap<string, DocumentObject>): boolean {
  const pair = [...objects.values()].filter((item): item is BracketObject => item.type === "bracket" &&
    !!object.pairId && item.pairId === object.pairId);
  return pair.length === 2 &&
    pair.some(item => item.side === "open") && pair.some(item => item.side === "close");
}

function bracketSourceState(object: BracketObject): string {
  return JSON.stringify([object.bracketUsage, object.repeatUnit, object.repeatCount, object.label]);
}

function bracketUsageAttribute(pair: BracketObject[]): string | undefined {
  const usage = pair.find(object => object.bracketUsage && object.bracketUsage !== "generic")?.bracketUsage;
  if (usage === "multiple") return "MultipleGroup";
  if (usage === "sru" || pair.some(object => object.repeatUnit)) return "SRU";
  if (usage === "unknown") {
    const raw = pair[0].compatibility?.unknown.bracketedGroup;
    const attrs = isRecord(raw) ? preservedCurveAttributes(raw.attributes) : {};
    const graphic = pair.map(object => object.compatibility?.unknown.cdxmlBracket)
      .find(raw => isRecord(raw) && isRecord(raw.attributes) && raw.attributes.BracketUsage);
    return attrs.BracketUsage ?? (isRecord(graphic) ? preservedCurveAttributes(graphic.attributes).BracketUsage : undefined) ?? "Unspecified";
  }
  return undefined;
}

function bracketGeometryKey(object: BracketObject): string {
  return JSON.stringify([object.x, object.y, object.width, object.height, object.rotation, object.bracketKind, object.side]);
}

function preservedBracketChildren(value: unknown, excluded: readonly string[] = []): string {
  if (!Array.isArray(value)) return "";
  return value.map(node => {
    if (!isRecord(node)) return "";
    if (typeof node["#text"] === "string") return escapeXmlText(node["#text"]);
    const name = Object.keys(node).find(key => /^[a-z_][\w.:-]*$/i.test(key) && Array.isArray(node[key]));
    if (!name || excluded.includes(name)) return "";
    return `<${name} ${xmlAttributes(preservedCurveAttributes(node[":@"]))}>${preservedBracketChildren(node[name])}</${name}>`;
  }).join("");
}

function exportBracketGlyph(object: BracketObject, context: VisibleExportContext, allocator: IdAllocator): string {
  const raw = object.compatibility?.unknown.cdxmlBracket;
  const attrs = isRecord(raw) ? preservedCurveAttributes(raw.attributes) : {};
  const unchangedGeometry = object.compatibility?.unknown.cdxmlBracketGeometry === bracketGeometryKey(object);
  attrs.id = idFor(context.ids, object.id, allocator);
  attrs.GraphicType = "Bracket";
  attrs.BracketType = object.bracketKind === "round" ? "Round" : "Square";
  // Source endpoint order is opaque. Geometry, never point order, determines the native side.
  if (!unchangedGeometry || !attrs.BoundingBox) attrs.BoundingBox = formatBoundingBox(object);
  attrs.LineWidth ??= formatNumber(cssPxToCdxml(1.5));
  const sourceColor = object.compatibility?.unknown.cdxmlCurveColor;
  if (typeof sourceColor === "string" && attrs.color !== undefined) {
    const index = context.curveColors.indexOf(sourceColor);
    if (index >= 0) attrs.color = String(index + 2);
  }
  if (object.compatibility?.unknown.cdxmlBracketState !== bracketSourceState(object)) {
    const usage = bracketUsageAttribute([object]);
    if (usage) attrs.BracketUsage = usage; else delete attrs.BracketUsage;
  }
  const children = isRecord(raw) ? preservedBracketChildren(raw.children) : "";
  return children ? `<graphic ${xmlAttributes(attrs)}>${children}</graphic>` : `<graphic ${xmlAttributes(attrs)}/>`;
}

function exportBracketPairs(page: DocumentPage, context: VisibleExportContext, allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[]): string[] {
  const pairs = new Map<string, BracketObject[]>();
  for (const object of page.objects) if (object.type === "bracket" && object.pairId) {
    const pair = pairs.get(object.pairId) ?? []; pair.push(object); pairs.set(object.pairId, pair);
  }
  const groups: string[] = [];
  const objectsById = new Map(page.objects.map(object => [object.id, object]));
  for (const pair of pairs.values()) {
    if (!exportableBracketPair(pair[0], objectsById)) continue;
    const closing = pair.find(object => object.side === "close")!;
    const raw = closing.compatibility?.unknown.bracketedGroup;
    const attrs = isRecord(raw) ? preservedCurveAttributes(raw.attributes) : {};
    const unchanged = pair.every(object => object.compatibility?.unknown.cdxmlBracketState === bracketSourceState(object));
    const membershipUnchanged = pair.every(object => object.compatibility?.unknown.cdxmlBracketMembership === JSON.stringify(object.containedObjectIds));
    const requestedMembers = [...new Set(pair.flatMap(object => object.containedObjectIds))];
    const members = requestedMembers.filter(id => objectsById.get(id)?.type === "molecule").map(id => idFor(context.ids, id, allocator));
    if (members.length !== requestedMembers.length) warnings.push({ code: "cdxml.bracket_membership_payload_only", sourceObjectId: closing.id,
      message: "Bracket membership for missing or non-molecule objects is preserved only in the ChemDraft payload; visible CDXML membership includes whole molecule objects only." });
    const memberRecords = closing.compatibility?.unknown.cdxmlBracketMembers;
    const preservedMembers = splitCdxmlIdList(attrs.BracketedObjectIDs).flatMap(sourceId => {
      const record = Array.isArray(memberRecords) ? memberRecords.find(record => isRecord(record) && record.sourceId === sourceId) : undefined;
      if (isRecord(record) && typeof record.objectId === "string") {
        const member = objectsById.get(record.objectId);
        // Native edits replace whole-molecule membership; atom membership stays atom-scoped.
        if (member && (typeof record.atomId === "string"
          ? member.type === "molecule" && member.atoms.some(atom => atom.id === record.atomId)
          : member.type !== "molecule" || membershipUnchanged || requestedMembers.includes(member.id))) {
          const id = typeof record.atomId === "string" ? context.atomIdsByObjectId.get(member.id)?.get(record.atomId) : context.ids.get(member.id);
          if (id) return [id];
        }
      } else if (membershipUnchanged) {
        // Truly unresolved source references stay opaque until membership changes.
        return [sourceId];
      }
      warnings.push({ code: "cdxml.bracket_member_dropped", sourceObjectId: closing.id,
        message: `Bracket member "${sourceId}" no longer resolves to an exported member and is NOT written.` });
      return [];
    });
    const exportedMembers = [...new Set([...preservedMembers, ...(membershipUnchanged && attrs.BracketedObjectIDs !== undefined ? [] : members)])];
    if (exportedMembers.length) attrs.BracketedObjectIDs = exportedMembers.join(" ");
    else delete attrs.BracketedObjectIDs;
    attrs.id = attrs.id ? allocator.sourceId(attrs.id) : allocator.next();
    const usage = bracketUsageAttribute(pair);
    if (usage) attrs.BracketUsage = usage; else delete attrs.BracketUsage;
    const invalidRepeatCount = closing.compatibility?.unknown.cdxmlBracketInvalidRepeatCount;
    const hasInvalidRepeatCount = invalidRepeatCount !== undefined;
    if (!hasInvalidRepeatCount) {
      if (usage === "SRU" && (closing.label !== "" || attrs.SRULabel !== undefined || !unchanged)) attrs.SRULabel = closing.label ?? "n";
      else if (!unchanged) delete attrs.SRULabel;
    }
    const count = pair.find(object => object.repeatCount !== undefined)?.repeatCount;
    if (count !== undefined) {
      if (hasInvalidRepeatCount) warnings.push({ code: "cdxml.bracket_repeat_count_dropped", sourceObjectId: closing.id,
        message: `Bracket RepeatCount "${invalidRepeatCount}" is NOT written because a native repeat count of ${count} replaces it.` });
      attrs.RepeatCount = String(count);
    } else if (!unchanged && !hasInvalidRepeatCount) delete attrs.RepeatCount;
    const attachments = pair.map(object => {
      const source = object.compatibility?.unknown.cdxmlBracketAttachment;
      const attachmentAttrs = isRecord(source) ? preservedCurveAttributes(source.attributes) : {};
      attachmentAttrs.id = attachmentAttrs.id ? allocator.sourceId(attachmentAttrs.id) : allocator.next();
      attachmentAttrs.GraphicID = idFor(context.ids, object.id, allocator);
      const records = object.compatibility?.unknown.cdxmlBracketCrossings;
      const usedRecords = new Set<unknown>();
      const crossings = (object.crossingBondIds ?? []).flatMap(ref => {
        const molecule = objectsById.get(ref.objectId);
        const bond = molecule?.type === "molecule" ? molecule.bonds.find(bond => bond.id === ref.bondId) : undefined;
        if (!bond) return [];
        const record = Array.isArray(records) ? records.find(record => !usedRecords.has(record) && isRecord(record) && isRecord(record.ref) &&
          record.ref.objectId === ref.objectId && record.ref.bondId === ref.bondId) : undefined;
        if (record) usedRecords.add(record);
        const crossingAttrs = isRecord(record) ? preservedCurveAttributes(record.attributes) : {};
        crossingAttrs.id = crossingAttrs.id ? allocator.sourceId(crossingAttrs.id) : allocator.next();
        crossingAttrs.BondID = cdxmlBondIdForRef(ref, context, allocator);
        if (isRecord(record) && record.bondIdentity === JSON.stringify([bond.fromAtomId, bond.toAtomId])) {
          if (crossingAttrs.InnerAtomID) {
            const atomId = typeof record.innerAtomId === "string" ? record.innerAtomId :
              Object.entries(preservedCurveAttributes(molecule?.compatibility?.unknown.cdxmlAtomIdsByAtomId))
                .find(([, sourceId]) => sourceId === crossingAttrs.InnerAtomID)?.[0];
            const id = atomId ? context.atomIdsByObjectId.get(ref.objectId)?.get(atomId) : undefined;
            if (id) crossingAttrs.InnerAtomID = id;
            else {
              warnings.push({ code: "cdxml.bracket_inner_atom_dropped", sourceObjectId: object.id,
                message: `Bracket crossing InnerAtomID "${crossingAttrs.InnerAtomID}" cannot be resolved to its original atom and is NOT written.` });
              delete crossingAttrs.InnerAtomID;
            }
          }
        } else {
          if (crossingAttrs.InnerAtomID) warnings.push({ code: "cdxml.bracket_inner_atom_dropped", sourceObjectId: object.id,
            message: `Bracket crossing InnerAtomID "${crossingAttrs.InnerAtomID}" no longer matches its bond and is NOT written.` });
          delete crossingAttrs.InnerAtomID;
        }
        return [`<crossingbond ${xmlAttributes(crossingAttrs)}>${isRecord(record) ? preservedBracketChildren(record.children) : ""}</crossingbond>`];
      });
      // An unrelated semantic or membership edit never deletes an opaque crossing.
      if (Array.isArray(records)) for (const record of records) {
        if (!isRecord(record) || usedRecords.has(record)) continue;
        if (record.ref !== undefined) {
          const attributes = preservedCurveAttributes(record.attributes);
          warnings.push({ code: "cdxml.bracket_crossing_dropped", sourceObjectId: object.id,
            message: `Bracket crossing BondID "${attributes.BondID}" was removed or its bond was deleted and is NOT written.` });
          continue;
        }
        const crossingAttrs = preservedCurveAttributes(record.attributes);
        crossingAttrs.id = crossingAttrs.id ? allocator.sourceId(crossingAttrs.id) : allocator.next();
        crossings.push(`<crossingbond ${xmlAttributes(crossingAttrs)}>${preservedBracketChildren(record.children)}</crossingbond>`);
        warnings.push({ code: "cdxml.bracket_crossing_unresolved", sourceObjectId: object.id,
          message: `Bracket crossing BondID "${crossingAttrs.BondID}" is unresolved and remains compatibility data.` });
      }
      return `<bracketattachment ${xmlAttributes(attachmentAttrs)}>${crossings.join("")}${isRecord(source) ? preservedBracketChildren(source.children, ["crossingbond"]) : ""}</bracketattachment>`;
    });
    groups.push(`<bracketedgroup ${xmlAttributes(attrs)}>${attachments.join("")}${isRecord(raw) ? preservedBracketChildren(raw.children, ["bracketattachment"]) : ""}</bracketedgroup>`);
  }
  return groups;
}

function createVisibleExportContext(page: DocumentPage, curveColors: readonly string[]): VisibleExportContext {
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
    curveColors,
    bondIdsByRefKey: new Map(),
    atomIdsByObjectId: new Map(),
    sourceIds: new Map(),
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
  const atomIds = new Map(Object.entries(preservedCurveAttributes(molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId))
    .map(([atomId, sourceId]) => [atomId, allocator.sourceId(sourceId)]));
  context.atomIdsByObjectId.set(molecule.id, atomIds);
  const bondedAtomIds = new Set(molecule.bonds.flatMap((bond) => [bond.fromAtomId, bond.toAtomId]));
  const hasIsotopes = molecule.atoms.some((atom) =>
    atom.isotope !== undefined || atom.element === "D" || atom.element === "T");
  const labels = hasIsotopes
    ? new Map(planMoleculeAtomLabels(molecule).map((plan) => [plan.atom.id, plan.layout.runs]))
    : undefined;
  const atomLines = molecule.atoms.map((atom) => {
    const nodeId = idFor(atomIds, atom.id, allocator);
    const sourceAtomId = preservedCurveAttributes(molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId)[atom.id];
    if (sourceAtomId) context.sourceIds.set(sourceAtomId, nodeId);
    // An element symbol chemists write on bonds — "Ar" (aryl), "Ac", "Pr", "Ts" — typed as a label is
    // not that element on a bonded atom. Writing its atomic number would hand every CDXML reader
    // argon or tennessine, so it goes out as its label, the same way any other non-element label
    // does, with a warning. An element that came from a structure (no `labelLiteral`) stays the
    // element and keeps its atomic number: a real Ac–Cl bond is actinium.
    const bondedMeaning = bondedAtomIds.has(atom.id) && atom.labelLiteral === true
      ? bondedElementLabelMeaning(atom.element)
      : undefined;
    const heavyHydrogen = atom.element === "D" || atom.element === "T";
    const isotope = atom.element === "D" ? 2 : atom.element === "T" ? 3 : atom.isotope;
    const elementNumber = heavyHydrogen ? 1
      : bondedMeaning === undefined ? atomicNumberForElement(atom.element) : undefined;
    const attributes = [
      `id="${nodeId}"`,
      `p="${formatPoint(atom)}"`
    ];
    if (elementNumber !== undefined && atom.element !== "C") {
      attributes.push(`Element="${elementNumber}"`);
    }
    if (isotope !== undefined) {
      attributes.push(`Isotope="${isotope}"`);
    }
    if (elementNumber === undefined) {
      attributes.push(`Element="${escapeXmlAttribute(atom.element)}"`);
      warnings.push(bondedMeaning === undefined
        ? {
            code: "cdxml.atom_element_symbol_exported",
            message: `Atom element "${atom.element}" was exported as a CDXML element label because no atomic number mapping exists.`,
            sourceObjectId: molecule.id
          }
        : {
            code: "cdxml.bonded_element_label_exported",
            message: `Atom "${atom.element}" on a bond is ${bondedMeaning}, not the element ${atom.element}; it was exported as the label "${atom.element}" rather than an atomic number.`,
            sourceObjectId: molecule.id
          });
    }
    // A side-dependent label ("SCN") has its recorded reading from the side its bond came from
    // (`labelBondSide`). The visible CDXML has only the drawing, so a reader without ChemDraft's
    // embedded document reads the drawn side, which can be the other isomer. Say so, naming the
    // atom (AGENTS.md §7: warn, never degrade quietly).
    const record = atom.labelBondSide;
    const recordedNeighbour = record ? molecule.atoms.find((candidate) => candidate.id === record.atomId) : undefined;
    const drawnSide = recordedNeighbour ? drawnLabelBondSide(atom, [recordedNeighbour]) : undefined;
    if (record && drawnSide && drawnSide !== record.side) {
      warnings.push({
        code: "cdxml.label_bond_side_turned",
        message: record.side === "left"
          ? `Label "${atom.element}" on atom ${atom.id} is recorded as its cyano group (bond on the left), but its bond is drawn on the right, so the visible CDXML reads as the N-bonded isomer, which imports as an unrecognized group (a bare formula). ChemDraft's embedded document keeps the recorded reading.`
          : `Label "${atom.element}" on atom ${atom.id} is recorded as the N-bonded isomer (a bare formula; bond on the right), but its bond is drawn on the left, so the visible CDXML reads as its cyano group. ChemDraft's embedded document keeps the recorded reading.`,
        sourceObjectId: molecule.id
      });
    }
    if (atom.formalCharge !== 0) {
      attributes.push(`Charge="${atom.formalCharge}"`);
    }
    if (atom.markRadicals === 1 || atom.markRadicals === 2) {
      attributes.push(`Radical="${atom.markRadicals === 1 ? "Doublet" : "Triplet"}"`);
    } else if (atom.markRadicals) {
      warnings.push({ code: "cdxml.atom_radical_unsupported", message: `CDXML export: atom ${atom.id} has ${atom.markRadicals} unpaired electrons, which cannot be encoded by Radical.`, sourceObjectId: molecule.id, atomIds: [atom.id] });
    }
    // NumHydrogens is the standard CDXML atom constraint, understood without ChemDraft's native
    // payload. Keep aromatic display (Order=1.5) while preserving the source's chosen N–H site.
    // In particular, zero is a constraint too; omitting it reopens the tautomer choice.
    if (atom.hydrogenCount !== undefined) {
      attributes.push(`NumHydrogens="${atom.hydrogenCount}"`);
    }
    if (isotope !== undefined) {
      const label = (labels?.get(atom.id) ?? []).map((run) => {
        // CDXML font-face bits: 0x40 superscript, 0x20 subscript, as for table text.
        const face = run.script === "superscript" ? ' face="64"'
          : run.script === "subscript" ? ' face="32"' : "";
        return `<s${face}>${escapeXmlText(run.text)}</s>`;
      }).join("");
      return `<n ${attributes.join(" ")}><t>${label}</t></n>`;
    }
    return `<n ${attributes.join(" ")}/>`;
  });
  const bondLines = molecule.bonds.map((bond) => exportBond(bond, molecule, atomIds, context, allocator, warnings));

  if (molecule.chemistry?.radicalCount || molecule.chemistry?.stereochemistry.length) {
    warnings.push({
      code: "cdxml.molecule_metadata_payload_only",
      message: "Molecule radical and stereochemistry aggregates remain in the native payload; " +
        "isotopes are preserved on CDXML atoms and supported bond stereo is written visibly.",
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
  // A native dative bond (single + dashed) keeps its meaning in CDXML, which has an order for it;
  // written as Order="1" it read back — in ChemDraw or RDKit — as an ordinary covalent single bond.
  const order = isDativeBond(bond) ? "dative" : cdxmlBondOrder(bond, molecule, warnings);
  const attributes = [
    `id="${bondId}"`,
    `B="${atomIds.get(bond.fromAtomId) ?? escapeXmlAttribute(bond.fromAtomId)}"`,
    `E="${atomIds.get(bond.toAtomId) ?? escapeXmlAttribute(bond.toAtomId)}"`,
    `Order="${escapeXmlAttribute(order)}"`
  ];
  if (bond.order === "double" && bond.stereo === "either") {
    // Wavy on a double bond means crossed/E/Z-unspecified, regardless of its coordinates.
    attributes.push('Display="Wavy"');
    if (bond.display?.bondStyle) {
      warnings.push({
        code: "cdxml.open_double_bond_style_native_only",
        message: `E/Z-unspecified double bond ${bond.id} is written with Display="Wavy"; its ${bond.display.bondStyle} style is kept only in the native payload.`,
        sourceObjectId: molecule.id,
        bondIds: [bond.id]
      });
    }
  } else {
    const bondStyle = cdxmlBondDisplayForBondStyle(bond.display);
    if (bondStyle) {
      attributes.push(`Display="${bondStyle}"`);
    }
  }
  if (bond.display?.doubleBondSide && bond.display.doubleBondSide !== "automatic") {
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

function exportTableObject(
  table: TableObject,
  ids: Map<string, string>,
  allocator: IdAllocator,
  warnings: CompatibilityConversionWarning[],
  fonts: readonly string[]
): string {
  const layout = planTableLayout(table);
  const style = nativeTextStyleFromObjectStyle(table.style);
  const font = fonts.indexOf(style.fontFamily) + 1;
  const texts: string[] = [];
  const writeLines = (lines: typeof layout.cells[number]["lines"], fontSizePx: number) => {
    for (const line of lines) {
      const runs = line.pieces.flatMap(piece => piece.runs);
      if (!runs.some(run => run.text.length > 0)) continue;
      const first = line.pieces[0];
      const after = line.pieces.length === 2 ? line.pieces[1].runs : [];
      const afterWidth = after.reduce((sum, run) => sum + measureTextRun(run.text, {
        fontSizePx: run.script === "normal" && typeof run.style.fontSizePx === "number" ? run.style.fontSizePx : fontSizePx,
        fontWeight: typeof run.style.fontWeight === "number" ? run.style.fontWeight : style.fontWeight,
        script: run.script
      }) + [...run.text].length * (typeof run.style.letterSpacingPx === "number" ? run.style.letterSpacingPx : style.letterSpacingPx), 0);
      const justification = first.anchor === "end" ? "Right" : first.anchor === "middle" ? "Center" : "Left";
      const runXml = runs.map(run => {
        const weight = typeof run.style.fontWeight === "number" ? run.style.fontWeight : style.fontWeight;
        const italic = typeof run.style.fontStyle === "string" ? run.style.fontStyle : style.fontStyle;
        const face = (weight >= 600 ? 1 : 0) + (italic === "italic" ? 2 : 0) +
          (run.script === "subscript" ? 32 : run.script === "superscript" ? 64 : 0);
        const size = run.script === "normal" && typeof run.style.fontSizePx === "number" ? run.style.fontSizePx : fontSizePx;
        return `<s font="${font}" size="${formatNumber(cssPxToCdxml(size))}" face="${face}">${escapeXmlText(run.text)}</s>`;
      }).join("");
      texts.push(`<t id="${allocator.next()}" p="${formatPoint({ x: first.x + afterWidth, y: line.baselineY })}" Justification="${justification}">${runXml}</t>`);
    }
  };
  if (layout.captionBox) writeLines(layout.captionBox.lines, style.fontSizePx * 0.9);
  layout.cells.forEach(cell => writeLines(cell.lines, style.fontSizePx));
  layout.footnoteBoxes.forEach(box => writeLines(box.lines, style.fontSizePx * 0.9));
  const lines = layout.rules.map(rule => exportGraphicAsCdxmlGraphic({
    id: table.id, type: "graphic", graphicKind: "line", x: rule.x1, y: rule.y1,
    width: rule.x2 - rule.x1, height: rule.y2 - rule.y1, rotation: 0,
    style: { strokeWidth: rule.widthPx, strokeColor: style.color }, data: {}
  }, allocator.next(), warnings));
  const caption = [...(table.caption?.text ?? "").replace(/\s+/gu, " ").trim()];
  const tableName = caption.length > 0
    ? `Table "${caption.length > 40 ? `${caption.slice(0, 39).join("")}…` : caption.join("")}"`
    : "The table";
  warnings.push({
    code: "cdxml.table_approximated",
    message: `${tableName} was written as ${texts.length} text objects and ${lines.length} lines, so other programs will not edit it as a table; ChemDraft reopens it exactly from the embedded ChemDraft payload.`,
    sourceObjectId: table.id
  });
  if (table.rotation !== 0) warnings.push({
    code: "cdxml.table_rotation_approximated",
    message: `${tableName} was exported without its rotation.`,
    sourceObjectId: table.id
  });
  return `<group id="${idFor(ids, table.id, allocator)}">${texts.join("")}${lines.join("")}</group>`;
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
  warnings: CompatibilityConversionWarning[],
  curveColors: readonly string[] = standardCdxmlColorTable
): string {
  if (graphic.graphicKind === "image") {
    warnings.push({ code: "cdxml.picture_not_saved", message: `CDXML export: picture ${graphic.id} is not saved in CDXML`, sourceObjectId: graphic.id });
    return "";
  }
  const graphicId = idFor(ids, graphic.id, allocator);
  if (graphic.compatibility?.unknown.cdxmlElementName === "curve") {
    return exportGraphicAsCdxmlCurve(graphic, graphicId, warnings, curveColors);
  }
  warnForGraphicCdxmlLimitations(graphic, warnings);
  // An object that came in as an <arrow> goes back out as one, even now that it is tagged as a
  // native arrow. The element's ArrowheadHead/ArrowheadTail/ArrowheadType triple is RICHER than the
  // closed ArrowType enum — it can say which ends are full/half with a shared solid/open type —
  // so round-tripping the source form loses less than promoting it to a reaction arrow would.
  if (graphic.compatibility?.unknown.cdxmlElementName === "arrow") {
    return exportGraphicAsCdxmlArrow(graphic, graphicId, warnings);
  }
  if (isSemanticReactionArrowGraphic(graphic)) {
    return exportSemanticReactionArrowGraphic(graphic, graphicId, warnings);
  }
  warnForGenericGraphicMarkerLoss(graphic, warnings);
  return exportGraphicAsCdxmlGraphic(graphic, graphicId, warnings);
}

/**
 * The chemistry an art arrow carries that standard CDXML can name, or undefined for a plain
 * (decorative) art arrow. Arrows are drawn with the art-arrow tools for their rich editing but
 * carry their meaning in `artToolId`, which is how the CDXML layer knows to write/read them as
 * chemical arrows rather than generic graphics.
 *
 * `fishhook` is deliberately NOT a member of `ArrowObject["arrowKind"]`. That enum describes the
 * legacy `reaction-arrow` OBJECT, and a half-headed arrow imports as a graphic (see
 * {@link importHalfHeadArrowAsFishhook}) — so adding a member there would invent a state no
 * reaction-arrow object can ever hold and force a dead case into every switch over it. The question
 * being answered here is a CDXML one, so it is keyed on the tool rather than on that enum.
 */
type SemanticArrowExportKind = Exclude<ArrowObject["arrowKind"], "unknown"> | "fishhook";

function semanticArrowExportKind(graphic: GraphicObject): SemanticArrowExportKind | undefined {
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
  // Only the straight fishhook. `fishhookCurved` is one-electron too, but this exporter writes a
  // Start/End pair, so naming it would trade a curved pushing arrow's curvature — the whole point
  // of it — for a label. It stays a graphic, where its arc survives.
  if (graphic.data.artToolId === "fishhookArrow") {
    return "fishhook";
  }
  return undefined;
}

function isSemanticReactionArrowGraphic(graphic: GraphicObject): boolean {
  return semanticArrowExportKind(graphic) !== undefined;
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
  const arrowKind = semanticArrowExportKind(graphic) ?? "forward";
  const arrowType = cdxmlArrowTypeByExportKind[arrowKind];
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
  arrowKind: SemanticArrowExportKind,
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

/**
 * The generic `<graphic>` export writes geometry and stroke only — no `ArrowType`, no arrowhead
 * attributes, no shaft mark. Standard CDXML simply cannot name a no-reaction cross or a head on a
 * decorative stroke, so the loss is unavoidable; going quiet about it is not. A no-reaction arrow
 * that reopens as a plain line has had its meaning inverted, not merely simplified.
 *
 * The two sibling arrow paths already warn for this class ({@link warnForSemanticArrowHeadLoss},
 * {@link warnForUnrepresentableArrowheads}); this covers the graphics that reach neither.
 */
function warnForGenericGraphicMarkerLoss(
  graphic: GraphicObject,
  warnings: CompatibilityConversionWarning[]
): void {
  const headKind = graphic.data.markerEnd?.kind;
  const tailKind = graphic.data.markerStart?.kind;
  const hasHead = (headKind !== undefined && headKind !== "none") || (tailKind !== undefined && tailKind !== "none");
  const hasShaftMark = graphic.data.shaftMark !== undefined;
  if (!hasHead && !hasShaftMark) {
    return;
  }

  warnings.push({
    code: "cdxml.graphic_marker_payload_only",
    message: hasShaftMark
      ? "This arrow's shaft mark (and any arrowhead) is preserved only in the embedded ChemDraft payload; standard CDXML has no spelling for it, so other programs will read a plain line."
      : "This stroke's arrowhead is preserved only in the embedded ChemDraft payload; standard CDXML carries heads on reaction arrows only, so other programs will read a plain line.",
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

/** Curves keep their source spelling where the corresponding native value is unchanged. Source
 * attributes hold sizing ratios and handedness that the native marker model cannot express. */
function exportGraphicAsCdxmlCurve(
  graphic: GraphicObject,
  graphicId: string,
  warnings: CompatibilityConversionWarning[],
  colors: readonly string[]
): string {
  const attributes = preservedCurveAttributes(graphic.compatibility?.unknown.cdxmlCurveAttributes);
  const sourceNodes = curveNodesFromCdxml(attributes.CurvePoints);
  const nodes = graphic.data.pathNodes;
  if (!nodes?.length || graphic.data.artPathKind !== "bezier") {
    warnings.push({
      code: "cdxml.curve_geometry_payload_only",
      message: "This curve no longer has native Bezier nodes; its source CDXML curve is retained, and its edited geometry remains only in the native payload.",
      sourceObjectId: graphic.id
    });
  } else if (JSON.stringify(nodes) !== JSON.stringify(sourceNodes)) {
    // A closed spline needs the first incoming and last outgoing handles for its final segment.
    // Incoming/knot/outgoing triples retain them without duplicating the first native node.
    const points = graphic.data.pathClosed
      ? nodes.flatMap(node => [node.inControl ?? node.point, node.point, node.outControl ?? node.point])
      : [nodes[0].point];
    if (!graphic.data.pathClosed) {
      for (let index = 1; index < nodes.length; index += 1) {
        points.push(nodes[index - 1].outControl ?? nodes[index - 1].point,
          nodes[index].inControl ?? nodes[index].point, nodes[index].point);
      }
    }
    attributes.CurvePoints = points.map(formatPoint).join(" ");
    delete attributes.BoundingBox;
  }
  const sourceMarkers = cdxmlArrowMarkers({ name: "curve", attributes, children: [] });
  if (graphic.data.markerStart?.kind !== sourceMarkers.markerStart?.kind ||
      graphic.data.markerEnd?.kind !== sourceMarkers.markerEnd?.kind) {
    delete attributes.ArrowheadHead;
    delete attributes.ArrowheadTail;
    delete attributes.ArrowheadType;
    const head = cdxmlArrowheadForMarker(graphic.data.markerEnd);
    const tail = cdxmlArrowheadForMarker(graphic.data.markerStart);
    if (head) attributes.ArrowheadHead = head.head;
    if (tail) attributes.ArrowheadTail = tail.head;
    attributes.ArrowheadType = head?.type ?? tail?.type ?? "Solid";
    warnForUnrepresentableArrowheads(graphic, warnings);
  }
  if ([graphic.data.markerStart, graphic.data.markerEnd].some(marker => marker && marker.kind !== "none" &&
    ((marker.sizePx !== undefined && marker.sizePx !== (marker.kind === "half-arrow" ? defaultCdxmlHalfArrowheadSizePx : defaultCdxmlArrowheadSizePx)) || marker.angleDegrees))) {
    warnings.push({ code: "cdxml.curve_head_size_payload_only",
      message: "Edited native curve head dimensions remain only in the native payload; standard CDXML retains the source head sizing attributes.", sourceObjectId: graphic.id });
  }
  const color = normalizeHexColor(graphic.style.strokeColor ?? defaultCdxmlStrokeColor);
  const colorIndex = color ? colors.indexOf(color) : -1;
  if (colorIndex >= 0) attributes.color = String(colorIndex + 2);
  else {
    delete attributes.color;
    warnings.push({ code: "cdxml.graphic_color_approximation",
      message: `Curve color "${graphic.style.strokeColor}" cannot be represented in the CDXML color table.`, sourceObjectId: graphic.id });
  }
  const sourceStyle = graphicStyleFromCdxmlCurve({ name: "curve", attributes, children: [] }, { colorByIndex: new Map() });
  if (graphic.style.strokeWidth !== sourceStyle.strokeWidth) {
    attributes.LineWidth = formatNumber(cssPxToCdxml(graphic.style.strokeWidth ?? defaultCdxmlLineWidthPx));
    // Explicit widths take precedence over a Bold line's inherited BoldWidth.
    if (normalizedCdxmlToken(attributes.LineType) === "bold") attributes.BoldWidth = attributes.LineWidth;
  }
  if (graphic.style.strokeDasharray !== sourceStyle.strokeDasharray) {
    if (graphic.style.strokeDasharray) attributes.LineType = "Dashed";
    else delete attributes.LineType;
  }
  if (Boolean(graphic.data.pathClosed) !== cdxmlCurveIsClosed(attributes)) {
    attributes.Closed = graphic.data.pathClosed ? "yes" : "no";
  }
  if (graphic.rotation || graphic.style.tiltXDegrees || graphic.style.tiltYDegrees) {
    warnings.push({ code: "cdxml.curve_transform_payload_only",
      message: "Curve rotation and tilt remain only in the native payload; standard CDXML retains the untransformed Bezier points.", sourceObjectId: graphic.id });
  }
  attributes.id = graphicId;
  return curveXml(attributes);
}

function preservedCurveAttributes(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([name, attribute]) =>
    /^[a-z_][\w.:-]*$/i.test(name) && typeof attribute === "string")) as Record<string, string>;
}

function curveXml(attributes: Record<string, string>): string {
  return `<curve ${Object.entries(attributes).map(([name, value]) => `${name}="${escapeXmlAttribute(value)}"`).join(" ")}/>`;
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

/** The per-end CDXML heads describe full/half heads; Solid/Hollow/Angle is one shared type.
 *  Decorative heads have no spelling, and mixed solid/open ends cannot share that type. */
function warnForUnrepresentableArrowheads(
  graphic: GraphicObject,
  warnings: CompatibilityConversionWarning[]
): void {
  const head = cdxmlArrowheadForMarker(graphic.data.markerEnd);
  const tail = cdxmlArrowheadForMarker(graphic.data.markerStart);
  if (head && tail && head.type !== tail.type) {
    warnings.push({
      code: "cdxml.arrow_marker_payload_only",
      message: `Native start (tail) ${graphic.data.markerStart!.kind} style cannot be combined with the end (head) ${graphic.data.markerEnd!.kind} style in standard CDXML: ArrowheadType applies to both ends. The exported tail uses the head's ${head.type} type; its original style is preserved exactly only in the embedded ChemDraft payload.`,
      sourceObjectId: graphic.id
    });
  }
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
  const root = tree.map(elementView).find(element => element?.name.toLowerCase() === "cdxml");
  const curveLineDefaults = cdxmlCurveLineDefaults(root?.attributes ?? {});
  const base = createEmptyDocument({ title: "Imported CDXML.chemdraft", now: nativeImportTimestamp });
  let importedPages: DocumentPage[];
  try {
    importedPages = pageElements.map((pageElement, pageIndex) => {
      const pageTemplate = base.pages[0];
      const importedPage = applyImportTransformToPageObjects(
        importPageObjects(pageElement, pageIndex, warnings, colorTable, curveLineDefaults),
        importTransform
      );
      return {
        ...pageTemplate,
        id: `page_${String(pageIndex + 1).padStart(3, "0")}`,
        objects: importedPage.objects,
        crossings: importedPage.crossings
      };
    });
  } catch (error) {
    return {
      warnings: [warning("cdxml.values_out_of_range", `CDXML import failed: ${errorMessage(error)}`)]
    };
  }
  const objectCount = importedPages.reduce((count, page) => count + page.objects.length, 0);
  if (objectCount === 0) {
    return {
      warnings: [warning("cdxml.no_supported_visible_objects", "No supported visible CDXML objects were found."), ...warnings]
    };
  }

  // The schema is the last line of defence against values no drawing can hold — coordinates near
  // 1e308 overflow to Infinity once a width is taken — and a rejection there must reach the user as
  // a refusal naming the problem, not as an exception dumping the validator's JSON.
  const parsed = ChemDraftDocumentSchema.safeParse({
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
  });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` (at ${issue.path.join(".")})` : "";
    return {
      warnings: [
        warning(
          "cdxml.values_out_of_range",
          `This CDXML file has values ChemDraft cannot represent${where}: ${issue?.message ?? "invalid document"}. Coordinates this large are usually a sign of a damaged file.`
        )
      ]
    };
  }
  return { document: withBracketChemistryWarnings(parsed.data), warnings };
}

function importPageObjects(
  pageElement: XmlElementView,
  pageIndex: number,
  warnings: CompatibilityConversionWarning[],
  colorTable: CdxmlColorTable,
  curveLineDefaults: Record<string, string>
): { objects: DocumentObject[]; crossings: CrossingOverride[] } {
  const objects: DocumentObject[] = [];
  const bracketGroups: XmlElementView[] = [];
  const context: ImportPageContext = {
    warnings,
    bondRefsByCdxmlId: new Map(),
    zByRefKey: new Map(),
    displayByRefKey: new Map(),
    crossingHints: [],
    colorTable,
    curveLineDefaults: { ...curveLineDefaults, ...cdxmlCurveLineDefaults(pageElement.attributes) },
    preserveReactionIds: findElements(pageElement.children, "scheme").length > 0
  };
  const schemes: XmlElementView[] = [];
  const rootsBySourceId = new Map<string, string[]>();
  context.preserveReactionIds ||= findElements(pageElement.children, "bracketedgroup").length > 0;
  const stepReferencedIds = new Set(findElements(pageElement.children, "step").flatMap(step =>
    reactionListAttributes.flatMap(attribute => splitCdxmlIdList(step.attributes[attribute]))));
  let objectIndex = 1;

  // One CDXML element → every object it produced (in drawing order) and the ids that stand for it at
  // its parent's level. A `<group>` is a container, not an object: its children are imported like
  // page children and tied together by a native group. Importing the whole group as one opaque
  // unknown object dropped every molecule inside it — real ChemDraw files group routinely.
  const importElement = (element: XmlElementView): { objects: DocumentObject[]; rootIds: string[] } => {
    const single = (object: DocumentObject | undefined) => {
      if (!object) {
        return { objects: [], rootIds: [] };
      }
      objectIndex += 1;
      if (element.attributes.id) rootsBySourceId.set(element.attributes.id, [object.id]);
      return { objects: [object], rootIds: [object.id] };
    };
    if (element.name === "fragment") {
      return single(importFragment(element, pageIndex, objectIndex, warnings, context));
    }
    if (element.name === "t") {
      return single(importText(element, pageIndex, objectIndex));
    }
    if (element.name === "graphic") {
      return single(importGraphic(element, pageIndex, objectIndex, context));
    }
    if (element.name === "bracketedgroup") {
      bracketGroups.push(element);
      return { objects: [], rootIds: [] };
    }
    if (element.name === "arrow") {
      return single(importArrowGraphic(element, pageIndex, objectIndex, context));
    }
    if (element.name === "curve") {
      return single(importCurveGraphic(element, pageIndex, objectIndex, context));
    }
    if (element.name === "group") {
      const imported = importGroup(element);
      if (element.attributes.id) rootsBySourceId.set(element.attributes.id, imported.rootIds);
      return imported;
    }
    if (element.name === "scheme") {
      if (childElements(element, "step").length === 0) {
        warnings.push({ code: "cdxml.reaction_scheme_without_steps_preserved",
          message: `CDXML scheme${element.attributes.id ? ` ${element.attributes.id}` : ""} has no steps; preserved as an unknown compatibility object.` });
        return single(importUnknownCompatibilityObject(element, pageIndex, objectIndex));
      }
      schemes.push(element);
      return { objects: [], rootIds: [] };
    }
    if (element.name === "objecttag") {
      return { objects: [], rootIds: [] };
    }
    warnings.push({
      code: "cdxml.object_import_unsupported",
      message: `Imported unsupported CDXML object "${element.name}" as an unknown compatibility object.`
    });
    return single(importUnknownCompatibilityObject(element, pageIndex, objectIndex));
  };

  const importGroup = (groupElement: XmlElementView): { objects: DocumentObject[]; rootIds: string[] } => {
    const members: DocumentObject[] = [];
    const memberRootIds: string[] = [];
    for (const child of groupElement.children) {
      const element = elementView(child);
      if (!element || isChemDraftObjectTag(element)) {
        continue;
      }
      const imported = importElement(element);
      members.push(...imported.objects);
      memberRootIds.push(...imported.rootIds);
    }
    // A native group needs two members to mean anything (the app's own Group command requires two);
    // with fewer, the lone member simply stands on the page — said, not done silently (§11).
    const rootIdSet = new Set(memberRootIds);
    // A singleton referenced by a step must retain its id as a real container on export.
    const keepSingleton = stepReferencedIds.has(groupElement.attributes.id);
    const bounds = memberRootIds.length >= (keepSingleton ? 1 : 2) ? unionObjectBounds(members.filter((object) => rootIdSet.has(object.id))) : undefined;
    if (!bounds) {
      if (memberRootIds.length > 0) {
        warnings.push({
          code: "cdxml.group_not_preserved",
          message: `CDXML group${groupElement.attributes.id ? ` ${groupElement.attributes.id}` : ""} has fewer than two placeable members; its contents were imported ungrouped.`
        });
      }
      return { objects: members, rootIds: memberRootIds };
    }
    // The group's own attributes (Z order, bounding box, visibility, vendor data) have no native
    // field; kept on the group rather than discarded.
    const { id: _originalId, ...groupAttributes } = groupElement.attributes;
    const group: GroupObject = {
      id: `cdxml_group_${pageIndex + 1}_${objectIndex}`,
      type: "group",
      ...bounds,
      rotation: 0,
      style: {},
      childObjectIds: memberRootIds,
      compatibility: {
        sourceFormat: "cdxml",
        originalId: groupElement.attributes.id,
        warnings: [],
        unknown: Object.keys(groupAttributes).length > 0 ? { attributes: groupAttributes } : {}
      }
    };
    objectIndex += 1;
    return { objects: [...members, group], rootIds: [group.id] };
  };

  for (const child of pageElement.children) {
    const element = elementView(child);
    if (!element || isChemDraftObjectTag(element)) {
      continue;
    }
    objects.push(...importElement(element).objects);
  }
  const objectsById = new Map(objects.map(object => [object.id, object]));
  schemes.forEach((scheme, schemeIndex) => {
    childElements(scheme, "step").forEach((step, stepIndex) => {
      const reaction = importReactionStep(scheme, step, pageIndex, schemeIndex, stepIndex, rootsBySourceId, objectsById, warnings);
      objects.push(reaction);
    });
  });
  for (const group of bracketGroups) {
    const attachments = childElements(group, "bracketattachment");
    const pair = attachments.map(attachment => objects.find((object): object is BracketObject =>
      object.type === "bracket" && object.compatibility?.originalId === attachment.attributes.GraphicID));
    if (pair.length !== 2 || pair.some(object => !object) || pair[0] === pair[1]) {
      const data = [group.attributes.BracketedObjectIDs ? "atom or object membership" : undefined,
        attachments.some(attachment => childElements(attachment, "crossingbond").length > 0) ? "crossing-bond attachments" : undefined,
        group.attributes.BracketUsage && group.attributes.BracketUsage !== "SRU" ? `bracket usage "${group.attributes.BracketUsage}"` : undefined].filter(Boolean);
      warnings.push({ code: "cdxml.bracket_group_preserved", message: `CDXML import: bracket group ${group.attributes.id ?? "(unknown)"} has unsupported attachment count or bracket references${data.length ? `; the following data is not interpreted: ${data.join(" and ")}` : ""}; the group is preserved as an unknown compatibility object.` });
      const remaining = [...new Set(pair.filter((object): object is BracketObject => object !== undefined))];
      const memberIds = splitCdxmlIdList(group.attributes.BracketedObjectIDs);
      const members = objects.filter(object => memberIds.includes(object.compatibility?.originalId ?? "") ||
        object.type === "molecule" && Object.values(preservedCurveAttributes(object.compatibility?.unknown.cdxmlAtomIdsByAtomId)).some(id => memberIds.includes(id)));
      if (remaining.length === 1 && members.length) {
        const centre = (Math.min(...members.map(object => object.x)) + Math.max(...members.map(object => object.x + object.width))) / 2;
        const bracket = remaining[0];
        bracket.side = bracket.x + bracket.width / 2 <= centre ? "open" : "close";
        bracket.compatibility!.unknown.cdxmlBracketGeometry = bracketGeometryKey(bracket);
      }
      if (remaining.length === 1 && group.attributes.BracketUsage === "SRU") {
        const bracket = remaining[0];
        warnings.push({ code: "document.bracket_partner_missing", sourceObjectId: bracket.id,
          message: `Bracket ${bracket.compatibility?.originalId ?? bracket.id} had no partner; repeat-unit mark removed.` });
      }
      objects.push(importUnknownCompatibilityObject(group, pageIndex, objectIndex++));
      continue;
    }
    const brackets = pair as BracketObject[];
    const compareGeometry = (a: BracketObject, b: BracketObject) =>
      (a.x + a.width / 2) - (b.x + b.width / 2) || (a.y + a.height / 2) - (b.y + b.height / 2) ||
      a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height;
    if (compareGeometry(brackets[0], brackets[1]) === 0) {
      warnings.push({ code: "cdxml.bracket_sides_ambiguous",
        message: `Bracket group ${group.attributes.id ?? "(unknown)"} has indistinguishable glyph geometry; imported sides are retained and the group, including its label, remains compatibility data.` });
      objects.push(importUnknownCompatibilityObject(group, pageIndex, objectIndex++));
      continue;
    }
    brackets.sort(compareGeometry);
    brackets[0].side = "open";
    brackets[1].side = "close";
    const usageName = group.attributes.BracketUsage ?? brackets.map(bracket => bracket.compatibility?.unknown.cdxmlBracket)
      .flatMap(raw => isRecord(raw) ? [preservedCurveAttributes(raw.attributes).BracketUsage] : []).find(Boolean);
    let bracketUsage: BracketObject["bracketUsage"] = usageName === "SRU" ? "sru" : usageName === "MultipleGroup" ? "multiple" : usageName === undefined ? "generic" : "unknown";
    if (bracketUsage === "unknown") warnings.push({ code: "cdxml.bracket_usage_unknown",
      message: `CDXML bracket group ${group.attributes.id ?? "(unknown)"} has unknown BracketUsage "${usageName}"; no multiplier is interpreted.` });
    const additional = Object.keys(group.attributes).filter(key => !["id", "BracketUsage", "BracketedObjectIDs", "SRULabel", "RepeatCount"].includes(key));
    if (additional.length || group.children.some(child => { const element = elementView(child); return element && element.name !== "bracketattachment"; })) {
      warnings.push({ code: "cdxml.bracket_data_preserved",
        message: `Bracket group ${group.attributes.id} has additional ${additional.join(", ") || "child"} data; it is preserved for export but is not interpreted as polymer chemistry.` });
    }
    const countText = group.attributes.RepeatCount;
    const count = Number(countText);
    const repeatCount = countText !== undefined && /^\d+$/.test(countText.trim()) && Number.isSafeInteger(count) && count > 0 ? count : undefined;
    const invalidRepeatCount = countText !== undefined && repeatCount === undefined;
    if (invalidRepeatCount) {
      bracketUsage = "unknown";
      warnings.push({ code: "cdxml.bracket_repeat_count_preserved",
        message: `Bracket group ${group.attributes.id} RepeatCount "${countText}" is not a safe positive integer; no multiplier is interpreted and the original text is preserved as compatibility data.` });
    }
    const containedIds = splitCdxmlIdList(group.attributes.BracketedObjectIDs);
    const containedObjects = containedIds.map(id => objects.find(object => object.type === "molecule" && object.compatibility?.originalId === id));
    const memberRecords = containedIds.map(sourceId => {
      const molecule = objects.find(object => object.compatibility?.originalId === sourceId) ??
        objects.find(object => object.type === "molecule" && Object.values(preservedCurveAttributes(object.compatibility?.unknown.cdxmlAtomIdsByAtomId)).includes(sourceId));
      const atomId = molecule?.type === "molecule" ? Object.entries(preservedCurveAttributes(molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId)).find(([, id]) => id === sourceId)?.[0] : undefined;
      return { sourceId, ...(molecule ? { objectId: molecule.id } : {}), ...(atomId ? { atomId } : {}) };
    });
    const atomMemberObjects = [...new Set(memberRecords.flatMap(record => record.atomId && record.objectId ? [record.objectId] : []))];
    if (containedObjects.some(object => !object)) warnings.push({ code: "cdxml.bracket_atom_membership_preserved",
      message: `CDXML bracket group ${group.attributes.id} has atom-level or unresolved BracketedObjectIDs; source membership is preserved in compatibility data, not asserted as whole-molecule membership.` });
    const pairId = `cdxml_bracket_pair_${pageIndex + 1}_${objectIndex++}`;
    for (const bracket of brackets) {
      bracket.pairId = pairId;
      bracket.bracketUsage = bracketUsage;
      bracket.containedObjectIds = containedObjects.flatMap(object => object ? [object.id] : []);
      if (bracketUsage === "sru") {
        bracket.repeatUnit = true;
        if (bracket.side === "close") bracket.label = group.attributes.SRULabel ?? "";
      }
      if (repeatCount !== undefined) bracket.repeatCount = repeatCount;
      const attachment = attachments.find(attachment => attachment.attributes.GraphicID === bracket.compatibility?.originalId)!;
      const records = childElements(attachment, "crossingbond").map(crossing => {
        const ref = context.bondRefsByCdxmlId.get(crossing.attributes.BondID);
        const molecule = ref && objects.find(object => object.id === ref.objectId);
        const bond = molecule?.type === "molecule" ? molecule.bonds.find(bond => bond.id === ref!.bondId) : undefined;
        if (!ref) warnings.push({ code: "cdxml.bracket_crossing_unresolved", sourceObjectId: bracket.id,
          message: `Bracket crossing BondID "${crossing.attributes.BondID}" is unresolved and remains compatibility data.` });
        const innerAtomId = molecule?.type === "molecule" ? Object.entries(preservedCurveAttributes(molecule.compatibility?.unknown.cdxmlAtomIdsByAtomId))
          .find(([, sourceId]) => sourceId === crossing.attributes.InnerAtomID)?.[0] : undefined;
        return { attributes: crossing.attributes, children: crossing.children, ...(ref ? { ref } : {}),
          ...(innerAtomId ? { innerAtomId } : {}), ...(bond ? { bondIdentity: JSON.stringify([bond.fromAtomId, bond.toAtomId]) } : {}) };
      });
      if (records.length) bracket.crossingBondIds = records.flatMap(record => record.ref ? [record.ref] : []);
      Object.assign(bracket.compatibility!.unknown, { bracketedGroup: group, cdxmlBracketAttachment: attachment,
        cdxmlBracketCrossings: records, cdxmlBracketGeometry: bracketGeometryKey(bracket), cdxmlBracketState: bracketSourceState(bracket),
        cdxmlBracketMembership: JSON.stringify(bracket.containedObjectIds), cdxmlBracketMemberObjectIds: atomMemberObjects, cdxmlBracketMembers: memberRecords,
        ...(invalidRepeatCount ? { cdxmlBracketInvalidRepeatCount: countText } : {}) });
    }
    if (bracketUsage === "sru" && group.attributes.SRULabel === undefined) warnings.push({ code: "cdxml.repeat_label_unassociated",
      message: `CDXML import: repeat-unit label association for bracket group ${group.attributes.id ?? "(unknown)"} is not interpreted; separate label text is retained independently.` });
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
  // Codec v1 was MIXED, not uniformly y-first. `formatPoint` wrote atom and text `p` y-first, but
  // `formatXyPoint` (Head3D/Tail3D/Center3D/MajorAxisEnd3D) and `formatXyBoundingBox` (graphic and
  // arrow BoundingBox) wrote x-first — already spec order. `importShapeGraphic` tags everything it
  // builds with `cdxmlCoordinateSpace: "xy"`, so that tag is the record of which half a v1 object
  // came from, and transposing a tagged object stands a horizontal arrow on its end and turns a
  // wide rectangle into a tall one somewhere else entirely.
  if (object.compatibility?.unknown.cdxmlCoordinateSpace === "xy") {
    return object;
  }

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

/**
 * ChemDraw stores an abbreviation — SO3, Ph, Boc — as a node that CARRIES its own little molecule:
 * a nested `<fragment>` holding the real atoms plus one `ExternalConnectionPoint`, a pseudo-atom
 * marking where the abbreviation attaches to the rest of the drawing. The label ("SO3") is only
 * the text drawn in its place.
 *
 * Read as an ordinary node, such a node has no `Element` attribute, and the import used to fall
 * through to carbon: the sulfonate in a real NSF figure opened as a plain CH2, sulfur, oxygens and
 * charge silently gone. Expanding the nested fragment instead brings the actual atoms in, and the
 * bonds that reached the abbreviation are re-pointed at the atom the connection point marks.
 *
 * When an abbreviation cannot be expanded — no atoms inside, or more than one attachment point,
 * where guessing which outer bond goes where would invent chemistry — the node is kept with its
 * label as a literal one ("SO3" reads as SO3, no implicit hydrogens) and a warning names it. A
 * label a chemist can see and correct beats a carbon nobody notices.
 */
interface ExpandedCdxmlNodes {
  atomElements: XmlElementView[];
  bondElements: XmlElementView[];
  /** Abbreviation node id -> the nested atom id its outer bonds should attach to. */
  attachmentByCdxmlId: Map<string, string>;
  /** Abbreviation node id -> the label to keep when the nested fragment could not be expanded. */
  literalLabelByCdxmlId: Map<string, string>;
}

function expandCdxmlAbbreviationNodes(
  atomElements: readonly XmlElementView[],
  bondElements: readonly XmlElementView[],
  warnings: CompatibilityConversionWarning[],
  depth = 0
): ExpandedCdxmlNodes {
  const expandedAtoms: XmlElementView[] = [];
  const expandedBonds: XmlElementView[] = [...bondElements];
  const attachmentByCdxmlId = new Map<string, string>();
  const literalLabelByCdxmlId = new Map<string, string>();

  for (const atomElement of atomElements) {
    const nested = childElements(atomElement, "fragment")[0];
    const nodeId = atomElement.attributes.id ?? "";
    if (!nested) {
      expandedAtoms.push(atomElement);
      // A standard nickname/formula node need not carry an expansion. Its text belongs to this
      // atom, not to another carbon or a standalone text object. Never infer an element from the
      // absent Element attribute (whose default would otherwise be carbon).
      if (["Nickname", "Fragment", "Formula", "GenericNickname", "Monomer", "4", "5", "6", "7", "14"].includes(atomElement.attributes.NodeType)) {
        const label = cdxmlAtomLabelText(atomElement);
        literalLabelByCdxmlId.set(nodeId, label ?? "*");
        warnings.push({
          code: "cdxml.abbreviation_not_expanded",
          message: label
            ? `Kept the abbreviation "${label}" as a literal label with its bonds: it carries no expanded atom graph.`
            : `Kept abbreviation node ${nodeId} as an unknown atom (*): it carries neither label text nor an expanded atom graph.`
        });
      }
      continue;
    }

    const label = cdxmlAtomLabelText(atomElement);
    const nestedAtoms = childElements(nested, "n");
    const nestedBonds = childElements(nested, "b");
    const connectionPointIds = new Set(nestedAtoms
      .filter((nestedAtom) => nestedAtom.attributes.NodeType === "ExternalConnectionPoint")
      .map((nestedAtom) => nestedAtom.attributes.id ?? ""));
    const bodyAtoms = nestedAtoms.filter((nestedAtom) =>
      nestedAtom.attributes.NodeType !== "ExternalConnectionPoint");
    const touchesConnectionPoint = (bondElement: XmlElementView) =>
      connectionPointIds.has(bondElement.attributes.B ?? "") ||
      connectionPointIds.has(bondElement.attributes.E ?? "");
    const attachment = nestedBonds
      .filter(touchesConnectionPoint)
      .map((bondElement) => connectionPointIds.has(bondElement.attributes.B ?? "")
        ? bondElement.attributes.E
        : bondElement.attributes.B)
      .find((id): id is string => id !== undefined);

    const outerBondCount = bondElements.filter((bondElement) =>
      bondElement.attributes.B === nodeId || bondElement.attributes.E === nodeId).length;
    const charge = parseInteger(atomElement.attributes.Charge) ?? 0;
    let notExpandableReason: string | undefined;
    if (depth > 4) {
      notExpandableReason = "its nesting exceeds the supported abbreviation depth.";
    } else if (charge !== 0) {
      notExpandableReason = `its charge ${charge} cannot be assigned to a nested atom without guessing.`;
    } else if (bodyAtoms.length === 0) {
      notExpandableReason = "it carries no atoms to expand.";
    } else if (connectionPointIds.size > 1) {
      notExpandableReason = `it attaches at ${connectionPointIds.size} points, and which bond meets which atom cannot be read from the file.`;
    } else if (attachment !== undefined && !bodyAtoms.some((atom) => atom.attributes.id === attachment)) {
      notExpandableReason = "its attachment bond does not reach a body atom.";
    } else if (outerBondCount > 0 && attachment === undefined) {
      notExpandableReason = "it has no attachment bond connecting its body to the outer drawing.";
    }
    if (notExpandableReason) {
      // An Element naming nothing is warned about where the atom is imported, not here.
      const element = elementFromCdxmlAtom(atomElement.attributes.Element) ?? "*";
      const keptAs = label ? "a label" : element === "C" ? "a carbon atom" : `an atom (${element})`;
      warnings.push({
        code: "cdxml.abbreviation_not_expanded",
        message: `Kept the abbreviation ${label ? `"${label}"` : `node ${nodeId}`} as ${keptAs}: ${notExpandableReason}`
      });
      expandedAtoms.push(atomElement);
      if (label) {
        literalLabelByCdxmlId.set(nodeId, label);
      }
      continue;
    }

    // The nested fragment may itself hold an abbreviation.
    const inner = expandCdxmlAbbreviationNodes(
      bodyAtoms,
      nestedBonds.filter((bondElement) => !touchesConnectionPoint(bondElement)),
      warnings,
      depth + 1
    );
    expandedAtoms.push(...inner.atomElements);
    expandedBonds.push(...inner.bondElements);
    inner.attachmentByCdxmlId.forEach((value, key) => attachmentByCdxmlId.set(key, value));
    inner.literalLabelByCdxmlId.forEach((value, key) => literalLabelByCdxmlId.set(key, value));
    if (attachment !== undefined) {
      attachmentByCdxmlId.set(nodeId, inner.attachmentByCdxmlId.get(attachment) ?? attachment);
    }
  }

  return {
    atomElements: expandedAtoms,
    bondElements: expandedBonds,
    attachmentByCdxmlId,
    literalLabelByCdxmlId
  };
}

/** The text ChemDraw draws in place of a node: "SO3", "OH", "Ph". */
function cdxmlAtomLabelText(atomElement: XmlElementView): string | undefined {
  const labelElement = childElements(atomElement, "t")[0];
  const text = labelElement ? textContent(labelElement.children).trim() : "";
  return text || atomElement.attributes.GenericNickname?.trim() || undefined;
}

function importFragment(
  fragment: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  warnings: CompatibilityConversionWarning[],
  context: ImportPageContext
): MoleculeObject | undefined {
  const expansion = expandCdxmlAbbreviationNodes(
    childElements(fragment, "n"),
    childElements(fragment, "b"),
    warnings
  );
  const atomElements = expansion.atomElements;
  const bondElements = expansion.bondElements;
  const unsupportedRadical = atomElements.find((atom) => atom.attributes.Radical !== undefined && !["None", "0", "Doublet", "2", "Triplet", "3"].includes(atom.attributes.Radical));
  if (unsupportedRadical) {
    warnings.push({ code: "cdxml.atom_radical_unsupported", message: `CDXML import failed: Radical="${unsupportedRadical.attributes.Radical}" on atom ${unsupportedRadical.attributes.id ?? "<unnamed>"} cannot be represented without changing its electron state; fragment skipped.` });
    return undefined;
  }
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
  const statedHydrogensByAtomId = new Map<string, number>();
  const atoms: MoleculeAtom[] = atomElements.map((atomElement, atomIndex) => {
    const atomId = `atom_${String(atomIndex + 1).padStart(3, "0")}`;
    const cdxmlId = atomElement.attributes.id ?? atomId;
    atomIdByCdxmlId.set(cdxmlId, atomId);
    const statedHydrogens = parseInteger(atomElement.attributes.NumHydrogens);
    if (statedHydrogens !== undefined && statedHydrogens >= 0) {
      statedHydrogensByAtomId.set(atomId, statedHydrogens);
    }
    const point = parseCdxmlPoint(atomElement.attributes.p);
    const labelPoint = cdxmlAtomLabelPoint(atomElement);
    const literalLabel = expansion.literalLabelByCdxmlId.get(cdxmlId);
    let element = elementFromCdxmlAtom(atomElement.attributes.Element);
    if (element === undefined) {
      // Kept as an unknown atom with its bonds, never carbon: the file names no element here, and
      // a guess would change the chemistry without a trace (AGENTS.md §7). A kept abbreviation
      // label stands in for the element, so only a bare atom is reported.
      element = "*";
      if (literalLabel === undefined) {
        warnings.push({
          code: "cdxml.atom_element_unknown",
          message: `CDXML atom ${cdxmlId} has Element="${atomElement.attributes.Element}", which names no element; imported as an unknown atom (*).`,
          sourceObjectId: objectId,
          atomIds: [atomId]
        });
      }
    }
    const stereoAssignment = cdxmlAtomStereoAssignment(atomElement.attributes.AS);
    if (stereoAssignment) {
      const geometry = atomElement.attributes.Geometry?.trim();
      cdxmlAtomStereochemistryByAtomId[atomId] = {
        assignment: stereoAssignment,
        cdxmlAtomId: cdxmlId,
        ...(geometry ? { geometry } : {})
      };
    }
    // A label written as text in Element ("Ar", "Ts" — how a bonded aryl or tosyl label is exported)
    // is a typed label, so it keeps the group meaning a bonded one carries. A numeric Element is an
    // element of the structure and stays one: Element="89" bonded to Cl is actinium, never acetyl.
    const rawElement = atomElement.attributes.Element?.trim();
    const textLabel = rawElement !== undefined && rawElement.length > 0 && !Number.isInteger(Number(rawElement)) &&
      bondedElementLabelMeaning(element) !== undefined;
    return normalizeAtomIsotope({
      id: atomId,
      element: literalLabel ?? element,
      ...(atomElement.attributes.Isotope === undefined ? {}
        : { isotope: Number(atomElement.attributes.Isotope) }),
      x: point.x,
      y: point.y,
      formalCharge: parseInteger(atomElement.attributes.Charge) ?? 0,
      ...(["Doublet", "2"].includes(atomElement.attributes.Radical) ? { markRadicals: 1 }
        : ["Triplet", "3"].includes(atomElement.attributes.Radical) ? { markRadicals: 2 } : {}),
      // An abbreviation that could not be expanded keeps its drawn text and means exactly that:
      // no implicit hydrogens are invented for a label like "SO3".
      ...(literalLabel || textLabel ? { labelLiteral: true } : {}),
      ...(labelPoint ? { labelOffset: { x: labelPoint.x - point.x, y: labelPoint.y - point.y } } : {})
    });
  });
  // A bond drawn to an abbreviation now lands on the atom its connection point marked — the sulfur
  // of an expanded SO3, not the vanished node.
  expansion.attachmentByCdxmlId.forEach((attachmentCdxmlId, abbreviationCdxmlId) => {
    const atomId = atomIdByCdxmlId.get(attachmentCdxmlId);
    if (atomId) {
      atomIdByCdxmlId.set(abbreviationCdxmlId, atomId);
    }
  });
  const atomByCdxmlId = new Map<string, MoleculeAtom>(
    atomElements.map((atomElement, atomIndex) => [atomElement.attributes.id ?? atoms[atomIndex].id, atoms[atomIndex]])
  );
  const cdxmlIdByBondId = new Map<string, string>();
  const cdxmlUnknownBondOrdersByBondId: Record<string, string> = {};
  const dashedSingleBondIds: string[] = [];
  const bonds: MoleculeBond[] = bondElements.map((bondElement, bondIndex) => {
    const bondId = `bond_${String(bondIndex + 1).padStart(3, "0")}`;
    const order = moleculeBondOrderFromCdxml(bondElement.attributes.Order, warnings, objectId, bondId);
    if (order === "unknown" && bondElement.attributes.Order !== undefined) {
      cdxmlUnknownBondOrdersByBondId[bondId] = bondElement.attributes.Order;
    }
    const bond: MoleculeBond = {
      id: bondId,
      fromAtomId: atomIdByCdxmlId.get(bondElement.attributes.B ?? "") ?? bondElement.attributes.B ?? "",
      toAtomId: atomIdByCdxmlId.get(bondElement.attributes.E ?? "") ?? bondElement.attributes.E ?? "",
      order
    };
    const cdxmlBondId = bondElement.attributes.id ?? bondId;
    const ref = { objectId, bondId };
    context.bondRefsByCdxmlId.set(cdxmlBondId, ref);
    cdxmlIdByBondId.set(bondId, cdxmlBondId);
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
    const dative = isCdxmlDativeOrder(bondElement.attributes.Order);
    const bondDisplay = cdxmlBondDisplay(bondElement.attributes.Display, bondElement.attributes.Order);
    if (dative) {
      // A dative bond is drawn dashed (`isDativeBond`), whatever Display said. A wedge, hash or bold
      // display cannot also be kept, and must not swap the endpoints either: CDXML writes a dative
      // bond donor (B) to acceptor (E).
      if (bondDisplay && bondDisplay.bondStyle !== "dashed") {
        warnings.push({
          code: "cdxml.bond_display_unsupported",
          message: `CDXML dative bond display "${bondElement.attributes.Display}" was replaced by the dashed style ChemDraft draws dative bonds with.`,
          sourceObjectId: objectId,
          bondIds: [bondId]
        });
      }
      bond.display = { ...(bond.display ?? {}), bondStyle: "dashed" };
    } else if (order === "double" && bondElement.attributes.Display === "Wavy") {
      // Explicit unknown E/Z must take precedence over stereo inferred from the 2D geometry.
      // DoublePosition controls line placement, not this stereochemical intent.
      bond.stereo = "either";
    } else if (bondDisplay) {
      if (bondDisplay.bondStyle === "dashed" && order === "single") {
        dashedSingleBondIds.push(bondId);
      }
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
        sourceObjectId: objectId,
        bondIds: [bondId]
      });
    }
    if (order === "double") {
      // Do not guess that a secondary display or a CIP annotation means the crossed convention.
      // These attributes are not mapped; name them rather than silently discarding the hint.
      for (const attribute of ["Display2", "BS"] as const) {
        const value = bondElement.attributes[attribute];
        if (value) {
          warnings.push({
            code: "cdxml.bond_stereo_attribute_unsupported",
            message: `CDXML double bond ${cdxmlBondId} attribute ${attribute}="${value}" is not mapped to native stereo. Display="Wavy" marks E/Z-unspecified bonds; otherwise E/Z may be derived from coordinates.`,
            sourceObjectId: objectId,
            bondIds: [bondId]
          });
        }
      }
    }
    return bond;
  });
  const dashedSingleBondCount = dashedSingleBondIds.length;
  if (dashedSingleBondCount > 0) {
    // ChemDraw draws hydrogen and partial (forming/breaking) bonds as dashed singles too; ChemDraft
    // has one dashed single bond, the coordination bond, and every writer treats it as one (V3000
    // bond type 9, CDXML Order="dative"). Said at the door rather than discovered in an export.
    warnings.push({
      code: "cdxml.dashed_single_read_as_dative",
      message: `${dashedSingleBondCount} dashed single bond${dashedSingleBondCount === 1 ? " was" : "s were"} read as dative (coordination) bond${dashedSingleBondCount === 1 ? "" : "s"}, the only dashed single bond ChemDraft has; a hydrogen or partial bond drawn this way is exported as dative.`,
      sourceObjectId: objectId,
      bondIds: dashedSingleBondIds
    });
  }
  // A bond must join two different atoms of this fragment. One naming a missing atom used to keep
  // the raw CDXML id as its endpoint — a bond to nothing that every later consumer (renderer, SMILES,
  // valence) had to survive — and one from an atom to itself is no bond at all.
  const importedAtomIds = new Set(atoms.map((atom) => atom.id));
  const joinedBonds = bonds.filter(
    (bond) => importedAtomIds.has(bond.fromAtomId) && importedAtomIds.has(bond.toAtomId) && bond.fromAtomId !== bond.toAtomId
  );
  if (joinedBonds.length !== bonds.length) {
    // Crossing hints resolve CDXML bond ids through this map; a skipped bond must not stay reachable.
    // Only this fragment's skipped bonds, by the ids recorded while mapping: scanning the whole map
    // per fragment made a damaged file with thousands of such fragments quadratic to open.
    const keptBondIds = new Set(joinedBonds.map((bond) => bond.id));
    for (const bond of bonds) {
      const cdxmlBondId = cdxmlIdByBondId.get(bond.id);
      if (!keptBondIds.has(bond.id) && cdxmlBondId !== undefined && context.bondRefsByCdxmlId.get(cdxmlBondId)?.bondId === bond.id) {
        context.bondRefsByCdxmlId.delete(cdxmlBondId);
      }
    }
    // A warning names only bonds the molecule keeps: a skipped bond was never imported, so a warning
    // about it alone is about the molecule.
    for (const item of warnings) {
      if (item.sourceObjectId === objectId && item.bondIds) {
        const keptIds = item.bondIds.filter((bondId) => keptBondIds.has(bondId));
        if (keptIds.length > 0) {
          item.bondIds = keptIds;
        } else {
          delete item.bondIds;
        }
      }
    }
    warnings.push({
      code: "cdxml.bond_endpoints_invalid",
      message: `Skipped ${bonds.length - joinedBonds.length} CDXML bond${bonds.length - joinedBonds.length === 1 ? "" : "s"} that did not join two different atoms of the fragment.`,
      sourceObjectId: objectId
    });
  }
  const normalizedBonds = refreshImportedCyclicDoubleBondSides(atoms, joinedBonds);
  // Order=1.5 bonds cannot say whether a ring N is pyridine-type or an N–H; the file's NumHydrogens
  // can, so it is kept on exactly those atoms for the Kekulé resolution to honour.
  const aromaticAtomIds = new Set(normalizedBonds.flatMap((bond) =>
    bond.order === "aromatic" ? [bond.fromAtomId, bond.toAtomId] : []));
  for (const atom of atoms) {
    const stated = statedHydrogensByAtomId.get(atom.id);
    if (stated !== undefined && aromaticAtomIds.has(atom.id)) {
      atom.hydrogenCount = stated;
    }
  }
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
      unknown: {
        ...(context.preserveReactionIds ? {
          cdxmlAtomIdsByAtomId: Object.fromEntries([...atomIdByCdxmlId].map(([sourceId, atomId]) => [atomId, sourceId])),
          cdxmlBondIdsByBondId: Object.fromEntries(cdxmlIdByBondId)
        } : {}),
        ...(Object.keys(cdxmlAtomStereochemistryByAtomId).length > 0 ? { cdxmlAtomStereochemistryByAtomId } : {}),
        ...(Object.keys(cdxmlUnknownBondOrdersByBondId).length > 0 ? { cdxmlUnknownBondOrdersByBondId } : {})
      }
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
    // An explicit centered position is a display choice, not a ring-interior hint.
    if (currentSide === "center") {
      return bond;
    }
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
  if (normalized === "center") {
    return "center";
  }
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

function cdxmlDoublePositionName(side: DoubleBondSide): "Left" | "Right" | "Center" {
  if (side === "center") {
    return "Center";
  }
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
): GraphicObject | ArrowObject | BracketObject | UnknownCompatibilityObject | undefined {
  if (element.attributes.SupersededBy) {
    return undefined;
  }

  const box = parseBoundingBox(element.attributes.BoundingBox);
  if (element.attributes.GraphicType === "Bracket" && !["Square", "Round"].includes(element.attributes.BracketType)) {
    context.warnings.push({ code: "cdxml.bracket_type_preserved",
      message: `Unsupported CDXML bracket type "${element.attributes.BracketType ?? "unspecified"}" was preserved as an unknown compatibility object.` });
    return importUnknownCompatibilityObject(element, pageIndex, objectIndex);
  }
  if (element.attributes.GraphicType === "Bracket" && ["Square", "Round"].includes(element.attributes.BracketType)) {
    if (hasUnmappedBracketStyle(element.attributes)) {
      context.warnings.push({ code: "cdxml.bracket_style_preserved", sourceObjectId: `cdxml_bracket_${pageIndex + 1}_${objectIndex}`,
        message: "Bracket styling that has no native mapping was preserved in compatibility metadata; the default native glyph style is displayed." });
    }
    return { id: `cdxml_bracket_${pageIndex + 1}_${objectIndex}`, type: "bracket", ...box, rotation: 0, style: {},
      bracketKind: element.attributes.BracketType === "Round" ? "round" : "square", side: "open",
      containedObjectIds: [], compatibility: { sourceFormat: "cdxml", originalId: element.attributes.id,
        warnings: [], unknown: { cdxmlBracket: element, cdxmlCoordinateSpace: "xy", cdxmlBracketState: JSON.stringify([undefined, undefined, undefined, undefined]),
          ...(element.attributes.color !== undefined ? { cdxmlCurveColor: colorForCdxmlIndex(element.attributes.color, context.colorTable) } : {}),
          cdxmlBracketGeometry: JSON.stringify([box.x, box.y, box.width, box.height, 0, element.attributes.BracketType === "Round" ? "round" : "square", "open"]) } } };
  }
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
  // `LineType="Wavy"` survives only on the single-shaft arrows. The wavy generator emits ONE shaft
  // and ignores `dualShaft`, so keeping the kind here would collapse an equilibrium's two opposed
  // shafts — and a retrosynthetic arrow's parallel pair plus its "=>" head — into a single wavy line
  // while `dualShaft` still claimed otherwise, trading a small loss for the arrow's whole identity.
  const dualShaft = equilibrium || retro;
  if (dualShaft && graphic.data.artPathKind === "wavy") {
    context.warnings.push(
      warning(
        "cdxml.wavy_dual_shaft_arrow_straightened",
        `A wavy ${arrowKind} arrow was imported with a straight shaft: its two shafts are drawn geometry, which ChemDraft cannot currently draw as a wave. The arrow's chemistry is unchanged.`
      )
    );
  }
  return {
    ...graphic,
    graphicKind: "path",
    data: {
      ...graphic.data,
      // Only DEFAULT the path kind, as the `<arrow>` importer does. `graphicDataFromCdxmlShape` has
      // already read `LineType="Wavy"` off this element, and `exportSemanticReactionArrowGraphic`
      // writes that same attribute back out — so overwriting it here straightened a wavy shaft on
      // the way in, including on files this codec had just written itself.
      artPathKind: dualShaft ? "line" : graphic.data.artPathKind ?? "line",
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
      "A half-headed (fishhook) arrow was imported as ChemDraft's fishhook arrow, and exports again as ArrowType=\"HalfHead\". Its single-barb chemistry round-trips; the barb's left/right handedness does not, because native fishhook heads are one-sided but not handed."
    )
  );
  return {
    ...graphic,
    graphicKind: "path",
    data: {
      ...graphic.data,
      // Defaulted, not overwritten — as above, and for the same reason.
      artPathKind: graphic.data.artPathKind ?? "line",
      markerEnd: { kind: "half-arrow", sizePx: defaultCdxmlHalfArrowheadSizePx },
      artToolId: "fishhookArrow"
    }
  };
}

/**
 * Import a standalone `<arrow>` as a native art arrow, the same shape the
 * `<graphic GraphicType="Line" ArrowType=…>` path produces.
 *
 * ChemDraw writes reaction arrows as `<arrow>` elements; ChemDraft writes them as tagged
 * `<graphic>` lines. Only the second path produced a real arrow, so an imported ChemDraw arrow
 * arrived as an untagged `graphicKind: "line"` — a generic shape to everything downstream. The Main
 * toolbar offered it the shape layout (a fill colour, for a line), `graphicObjectSupportsMarkers`
 * requires `graphicKind === "path"` so its own head could not be edited, "Set as Default Arrow
 * Style" did not recognise it, and it re-exported as a decorative stroke.
 *
 * The tool is read from the heads, which is the only chemistry an `<arrow>` states: one head is a
 * reaction arrow, heads at both ends a resonance arrow, a single barb a fishhook. A headless
 * `<arrow>` is left untagged — it is a line, and should not claim to be a chemical arrow — but it
 * still becomes a path so a head can be added to it later.
 */
function importArrowGraphic(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext
): GraphicObject {
  const graphic = importShapeGraphic(element, pageIndex, objectIndex, context, "arrow");
  const markers = cdxmlArrowMarkers(element);
  const artToolId = artToolIdForImportedArrowMarkers(markers);
  return {
    ...graphic,
    graphicKind: "path",
    data: {
      ...graphic.data,
      // Only default the path kind — an <arrow> can carry real geometry of its own (a wavy shaft,
      // for one), and overwriting that would straighten it on import.
      artPathKind: graphic.data.artPathKind ?? "line",
      ...markers,
      ...(artToolId === undefined ? {} : { artToolId })
    }
  };
}

/** CDXML curves use the existing editable art-arrow representation, including for electron
 * pushing. Unlike the anchored mechanism object, it can express independent heads and any number
 * of cubic segments without inventing chemistry anchors that the source curve never stated. */
function importCurveGraphic(
  element: XmlElementView,
  pageIndex: number,
  objectIndex: number,
  context: ImportPageContext
): DocumentObject {
  const nodes = curveNodesFromCdxml(element.attributes.CurvePoints);
  if (!nodes) {
    const object = importUnknownCompatibilityObject(element, pageIndex, objectIndex);
    const message = `CDXML curve "${element.attributes.id ?? object.id}" has invalid or unsupported CurvePoints; the original curve is preserved for CDXML export.`;
    context.warnings.push({ code: "cdxml.curve_points_preserved", message, sourceObjectId: object.id });
    return { ...object, compatibility: { ...object.compatibility!, unknown: {
      cdxmlCurveAttributes: element.attributes,
      cdxmlCurveColor: colorForCdxmlIndex(element.attributes.color, context.colorTable) ?? defaultCdxmlStrokeColor
    } } };
  }
  const id = `cdxml_graphic_${pageIndex + 1}_${objectIndex}`;
  const markers = cdxmlArrowMarkers(element);
  const hasHead = Boolean(markers.markerStart || markers.markerEnd);
  const fishhook = markers.markerStart?.kind === "half-arrow" || markers.markerEnd?.kind === "half-arrow";
  const points = nodes.flatMap(node => [node.point, ...(node.inControl ? [node.inControl] : []), ...(node.outControl ? [node.outControl] : [])]);
  const box = parseCdxmlXyBoundingBox(element.attributes.BoundingBox) ?? paddedBoundsForPoints(points, 1);
  const warnings: CompatibilityWarning[] = [];
  const note = (code: string, message: string) => {
    warnings.push({ code, message, objectId: id });
    context.warnings.push({ code, message, sourceObjectId: id });
  };
  if (hasHead && ["HeadSize", "ArrowheadCenterSize", "ArrowheadWidth"].some(name => element.attributes[name] !== undefined)) {
    note("cdxml.curve_head_size_approximation", `CDXML curve "${element.attributes.id ?? id}" uses native default arrowhead dimensions; the source HeadSize, ArrowheadCenterSize and ArrowheadWidth attributes are retained exactly for CDXML export.`);
  }
  if ([element.attributes.ArrowheadHead, element.attributes.ArrowheadTail].some(head =>
    ["halfleft", "halfright"].includes(normalizedCdxmlToken(head)))) {
    note("cdxml.curve_half_head_handedness_approximation", `CDXML curve "${element.attributes.id ?? id}" uses the native fishhook orientation; the source half-head handedness is retained exactly for CDXML export.`);
  }
  if (normalizedCdxmlToken(element.attributes.ArrowheadType) === "hollow" && hasHead) {
    note("cdxml.curve_hollow_head_approximation", `CDXML curve "${element.attributes.id ?? id}" uses an open native arrowhead for the hollow head; its original ArrowheadType is retained for CDXML export.`);
  }
  if ([element.attributes.ArrowheadHead, element.attributes.ArrowheadTail].some(head =>
    !["", "none", "unspecified", "full", "half", "halfleft", "halfright", "angle"].includes(normalizedCdxmlToken(head))) ||
    (hasHead && !["", "solid", "full", "half", "angle", "hollow"].includes(normalizedCdxmlToken(element.attributes.ArrowheadType)))) {
    note("cdxml.curve_head_approximation", `CDXML curve "${element.attributes.id ?? id}" has unrecognized arrowhead attributes; its native head is approximate and the original attributes are retained for CDXML export.`);
  }
  const lineType = normalizedCdxmlToken(element.attributes.LineType);
  if (lineType && !["solid", "dashed", "bold"].includes(lineType)) {
    note("cdxml.curve_line_type_approximation", `CDXML curve "${element.attributes.id ?? id}" has LineType="${element.attributes.LineType}"; the Bezier is drawn as a solid native stroke and the source LineType is retained for CDXML export.`);
  }
  const effectiveElement = { ...element, attributes: { ...context.curveLineDefaults, ...element.attributes } };
  if (["LineWidth", "BoldWidth"].some(name => effectiveElement.attributes[name] !== undefined &&
    !((parseNumber(effectiveElement.attributes[name]) ?? 0) > 0))) {
    note("cdxml.curve_line_width_approximation", `CDXML curve "${element.attributes.id ?? id}" has an invalid line width; a native default is used and the source width attributes are retained for CDXML export.`);
  }
  return {
    id, type: "graphic", ...box, rotation: 0,
    graphicKind: "path",
    style: graphicStyleFromCdxmlCurve(effectiveElement, context.colorTable),
    data: {
      artPathKind: "bezier", pathNodes: nodes,
      ...(cdxmlCurveIsClosed(element.attributes) ? { pathClosed: true } : {}),
      ...markers,
      ...(hasHead ? { artToolId: fishhook ? "fishhookCurved" : "curvedArrow90" } : {})
    },
    compatibility: {
      sourceFormat: "cdxml", originalId: element.attributes.id, warnings,
      unknown: { cdxmlElementName: "curve", cdxmlCurveAttributes: element.attributes, cdxmlCoordinateSpace: "xy" }
    }
  };
}

/** Read x/y pairs without rounding. Support both a start + cubic triples and the CDXML spline
 * spelling (incoming handle, knot, outgoing handle for each node, including the exterior handles).
 * Three points describe one quadratic; degree elevation to cubic is an exact format conversion. */
function curveNodesFromCdxml(value: string | undefined): GraphicPathNode[] | undefined {
  if (!value?.trim()) return undefined;
  const coordinates = value.trim().split(/\s+/).map(Number);
  if (coordinates.length % 2 || !coordinates.every(Number.isFinite)) return undefined;
  const points: Point[] = [];
  for (let index = 0; index < coordinates.length; index += 2) {
    points.push({ x: cdxmlToCssPx(coordinates[index]), y: cdxmlToCssPx(coordinates[index + 1]) });
  }
  if (points.length === 2) return points.map(point => ({ point }));
  if (points.length === 3) {
    const [start, control, end] = points;
    return [
      { point: start, outControl: { x: start.x + (control.x - start.x) * 2 / 3, y: start.y + (control.y - start.y) * 2 / 3 } },
      { point: end, inControl: { x: end.x + (control.x - end.x) * 2 / 3, y: end.y + (control.y - end.y) * 2 / 3 } }
    ];
  }
  if (points.length >= 4 && (points.length - 1) % 3 === 0) {
    const nodes: GraphicPathNode[] = [];
    for (let index = 0; index < points.length; index += 3) {
      nodes.push({ point: points[index],
        ...(index > 0 ? { inControl: points[index - 1] } : {}),
        ...(index + 1 < points.length ? { outControl: points[index + 1] } : {}) });
    }
    return nodes;
  }
  if (points.length >= 6 && points.length % 3 === 0) {
    const nodes: GraphicPathNode[] = [];
    for (let index = 0; index < points.length; index += 3) {
      nodes.push({ point: points[index + 1], inControl: points[index], outControl: points[index + 2] });
    }
    return nodes;
  }
  return undefined;
}

function cdxmlCurveIsClosed(attributes: Record<string, string>): boolean {
  return ["yes", "true", "1"].includes(normalizedCdxmlToken(attributes.Closed));
}

/** The native arrow tool an imported `<arrow>` stands for, judged by which ends carry heads. */
function artToolIdForImportedArrowMarkers(
  markers: Pick<GraphicObject["data"], "markerStart" | "markerEnd">
): string | undefined {
  const head = markers.markerEnd?.kind;
  const tail = markers.markerStart?.kind;
  if (head === undefined && tail === undefined) {
    return undefined;
  }
  // A single barb is one electron, not two — the same distinction ArrowType="HalfHead" carries.
  if (head === "half-arrow" || tail === "half-arrow") {
    return "fishhookArrow";
  }
  return head !== undefined && tail !== undefined ? "resonanceArrow" : "reactionArrow";
}

/** A standalone `<arrow>` carries its heads in three attributes rather than the closed `ArrowType`
 *  enum a `<graphic GraphicType="Line">` reaction arrow uses: `ArrowheadHead`/`ArrowheadTail` say
 *  which ends are headed, and `ArrowheadType` says how they are drawn. Keying only off `ArrowType`
 *  — which an `<arrow>` element never carries — imported every ChemDraw arrow as a bare line. */
function cdxmlArrowMarkers(element: XmlElementView): Pick<GraphicObject["data"], "markerStart" | "markerEnd"> {
  const arrowheadType = normalizedCdxmlToken(element.attributes.ArrowheadType);
  const isCurve = element.name === "curve";
  const markerEnd = cdxmlArrowMarker(element.attributes.ArrowheadHead, arrowheadType, isCurve);
  const markerStart = cdxmlArrowMarker(element.attributes.ArrowheadTail, arrowheadType, isCurve);
  return {
    ...(markerEnd ? { markerEnd } : {}),
    ...(markerStart ? { markerStart } : {})
  };
}

function cdxmlArrowMarker(arrowhead: string | undefined, arrowheadType: string, isCurve: boolean): GraphicMarker | undefined {
  const head = normalizedCdxmlToken(arrowhead);
  // An absent attribute and "Unspecified" both mean the end is unheaded — which is why ChemDraw
  // writes a plain line arrow as `ArrowheadType="Solid"` with no `ArrowheadHead` at all.
  if (head === "" || head === "none" || head === "unspecified") {
    return undefined;
  }
  // Curve aliases stay scoped here: <arrow> keeps its historical full-head fallback for Half,
  // ArrowheadType=Half and a per-end Angle token.
  if (head === "halfleft" || head === "halfright" || (isCurve && (head === "half" || arrowheadType === "half"))) {
    // Native fishhook heads are one-sided but not left/right-handed, so both spellings land on the
    // same marker; a ChemDraft-authored arrow keeps its exact head in the embedded payload.
    return { kind: "half-arrow", sizePx: defaultCdxmlHalfArrowheadSizePx };
  }
  // "Full" (and any head spelling this build doesn't know) draws a head; `ArrowheadType` picks which
  // one. "Hollow" and "Angle" are both unfilled, and `open-arrow` is the nearest native head to
  // either; an unstated type means ChemDraw's default solid head.
  return {
    kind: (isCurve && head === "angle") || arrowheadType === "hollow" || arrowheadType === "angle" ? "open-arrow" : "filled-arrow",
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

function graphicStyleFromCdxmlCurve(element: XmlElementView, colorTable: CdxmlColorTable): GraphicObject["style"] {
  const style = graphicStyleFromCdxmlShape(element, colorTable);
  const width = normalizedCdxmlToken(element.attributes.LineType) === "bold"
    ? parseNumber(element.attributes.BoldWidth) ?? parseNumber(element.attributes.LineWidth)
    : parseNumber(element.attributes.LineWidth);
  if (width !== undefined && width > 0) style.strokeWidth = cdxmlToCssPx(width);
  return style;
}

function cdxmlCurveLineDefaults(attributes: Record<string, string>): Record<string, string> {
  return Object.fromEntries(["LineWidth", "BoldWidth"].flatMap(name =>
    attributes[name] === undefined ? [] : [[name, attributes[name]]]));
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

/** The page-space box enclosing `objects`, or undefined when there is none to enclose. */
function unionObjectBounds(
  objects: readonly DocumentObject[]
): { x: number; y: number; width: number; height: number } | undefined {
  // A loop, not `Math.min(...values)`: spreading a hostile file's 150,000-member group overflows the
  // argument stack and threw out of the open instead of failing safely.
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const object of objects) {
    if (![object.x, object.y, object.width, object.height].every((value) => Number.isFinite(value))) {
      continue;
    }
    left = Math.min(left, object.x);
    top = Math.min(top, object.y);
    right = Math.max(right, object.x + object.width);
    bottom = Math.max(bottom, object.y + object.height);
  }
  if (left === Infinity) {
    return undefined;
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function importUnknownCompatibilityObject(element: XmlElementView, pageIndex: number, objectIndex: number): UnknownCompatibilityObject {
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

/**
 * fast-xml-parser's validator matches attribute values with `(([\s\S])*?)`, a group repeated once per
 * character, which V8 runs recursively: a value of a few hundred thousand characters overflows the
 * stack. The embedded ChemDraft payload is exactly such a value — base64 of the whole document — so
 * every large drawing failed to save (the export re-parses its own output for the visible hash) and a
 * large saved file could not be reopened. Validation only checks structure, so it runs on a copy with
 * long values shortened; the parser, whose attribute pattern is flat, reads the real text.
 */
const VALIDATION_ATTRIBUTE_VALUE_LIMIT = 4096;

// A linear scan, not a regular expression: even `"[^"<]{4096,}"` keeps backtracking state per
// character in V8 and overflows on a multi-megabyte match. It reads quotes only inside markup —
// never in text, comments, or CDATA. Text may hold a raw quote (the writer escapes only `&`, `<`
// and `>` there), and a scan keyed on every `=` took `pH = "7` in a caption for an attribute: the
// quote paired with a later one, the payload after it went unshortened, and the app refused to
// reopen its own file.
function withLongAttributeValuesShortened(xml: string): string {
  let result = "";
  let copiedUpTo = 0;
  let cursor = 0;
  for (;;) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) {
      break;
    }
    const skipTo = xml.startsWith("<!--", open)
      ? xml.indexOf("-->", open + 4)
      : xml.startsWith("<![CDATA[", open)
        ? xml.indexOf("]]>", open + 9)
        : undefined;
    if (skipTo !== undefined) {
      if (skipTo === -1) {
        break;
      }
      cursor = skipTo + 3;
      continue;
    }
    // A tag (or `<?…?>`, `<!DOCTYPE …>`): quoted values until the `>` outside them.
    let index = open + 1;
    for (; index < xml.length; index += 1) {
      const character = xml[index];
      if (character === ">") {
        break;
      }
      if (character !== '"' && character !== "'") {
        continue;
      }
      const close = xml.indexOf(character, index + 1);
      if (close === -1) {
        // Unterminated: nothing to shorten, and the validator reports the real error.
        return copiedUpTo === 0 ? xml : result + xml.slice(copiedUpTo);
      }
      const lessThan = xml.indexOf("<", index + 1);
      if (close - index - 1 >= VALIDATION_ATTRIBUTE_VALUE_LIMIT && (lessThan === -1 || lessThan > close)) {
        result += `${xml.slice(copiedUpTo, index + 1)}…`;
        copiedUpTo = close;
      }
      index = close;
    }
    cursor = index + 1;
  }
  return copiedUpTo === 0 ? xml : result + xml.slice(copiedUpTo);
}

function parseCdxml(contents: string, parser = xmlParser): OrderedXmlTree {
  const xml = stripByteOrderMark(contents);
  const validation = XMLValidator.validate(withLongAttributeValuesShortened(xml));
  if (validation !== true) {
    throw new Error(validation.err.msg);
  }
  const parsed = parser.parse(xml) as unknown;
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

/** The document element's name, skipping the XML declaration and other processing instructions. */
function xmlRootElementName(tree: OrderedXmlTree): string | undefined {
  for (const node of tree) {
    const element = elementView(node);
    if (element && !element.name.startsWith("?") && !element.name.startsWith("!")) {
      return element.name;
    }
  }
  return undefined;
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
    const text = child["#text"];
    // The XML parser coerces standalone numeric/boolean runs. Subscripts such as the 3 in
    // SO3 are still text, both in atom labels and in the standalone importText path.
    if (typeof text === "string" || typeof text === "number" || typeof text === "boolean") {
      return String(text);
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

// The native payload is megabytes of base64url on a large drawing, so both directions work on
// preallocated byte arrays. Growing a string one character at a time was most of a 5,000-molecule
// save, and pushing decoded bytes into a number[] was a third of reopening it. Node's Buffer would
// do this natively, but this code also runs in the WebView, where there is no Buffer.
const base64UrlEncodeCodes = Uint8Array.from(base64UrlAlphabet, (char) => char.charCodeAt(0));
const base64UrlDecodeTable = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let index = 0; index < base64UrlAlphabet.length; index += 1) {
    table[base64UrlAlphabet.charCodeAt(index)] = index;
  }
  return table;
})();

// Unpadded base64url: a trailing group of one byte becomes two characters and a group of two
// becomes three, never "=" padding. Files already on disk were written that way, so the output
// must stay byte-identical to the character-by-character encoder this replaced.
export function encodeBase64UrlBytes(bytes: Uint8Array): string {
  const length = bytes.length;
  const remainder = length % 3;
  const wholeGroupsEnd = length - remainder;
  const out = new Uint8Array((wholeGroupsEnd / 3) * 4 + (remainder === 0 ? 0 : remainder + 1));
  let write = 0;
  for (let index = 0; index < wholeGroupsEnd; index += 3) {
    const triple = (bytes[index] << 16) | (bytes[index + 1] << 8) | bytes[index + 2];
    out[write] = base64UrlEncodeCodes[triple >> 18];
    out[write + 1] = base64UrlEncodeCodes[(triple >> 12) & 0x3f];
    out[write + 2] = base64UrlEncodeCodes[(triple >> 6) & 0x3f];
    out[write + 3] = base64UrlEncodeCodes[triple & 0x3f];
    write += 4;
  }
  if (remainder === 1) {
    const first = bytes[wholeGroupsEnd];
    out[write] = base64UrlEncodeCodes[first >> 2];
    out[write + 1] = base64UrlEncodeCodes[(first << 4) & 0x3f];
  } else if (remainder === 2) {
    const pair = (bytes[wholeGroupsEnd] << 8) | bytes[wholeGroupsEnd + 1];
    out[write] = base64UrlEncodeCodes[pair >> 10];
    out[write + 1] = base64UrlEncodeCodes[(pair >> 4) & 0x3f];
    out[write + 2] = base64UrlEncodeCodes[(pair << 2) & 0x3f];
  }
  // Every code is ASCII, so a UTF-8 decode is the identity and turns the whole array into a string
  // in one native call.
  return new TextDecoder().decode(out);
}

export function decodeBase64UrlBytes(value: string): Uint8Array {
  const length = value.length;
  const remainder = length % 4;
  // One leftover character cannot carry a whole byte, so no encoder produces it.
  if (remainder === 1) {
    throw new Error("Invalid base64url payload.");
  }
  const wholeGroupsEnd = length - remainder;
  const bytes = new Uint8Array((wholeGroupsEnd / 4) * 3 + (remainder === 0 ? 0 : remainder - 1));
  let write = 0;
  for (let index = 0; index < wholeGroupsEnd; index += 4) {
    const quad =
      (base64UrlSextet(value, index) << 18) |
      (base64UrlSextet(value, index + 1) << 12) |
      (base64UrlSextet(value, index + 2) << 6) |
      base64UrlSextet(value, index + 3);
    bytes[write] = quad >> 16;
    bytes[write + 1] = (quad >> 8) & 0xff;
    bytes[write + 2] = quad & 0xff;
    write += 3;
  }
  if (remainder >= 2) {
    const high = (base64UrlSextet(value, wholeGroupsEnd) << 6) | base64UrlSextet(value, wholeGroupsEnd + 1);
    if (remainder === 2) {
      bytes[write] = high >> 4;
    } else {
      const triple = (high << 6) | base64UrlSextet(value, wholeGroupsEnd + 2);
      bytes[write] = triple >> 10;
      bytes[write + 1] = (triple >> 2) & 0xff;
    }
  }
  return bytes;
}

function base64UrlSextet(value: string, index: number): number {
  const code = value.charCodeAt(index);
  const sextet = code < 128 ? base64UrlDecodeTable[code] : -1;
  if (sextet < 0) {
    throw new Error("Invalid base64url payload.");
  }
  return sextet;
}

function createIdAllocator(pageIndex: number, reservedIds: ReadonlySet<string> = new Set()): IdAllocator {
  let nextId = pageIndex * 10000 + 1;
  const claimed = new Set<string>();
  return {
    next() {
      while (reservedIds.has(String(nextId)) || claimed.has(String(nextId))) nextId += 1;
      const value = String(nextId);
      nextId += 1;
      claimed.add(value);
      return value;
    },
    sourceId(value) {
      if (!/^[\w.:-]+$/.test(value) || claimed.has(value)) return this.next();
      claimed.add(value);
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
  bond: MoleculeBond,
  molecule: MoleculeObject,
  warnings: CompatibilityConversionWarning[]
): string {
  const { order } = bond;
  const sourceObjectId = molecule.id;
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
      message: "Native aromatic/delocalised bond order was preserved as CDXML Order=\"1.5\". This does not establish ring aromaticity or choose a Kekule structure.",
      sourceObjectId,
      bondIds: [bond.id]
    });
    return "1.5";
  }
  // Keep unsupported source values through the visible layer too. The native enum deliberately
  // says only `unknown`; it cannot encode a partial, query or future CDXML order's exact spelling.
  // Only consult this payload while the bond is still unknown, and never restore a known order
  // from malformed/stale metadata. Explicit chemical edits always take precedence.
  const preservedOrders = molecule.compatibility?.unknown.cdxmlUnknownBondOrdersByBondId;
  const preserved = isRecord(preservedOrders) ? preservedOrders[bond.id] : undefined;
  const value = typeof preserved === "string" && nativeBondOrderFromCdxml(preserved) === "unknown"
    ? preserved : "any";
  warnings.push({
    code: "cdxml.unknown_bond_order",
    message: `Native unknown bond order was exported as CDXML Order="${value}"; its chemical order remains unknown.`,
    sourceObjectId,
    bondIds: [bond.id]
  });
  return value;
}

function isCdxmlDativeOrder(order: string | undefined): boolean {
  return order?.trim().toLowerCase() === "dative";
}

function moleculeBondOrderFromCdxml(
  order: string | undefined,
  warnings: CompatibilityConversionWarning[],
  sourceObjectId: string,
  bondId: string
): MoleculeBond["order"] {
  const nativeOrder = nativeBondOrderFromCdxml(order);
  if (nativeOrder === "aromatic") {
    warnings.push({
      code: "cdxml.aromatic_bond_import_approximation",
      message: "CDXML aromatic/delocalised order was preserved as native aromatic, including outside rings; no ring aromaticity or Kekule structure was inferred.",
      sourceObjectId,
      bondIds: [bondId]
    });
  } else if (nativeOrder === "unknown") {
    warnings.push({
      code: "cdxml.bond_order_import_unsupported",
      message: `Unsupported CDXML bond order "${order}" was imported as unknown; the original order value is preserved for CDXML export.`,
      sourceObjectId,
      bondIds: [bondId]
    });
  }
  return nativeOrder;
}

function nativeBondOrderFromCdxml(order: string | undefined): MoleculeBond["order"] {
  if (order === "1" || order === undefined) {
    return "single";
  }
  if (order === "2") {
    return "double";
  }
  if (order === "3") {
    return "triple";
  }
  if (isCdxmlDativeOrder(order)) {
    // A dative bond is native: a single bond drawn dashed (`isDativeBond`). The dashed style is
    // applied by the caller, after the bond's own Display, so the pair always reads back as dative.
    return "single";
  }
  if (order === "1.5" || order?.toLowerCase() === "aromatic") {
    return "aromatic";
  }
  return "unknown";
}

// ChemDraw encodes wedge/hash stereo on <b> via Display. The "Begin" variants put the
// narrow (stereocenter) end at B; the "End" variants put it at E. ChemDraft keeps the
// narrow end at fromAtomId, so the "End" variants import with B/E swapped. Older and
// alternate visible styles such as Hash, Dash, and Bold map into ChemDraft's native
// display styles without warning.
const cdxmlBondDisplays: Record<string, { bondStyle: BondDisplayStyle; narrowAtEnd: boolean }> = {
  Wavy: { bondStyle: "wavy", narrowAtEnd: false },
  Bold: { bondStyle: "bold", narrowAtEnd: false },
  Dash: { bondStyle: "dashed", narrowAtEnd: false },
  Hash: { bondStyle: "hashed", narrowAtEnd: false },
  WedgeBegin: { bondStyle: "wedge", narrowAtEnd: false },
  WedgeEnd: { bondStyle: "wedge", narrowAtEnd: true },
  WedgedHashBegin: { bondStyle: "hashed", narrowAtEnd: false },
  WedgedHashEnd: { bondStyle: "hashed", narrowAtEnd: true }
};

const cdxmlBeginDisplayByBondStyle = {
  wavy: "Wavy",
  bold: "Bold",
  dashed: "Dash",
  wedge: "WedgeBegin",
  hashed: "WedgedHashBegin"
} as const;

function cdxmlBondDisplay(
  display: string | undefined,
  order: string | undefined
): { bondStyle: BondDisplayStyle; narrowAtEnd: boolean } | undefined {
  // Wavy on a single bond means explicitly unknown stereo at B (native fromAtomId).
  // Other orders, including Wavy double bonds, retain their unsupported-display behavior.
  if (display === "Wavy" && order !== "1" && order !== undefined) {
    return undefined;
  }
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
  return atomicNumberForElementSymbol(element);
}

/**
 * The element or label a CDXML node's `Element` attribute names, or undefined when it names none.
 *
 * CDXML writes an atomic number: plain digits only, so "1e1", "0x1A" and "+6" are not 10, 26 and
 * 6. An absent attribute is carbon, the format's default. Text that is not a number is taken as
 * written, as it always was: an element symbol, D, T, "*", or a label such as "Ph" or "OMe", which
 * this package's exporter writes as text for any atom without an atomic number. What names nothing
 * is a number outside 1–118, anything else number-like (26.5, −6, "+6", "1e1", "0x1A"), or an empty
 * value: the caller imports an unknown atom and warns, never carbon (AGENTS.md §7).
 */
function elementFromCdxmlAtom(element: string | undefined): string | undefined {
  if (element === undefined) {
    return "C";
  }
  const trimmed = element.trim();
  if (/^\d+$/.test(trimmed)) {
    return elementSymbolForAtomicNumber(Number(trimmed));
  }
  if (trimmed === "" || /^[+-]?\.?\d/.test(trimmed)) {
    return undefined;
  }
  return trimmed;
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
  // Imported curves can contain enough nodes to overflow the argument stack of Math.min(...xs).
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
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

/** The same spellings plus the one an art arrow can carry that no `reaction-arrow` object can. */
const cdxmlArrowTypeByExportKind: Readonly<Record<SemanticArrowExportKind, string>> = {
  ...cdxmlArrowTypeByKind,
  fishhook: "HalfHead"
};

const arrowKindByCdxmlArrowType: ReadonlyMap<string, ArrowObject["arrowKind"]> = new Map([
  // Real CDXML spellings.
  ["fullhead", "forward"],
  // "halfhead" is absent on purpose: a half-headed arrow is one-electron chemistry and is
  // intercepted before this lookup (see importHalfHeadArrowAsFishhook). Mapping it to "forward"
  // here is what used to launder it into a two-electron reaction arrow.
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

// One scan decides whether escaping is needed at all, and a value with nothing to escape is
// returned untouched rather than copied by each replace pass. Most values need none, including the
// base64url payload, whose alphabet has no XML-special characters.
const XML_TEXT_SPECIAL = /[&<>\r]/;
const XML_ATTRIBUTE_SPECIAL = /[&<>"'\r\n\t]/;

function decodeXmlReferences(value: string): string {
  const xmlEntities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  // A single replace never scans its replacement text: &amp;#10; stays literal &#10;.
  return value.replace(/&(amp|lt|gt|quot|apos|#(?:[0-9]+|x[0-9a-fA-F]+));/g, (reference, entity: string) => {
    if (entity[0] !== "#") return xmlEntities[entity];
    const codePoint = entity[1] === "x" ? Number.parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    if (!(codePoint === 9 || codePoint === 10 || codePoint === 13
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff))) {
      throw new Error(`Invalid XML character reference "${reference}".`);
    }
    return String.fromCodePoint(codePoint);
  });
}

function escapeXmlText(value: string): string {
  if (!XML_TEXT_SPECIAL.test(value)) {
    return value;
  }
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\r/g, "&#13;");
}

function escapeXmlAttribute(value: string): string {
  if (!XML_ATTRIBUTE_SPECIAL.test(value)) {
    return value;
  }
  return escapeXmlText(value)
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;");
}

function indent(value: string, spaces: number): string {
  // Only indent the structural boundary before this serialized object. Its internal
  // newlines may be visible text, including styled conditions and atom labels.
  return `${" ".repeat(spaces)}${value}`;
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
