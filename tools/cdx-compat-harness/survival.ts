import { parseSourceXml } from "./xml";
import { readCdx, type CdxElement } from "../../packages/cdx-compat/src/cdxBinary";
import { abbreviationExpansionIssue } from "../../packages/cdx-compat/src/abbreviations";
import type { ChemDraftDocument } from "../../packages/chem-core/src/index";
import { isGenericAtomLabel } from "../../packages/template-library/src/index";

/** Only superatom records are abbreviations; label-only atoms are measured as chemistry.
 * Nameless source nodes become unknown atoms (*), not abbreviation drawings. */
function isAbbreviation(label: string): boolean {
  const trimmed = label.trim();
  return !!trimmed && trimmed !== "*" && !(trimmed.startsWith("R") && isGenericAtomLabel(trimmed));
}

export interface SurvivalCounts {
  /** Total resolved arrow links, including multiple links from one step. */
  stepArrows: number;
  /** Counts in page/scheme/step order; absent only in legacy stored summaries. */
  stepArrowLinks?: number[];
  abbreviations: number;
  display: Record<string, number>;
  /** Bracket source IDs let diagnostics cover the missing glyph/group, rather than its file. */
  displayObjectIds?: Record<string, string[]>;
}

/** Compare corresponding steps, so gains elsewhere never cancel a lost link. */
export function stepArrowLosses(source: SurvivalCounts, stages: SurvivalCounts[]) {
  // Older stored summaries cannot recover per-step evidence without reimporting.
  const perStep = source.stepArrowLinks !== undefined && stages.every(stage => stage.stepArrowLinks !== undefined);
  const counts = perStep ? source.stepArrowLinks! : [source.stepArrows];
  const losses = counts.map((count, step) => Math.max(0, count - Math.min(...stages.map(stage =>
    (perStep ? stage.stepArrowLinks! : [stage.stepArrows])[step] ?? 0))));
  const links = losses.reduce((sum, count) => sum + count, 0);
  return { links, steps: perStep ? losses.filter(count => count > 0).length : links };
}

const add = (counts: Record<string, number>, kind: string) => { counts[kind] = (counts[kind] ?? 0) + 1; };
const recordBracketId = (out: SurvivalCounts, kind: string, id: string | undefined) => {
  if (id) ((out.displayObjectIds ??= {})[kind] ??= []).push(id);
};
const isCircle = (width: number, height: number) => width > 0 && height > 0 && Math.abs(width - height) <= Math.max(width, height) * 1e-6;
const isArrowedLine = (node: CdxElement) => node.name === "graphic" && node.attrs.GraphicType === "Line" && (
  !!node.attrs.ArrowType && !["nohead", "0"].includes(node.attrs.ArrowType.toLowerCase()) ||
  [node.attrs.ArrowheadHead, node.attrs.ArrowheadTail].some(head =>
    !!head && !["none", "unspecified", "0", "1"].includes(head.toLowerCase()))
);
const graphicKind = (type: string, oval?: string, circle = false) => {
  const known = ["Oval", "Line", "Rectangle", "Arc", "Bracket"].includes(type) ? type : "Unknown";
  const ovalKind = oval?.split(/\s+/).includes("Circle") || circle ? "Circle" : "Oval";
  return known === "Oval" ? `graphic.Oval.${ovalKind}` : `graphic.${known}`;
};

