import type { ChemDraftDocument } from "@chemdraft/chem-core";
import { atomProblem, type AtomProblemAction } from "@chemdraft/document-workflow-core";
import type { CommandSpec } from "./commands";
import type { AtomProblemSnapshot } from "./dialogs/dialogProtocol";
export interface AtomProblemTarget { objectId: string; atomId: string }
export function atomProblemSnapshot(document: ChemDraftDocument, target: AtomProblemTarget, targetVersion: number): AtomProblemSnapshot {
  const molecule = document.pages.flatMap(page => page.objects).find(object => object.id === target.objectId);
  const problem = molecule?.type === "molecule" ? atomProblem(molecule, target.atomId) : undefined;
  return { title: document.title.slice(0, 256) || "Untitled", targetVersion,
    explanation: problem?.explanation.slice(0, 1024) ?? "No problem. This atom is valid or has been deleted.",
    fixes: problem?.fixes.map(({ action, label }) => ({ action, label })) ?? [] };
}
export function atomProblemCommandId(target: AtomProblemTarget, action: "open" | AtomProblemAction = "open"): string {
  const encode = (id: string) => encodeURIComponent(id).replaceAll(".", "%2E");
  return `atom.problem.${action}.${encode(target.objectId)}.${encode(target.atomId)}`;
}
export function atomProblemCommands(document: ChemDraftDocument): { spec: CommandSpec; target: AtomProblemTarget; action: "open" | AtomProblemAction }[] {
  return document.pages.flatMap(page => page.objects.flatMap(object => object.type !== "molecule" ? [] : object.atoms.flatMap(atom => {
    const problem = atomProblem(object, atom.id);
    if (!problem) return [];
    const target = { objectId: object.id, atomId: atom.id };
    return [{ action: "open" as const, label: "Atom problem…" }, ...problem.fixes].map(({ action, label }) => ({ target, action,
      spec: { id: atomProblemCommandId(target, action), title: label, source: "core" as const, icon: "select", enabled: true }
    }));
  })));
}
