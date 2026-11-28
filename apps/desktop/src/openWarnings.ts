import type { ChemDraftDocument, DocumentObject } from "@chemdraft/chem-core";
import type { DocumentSessionEnvelope } from "./documentSession";
import { IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE } from "@chemdraft/document-workflow-core";

/**
 * The open report's code for a molecule whose lone-H (H•) cache the refresh
 * (`withImpliedRadicalChemistryRederived`, document-workflow-core) declined to change, re-exported so
 * the session restore's report merge below and its callers name it from here.
 */
export { IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE };

/** Opens and closes the current document's file warning list. */
export const TOGGLE_OPEN_WARNINGS_COMMAND_ID = "view.toggleOpenWarnings";

export const NO_OPEN_WARNINGS_REASON = "This document has no open or save warnings";

/** The list's element id, for the status-line button's aria-controls. */
export const OPEN_WARNINGS_LIST_ID = "open-warnings-list";

/** One warning from opening or saving a file, as the converter reported it. */
export interface OpenWarning {
  code: string;
  message: string;
  /** A recovered table draft warning stays in the report after its automatic announcement. */
  recoveryAnnounced?: boolean;
  /** The native object the warning is about; absent for a warning about the whole file. */
  sourceObjectId?: string;
  atomIds?: readonly string[];
  bondIds?: readonly string[];
}

/**
 * What one file open or save reported, kept separately so the status line can offer both after its
 * own text has moved on. It belongs to that document, so whatever replaces that document
 * (New, another open) drops it; document ids cannot tell them apart, as most documents are doc_001.
 */
export interface OpenWarningsReport {
  /** Absent on older reports, which always describe a file open. */
  operation?: "open" | "save";
  displayName: string;
  sourceLabel: string;
  warnings: readonly OpenWarning[];
}

/**
 * Independent optional session metadata: a malformed report must not discard its sibling or tab.
 *
 * `reread` is what the restore's own read of the autosaved contents reported. A saved open report
 * keeps every warning it had (it describes the original file, which the session no longer holds),
 * and gains each reread warning it does not already name, so a warning about what the document
 * holds now (an H atom stating a count it cannot carry) is never hidden behind an older report.
 * Without a saved open report the reread one stands. A save report takes its place only for what
 * a save report also flags (such an H atom): the reread warnings no save can report
 * (`readOnlyWarningCodes`: a lone H's cache the restore's refresh keeps stale) still stand.
 */
export function restoreSessionWarningReports(
  session: Pick<DocumentSessionEnvelope, "openWarnings" | "saveWarnings">,
  reread?: OpenWarningsReport
): {
  warnings?: OpenWarningsReport;
  saveWarnings?: OpenWarningsReport;
} {
  const open = session.openWarnings?.operation === "save" ? undefined : session.openWarnings;
  const save = session.saveWarnings ?? (session.openWarnings?.operation === "save" ? session.openWarnings : undefined);
  return {
    warnings: open ? mergeOpenWarnings(open, reread?.warnings ?? []) : save ? readOnlyWarnings(reread) : reread,
    saveWarnings: save
  };
}

/**
 * Warnings only a read of the document reports, which a save report never carries: the lone-H
 * refresh runs on open and restore, never on save, so its declined-refresh warning exists only in
 * the read's report.
 */
const readOnlyWarningCodes: ReadonlySet<string> = new Set([IMPLIED_RADICAL_CACHE_NOT_REFRESHED_CODE]);

/** `report` limited to `readOnlyWarningCodes`, or nothing when none is left. */
function readOnlyWarnings(report: OpenWarningsReport | undefined): OpenWarningsReport | undefined {
  const warnings = report?.warnings.filter((warning) => readOnlyWarningCodes.has(warning.code)) ?? [];
  return report && warnings.length ? { ...report, warnings } : undefined;
}

/** The same warning: its code and what it names (molecule, atoms, bonds), or its words when it names nothing. */
function openWarningKey(warning: OpenWarning): string {
  const ids = (list: readonly string[] | undefined) => [...list ?? []].sort().join(",");
  return warning.sourceObjectId === undefined && !warning.atomIds?.length && !warning.bondIds?.length
    ? JSON.stringify([warning.code, warning.message])
    : JSON.stringify([warning.code, warning.sourceObjectId ?? "", ids(warning.atomIds), ids(warning.bondIds)]);
}

function mergeOpenWarnings(report: OpenWarningsReport, added: readonly OpenWarning[]): OpenWarningsReport {
  const known = new Set(report.warnings.map(openWarningKey));
  const fresh = added.filter((warning) => {
    const key = openWarningKey(warning);
    if (known.has(key)) return false;
    known.add(key);
    return true;
  });
  return fresh.length ? { ...report, warnings: [...report.warnings, ...fresh] } : report;
}

/** What a warning's Show button selects: an object, and the atoms or bonds of it the warning names. */
export interface OpenWarningSelection {
  objectId: string;
  atomIds: readonly string[];
  bondIds: readonly string[];
}

export interface OpenWarningTarget {
  /** What the warning is about, in words: "Whole file", "Atom * in Molecule (CDXML fragment 12)". */
  label: string;
  /** Absent when the warning names nothing, or when what it named is no longer in the document. */
  selection?: OpenWarningSelection;
  /** True when the warning named an object, atom or bond that has since been deleted. */
  missing: boolean;
}

