/**
 * A write refused by the stored-chemistry check. `reason` is a short plain clause for the user
 * (no object ids, no jargon, no leading capital or trailing period); `detail` is the full technical
 * text, with the molecule id, kept for the log. `message` is the technical text unless the caller supplies the
 * user sentence (the plugin-write wrapper does).
 */
export class ChemistryRefusal extends Error {
  readonly reason: string;
  readonly detail: string;

  constructor(reason: string, detail: string = reason, message: string = detail) {
    super(message);
    this.name = "ChemistryRefusal";
    this.reason = reason;
    this.detail = detail;
  }
}

/** The user sentence for a refusal, under the prefix that fits the surface it surfaces on. */
export function refusalSentence(prefix: string, reason: string): string {
  return `${prefix}: ${reason}.`;
}

export const PLUGIN_WRITE_REFUSED = "Plugin write refused";
export const RECOGNITION_REFUSED = "Recognition not inserted";
export const PLUGIN_CHANGE_REFUSED = "Plugin change not applied";

export function chemistryRefusalOf(error: unknown): ChemistryRefusal | undefined {
  return error instanceof ChemistryRefusal ? error : undefined;
}