/** Inspect the supplied interchange bytes, before any import can discard objects. */
export function sourceSurvival(bytes: Uint8Array): SurvivalCounts {
  const root = Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "VjCD" ? readCdx(bytes) : parseSourceXml(Buffer.from(bytes).toString("utf8"));
  const all: CdxElement[] = [];
  const walk = (node: CdxElement) => { all.push(node); node.kids.forEach(walk); }; walk(root);
  const byId = new Map(all.filter(n => n.attrs.id).map(n => [n.attrs.id, n]));
  const resolves = (initial: string) => {
    let id = initial;
    const seen = new Set<string>();
    while (id && !seen.has(id)) {
      seen.add(id);
      const node = byId.get(id);
      if (!node) return false;
      if (node.attrs.SupersededBy) { id = node.attrs.SupersededBy.trim(); continue; }
      return node.name === "arrow" || isArrowedLine(node);
    }
    return false;
  };
  const text = (n: CdxElement): string => n.text + n.kids.map(text).join("");
  const out: SurvivalCounts = { stepArrows: 0, stepArrowLinks: [], abbreviations: 0, display: {} };
  for (const n of all) {
    if (n.name === "step") {
      const links = (n.attrs.ReactionStepArrows ?? "").trim().split(/\s+/).filter(resolves).length;
      out.stepArrowLinks!.push(links);
      out.stepArrows += links;
    }
  }
  // Follow the expansion tree, not every source node indiscriminately. Rejected outer
  // expansions also hide their inner labels; unexpanded nicknames create literal atoms only.
  const countFragment = (fragment: CdxElement, depth: number) => {
    const connectionPoints = new Set(depth > 0 ? fragment.kids.filter(child => child.name === "n" &&
      ["ExternalConnectionPoint", "12"].includes(child.attrs.NodeType)).map(child => child.attrs.id ?? "") : []);
    // Import strips the enclosing expansion's connection bonds before recursing. Such a bond
    // must not make an inner node appear to require another attachment of its own.
    const bonds = fragment.kids.filter(child => child.name === "b" &&
      !connectionPoints.has(child.attrs.B ?? "") && !connectionPoints.has(child.attrs.E ?? "")).map(bond => bond.attrs);
    for (const node of fragment.kids.filter(child => child.name === "n")) {
      if (depth > 0 && ["ExternalConnectionPoint", "12"].includes(node.attrs.NodeType)) continue;
      const nested = node.kids.filter(child => child.name === "fragment");
      if (!nested.length || abbreviationExpansionIssue(node.attrs, nested.map(fragment => ({
        atoms: fragment.kids.filter(child => child.name === "n").map(atom => atom.attrs),
        bonds: fragment.kids.filter(child => child.name === "b").map(bond => bond.attrs)
      })), bonds, depth)) continue;
      const labelText = node.kids.find(child => child.name === "t");
      const label = (labelText ? text(labelText).trim() : "") || node.attrs.GenericNickname || "";
      if (isAbbreviation(label)) out.abbreviations++;
      countFragment(nested[0], depth + 1);
    }
  };
  const scanFragments = (node: CdxElement) => {
    if (node.name === "n") return;
    if (node.name === "fragment") countFragment(node, 0);
    node.kids.forEach(scanFragments);
  };
  scanFragments(root);
  const displays = new Set(["graphic", "curve", "arrow", "t", "bracketedgroup", "embeddedobject", "table", "spectrum"]);
  const scan = (n: CdxElement, parent: string) => {
    // Node labels and their hidden expansion fragments are not standalone display objects.
    if (n.name === "n") return;
    if (displays.has(n.name) && (parent === "page" || parent === "fragment" || parent === "group" || n.name === "bracketedgroup") && !(n.name === "graphic" && n.attrs.SupersededBy)) {
      const box = (n.attrs.BoundingBox ?? "").trim().split(/\s+/).map(Number);
      const kind = isArrowedLine(n) ? "arrow"
        : n.name === "graphic" ? graphicKind(n.attrs.GraphicType, n.attrs.OvalType, box.length === 4 && isCircle(Math.abs(box[2] - box[0]), Math.abs(box[3] - box[1]))) : n.name;
      add(out.display, kind);
      if (kind === "graphic.Bracket" || kind === "bracketedgroup") recordBracketId(out, kind, n.attrs.id);
    }
    n.kids.forEach(k => scan(k, n.name));
  };
  scan(root, "");
  return out;
}

export function nativeSurvival(document: ChemDraftDocument): SurvivalCounts {
  const out: SurvivalCounts = { stepArrows: 0, stepArrowLinks: [], abbreviations: 0, display: {} };
  for (const page of document.pages) {
    const objects = new Map(page.objects.map(item => [item.id, item]));
    const bracketGroups = new Set<string>();
    const isArrow = (id: string) => {
      const target = objects.get(id);
      return target?.type === "reaction-arrow" || target?.type === "mechanism-arrow" || target?.type === "graphic" && (
        target.compatibility?.unknown.cdxmlElementName === "arrow" || !!target.data.artToolId?.toLowerCase().includes("arrow") || !!target.data.markerStart || !!target.data.markerEnd
      );
    };
    for (const object of page.objects) {
      if (object.type === "reaction") {
        const links = (object.arrowObjectIds ?? []).filter(isArrow).length;
        out.stepArrowLinks!.push(links);
        out.stepArrows += links;
      }
      if (object.type === "superatom" && isAbbreviation(object.label)) out.abbreviations++;
      if (object.type === "molecule") {
        out.abbreviations += (object.superatoms ?? []).filter(item => typeof item.label === "string" && isAbbreviation(item.label)).length;
      }
      if (object.type === "text") add(out.display, "t");
      else if (object.type === "table") add(out.display, "table");
      else if (object.type === "bracket") {
        add(out.display, "graphic.Bracket");
        recordBracketId(out, "graphic.Bracket", object.compatibility?.originalId ?? object.id);
        if (object.pairId && !bracketGroups.has(object.pairId)) {
          bracketGroups.add(object.pairId);
          add(out.display, "bracketedgroup");
          const source = object.compatibility?.unknown.bracketedGroup as { attributes?: { id?: string } } | undefined;
          recordBracketId(out, "bracketedgroup", source?.attributes?.id ?? object.pairId);
        }
      } else if (object.type === "reaction-arrow" || object.type === "mechanism-arrow") add(out.display, "arrow");
      else if (object.type === "graphic") {
        const unknown = object.compatibility?.unknown as Record<string, unknown> | undefined;
        const type = typeof unknown?.cdxmlGraphicType === "string" ? unknown.cdxmlGraphicType : ({ ellipse: "Oval", rect: "Rectangle", line: "Line", path: "Unknown", image: "Unknown", unknown: "Unknown" } as const)[object.graphicKind];
        add(out.display, unknown?.cdxmlElementName === "curve" ? "curve" : isArrow(object.id) ? "arrow" : graphicKind(type, typeof unknown?.cdxmlOvalType === "string" ? unknown.cdxmlOvalType : undefined, isCircle(object.width, object.height)));
      }
    }
  }
  return out;
}
