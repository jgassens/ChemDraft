import { parseJournalCatalog, JournalProfileSchema, JournalRequestSchema, type JournalProfile, type JournalRequest } from "@chemdraft/chem-core";
import journalData from "./journals.json";
import profileData from "./profiles.json";

export const journals = parseJournalCatalog(journalData, profileData).journals;
export const profiles: JournalProfile[] = profileData.map(profile => JournalProfileSchema.parse(profile));
export const validateJournalCatalog = parseJournalCatalog;
validateJournalCatalog(journals, profiles);
let packPromise: Promise<void> | undefined;
export const isJournalPackLoaded = () => journals.length > journalData.length;
/** Explicitly requested local data pack. No network, plugin execution or automatic document updates. */
export function loadJournalStylePack(): Promise<void> {
  if (!packPromise) packPromise = Promise.all([
    import("../../../../examples/plugins/journal-style-pack/data/journals.json"),
    import("../../../../examples/plugins/journal-style-pack/data/profiles.json")
  ]).then(([identities, formatting]) => {
    const candidate = validateJournalCatalog([...journals, ...identities.default], [...profiles, ...formatting.default]);
    // Validate the entire candidate before either public list changes.
    journals.splice(0, journals.length, ...candidate.journals);
    profiles.splice(0, profiles.length, ...candidate.profiles);
  }).catch(error => { packPromise = undefined; throw error; });
  return packPromise;
}
export async function ensureJournalProfile(request: JournalRequest): Promise<void> {
  if (request.profileId !== "custom" && !profiles.some(profile => profile.id === request.profileId)) await loadJournalStylePack();
}
export function searchJournals(query: string) {
  const needle = query.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  return journals.filter(journal => [journal.title, journal.publisher, ...journal.aliases, ...journal.issns]
    .some(value => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "").includes(needle)));
}
export const initialJournalRequest: JournalRequest = { profileId: "jacs", figureType: "single-column", scope: "document", resizeBonds: false };
export const initialCustomSettings = { fontFamily: "Arial, Helvetica, sans-serif", fontSizePt: 8, lineWidthPt: 0.6, bondLengthPt: 14.4 };
export function resolveJournalProfile(input: JournalRequest): JournalProfile {
  const request = JournalRequestSchema.parse(input);
  if (request.profileId !== "custom") {
    const profile = profiles.find(profile => profile.id === request.profileId);
    if (!profile) throw new Error("Unknown journal preset");
    return profile;
  }
  const c = request.custom!;
  const rule = (value: number | string, unit: "pt" | "font-stack") => ({ value, unit, relation: "exact" as const, sourceUrl: null, section: "User-defined setting" });
  return JournalProfileSchema.parse({ id: "custom", journalId: "custom", version: "1.0.0", checkedAt: new Date().toISOString().slice(0, 10), status: "custom",
    rules: { fontFamily: rule(c.fontFamily, "font-stack"), fontSize: rule(c.fontSizePt, "pt"), lineWidth: rule(c.lineWidthPt, "pt"), bondLength: rule(c.bondLengthPt, "pt") },
    figures: [{ id: "custom", label: "Custom figure", minWidthMm: null, maxWidthMm: null, maxHeightMm: null, minDpi: null, formats: null, sourceUrl: null, section: "User-defined" }],
    limitations: ["User-defined appearance. No journal requirements have been verified for these settings.", "Only molecule and plain-text styles are applied; review other objects and rich text manually."] });
}
