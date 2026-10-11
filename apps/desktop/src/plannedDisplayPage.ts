import type { DocumentPage, MoleculeBond } from "@chemdraft/chem-core";
import type { commitNativeAtomLabelTarget } from "./documentWorkflow";

type LabelPreview = ReturnType<typeof commitNativeAtomLabelTarget>;
type DoubleBondPreview = { objectId: string; bondId: string; side: NonNullable<MoleculeBond["display"]>["doubleBondSide"] };

/** A display-only attachment replaces just its molecule. Ordinary relabel drafts already
 * live on the input page, so retain its identity (including when the commit plan relabels). */
export function planDisplayPage(
  page: DocumentPage,
  labelPreview?: LabelPreview,
  doubleBondPreview?: DoubleBondPreview
): DocumentPage {
  let result = page;
  if (labelPreview?.target.kind === "atom") {
    const target = labelPreview.target;
    const source = page.objects.find(object => object.id === target.objectId);
    const preview = labelPreview.document.pages[0].objects.find(object => object.id === target.objectId);
    if (source?.type === "molecule" && preview?.type === "molecule" &&
        !source.atoms.some(atom => atom.id === target.atomId)) {
      result = { ...page, objects: page.objects.map(object => object.id === source.id ? preview : object) };
    }
  }
  if (!doubleBondPreview) return result;
  return {
    ...result,
    objects: result.objects.map(object => object.type !== "molecule" || object.id !== doubleBondPreview.objectId
      ? object
      : { ...object, bonds: object.bonds.map(bond => bond.id === doubleBondPreview.bondId && bond.order === "double"
        ? { ...bond, display: { ...(bond.display ?? {}), doubleBondSide: doubleBondPreview.side } }
        : bond) })
  };
}
