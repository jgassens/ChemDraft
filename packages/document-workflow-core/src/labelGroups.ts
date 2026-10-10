// Groups an atom label names — an abbreviation from the template library ("OMe"), or an element
// carrying abbreviations ("NMe2") — and the attachment atom each one bonds through.
//
// The label is the only stored form of a group. `atoms.ts` decides which labels are groups
// (`nativeAtomLabelReading`) and how many bonds each takes; this file holds the shapes. Kept free of
// `atoms.ts` imports so that file can import it.

import type { AbbreviationDefinition } from "@chemdraft/template-library";

/** What a label spells when it names a group. */
export type NativeLabelGroup =
  | {
      kind: "abbreviation";
      label: string;
      definition: AbbreviationDefinition;
    }
  | {
      /** One element carrying stated hydrogens and abbreviations, all bonded to it: "NMe2", "CH2Ph". */
      kind: "composite";
      label: string;
      head: string;
      hydrogens: number;
      /** One entry per substituent, repeated for a count: "NMe2" lists Me twice. */
      substituents: readonly AbbreviationDefinition[];
    };

/** The atom a group's label bonds connect to, as the group itself defines it. */
export interface NativeLabelGroupAttachment {
  element: string;
  /** Valence the attachment atom already uses inside the group: its bonds there plus its hydrogens. */
  internalValence: number;
  /** Formal charge the attachment atom carries inside the group (nitro's N⁺). */
  charge: number;
  /** The free valence the table states; a composite's follows from its head instead. */
  declaredAttachmentCount?: number;
}

export function nativeLabelGroupAttachment(group: NativeLabelGroup): NativeLabelGroupAttachment {
  if (group.kind === "composite") {
    return { element: group.head, internalValence: group.hydrogens + group.substituents.length, charge: 0 };
  }
  const { definition } = group;
  const attachment = definition.atoms[0]!;
  const bondValence = definition.bonds
    .filter(([from, to]) => from === 0 || to === 0)
    .reduce((sum, [, , order]) => sum + order, 0);
  return {
    element: attachment.element,
    internalValence: bondValence + attachment.hydrogens,
    charge: attachment.charge ?? 0,
    declaredAttachmentCount: definition.attachmentCount
  };
}