/** "1 warning", "3 warnings". */
export function warningCountLabel(count: number): string {
  return count === 1 ? "1 warning" : `${count} warnings`;
}

export function openWarningsHeading(report: OpenWarningsReport): string {
  if (report.operation === "save") {
    return `Saved ${report.displayName}: ${warningCountLabel(report.warnings.length)}`;
  }
  return `Opened ${report.displayName} as ${report.sourceLabel}: ${warningCountLabel(report.warnings.length)}`;
}

/** The report, when it has warnings to show. */
export function activeOpenWarnings(report: OpenWarningsReport | undefined): OpenWarningsReport | undefined {
  return report && report.warnings.length > 0 ? report : undefined;
}

/** Independent reports in display order, without changing either converter's warnings. */
export function fileWarningReports(open: OpenWarningsReport | undefined, save: OpenWarningsReport | undefined): OpenWarningsReport[] {
  return [open, save].filter((report): report is OpenWarningsReport => activeOpenWarnings(report) !== undefined);
}

export function fileWarningsTooltip(reports: readonly OpenWarningsReport[]): string | undefined {
  return reports.length > 0
    ? reports.map((report) => [openWarningsHeading(report), ...report.warnings.map((warning) => warning.message)].join("\n")).join("\n\n")
    : undefined;
}

/**
 * The status line's tooltip: the status as displayed, which the line truncates (several refusals),
 * then the file warnings on the lines after it. A status line the warnings already state is not
 * repeated; no text, no tooltip.
 */
export function statusMessageTitle(displayed: string | undefined, warningsTooltip: string | undefined): string | undefined {
  const text = displayed?.trim() ? displayed : undefined;
  if (!warningsTooltip) return text;
  if (!text || warningsTooltip.split("\n").includes(text)) return warningsTooltip;
  return `${text}\n\n${warningsTooltip}`;
}

export function describeOpenWarningTarget(document: ChemDraftDocument, warning: OpenWarning): OpenWarningTarget {
  if (!warning.sourceObjectId) {
    return { label: "Whole file", missing: false };
  }

  const object = findPageObject(document, warning.sourceObjectId);
  if (!object) {
    return { label: "An object no longer in the document", missing: true };
  }

  const objectLabel = describeObject(object);
  const namedAtomIds = warning.atomIds ?? [];
  const namedBondIds = warning.bondIds ?? [];
  if (namedAtomIds.length === 0 && namedBondIds.length === 0) {
    return { label: objectLabel, selection: { objectId: object.id, atomIds: [], bondIds: [] }, missing: false };
  }

  const atoms = object.type === "molecule" ? object.atoms.filter((atom) => namedAtomIds.includes(atom.id)) : [];
  const bonds = object.type === "molecule" ? object.bonds.filter((bond) => namedBondIds.includes(bond.id)) : [];
  if (atoms.length === 0 && bonds.length === 0) {
    const parts = namedAtomIds.length > 0 ? partCount(namedAtomIds.length, "atom") : partCount(namedBondIds.length, "bond");
    return { label: `${capitalize(parts)} no longer in ${objectLabel}`, missing: true };
  }

  const named = atoms.length === 1 && bonds.length === 0
    ? `Atom ${atoms[0].element}`
    : [atoms.length > 0 ? partCount(atoms.length, "atom") : "", bonds.length > 0 ? partCount(bonds.length, "bond") : ""]
      .filter(Boolean)
      .join(" and ");
  return {
    label: `${capitalize(named)} in ${objectLabel}`,
    selection: { objectId: object.id, atomIds: atoms.map((atom) => atom.id), bondIds: bonds.map((bond) => bond.id) },
    missing: false
  };
}

function findPageObject(document: ChemDraftDocument, objectId: string): DocumentObject | undefined {
  for (const page of document.pages) {
    const object = page.objects.find((candidate) => candidate.id === objectId);
    if (object) {
      return object;
    }
  }
  return undefined;
}

const objectTypeLabels: Partial<Record<DocumentObject["type"], string>> = {
  molecule: "Molecule",
  reaction: "Reaction",
  "reaction-arrow": "Reaction arrow",
  "mechanism-arrow": "Mechanism arrow",
  "electron-mark": "Electron mark",
  text: "Text",
  bracket: "Bracket",
  graphic: "Graphic",
  plus: "Plus sign",
  group: "Group",
  annotation: "Annotation",
  superatom: "Superatom",
  "unknown-compatibility-object": "Unsupported object"
};

/** "Molecule (CDXML fragment 12)": the type, and the id the source file gave it, when it had one. */
function describeObject(object: DocumentObject): string {
  const typeLabel = objectTypeLabels[object.type] ?? "Object";
  const compatibility = "compatibility" in object ? object.compatibility : undefined;
  const sourceId = compatibility?.originalId;
  if (!sourceId) {
    return typeLabel;
  }
  const sourceFormat = compatibility?.sourceFormat?.toUpperCase();
  return `${typeLabel} (${sourceFormat ? `${sourceFormat} ` : ""}${object.type === "molecule" ? "fragment " : "object "}${sourceId})`;
}

function partCount(count: number, noun: "atom" | "bond"): string {
  return count === 1 ? `1 ${noun}` : `${count} ${noun}s`;
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
