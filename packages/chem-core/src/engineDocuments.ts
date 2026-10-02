import type { ChemDraftDocument } from "./schemas";

/**
 * Documents the patch engine produced. Their every object was validated when it entered, so a later
 * patch need only validate what it changes, and a serializer need not re-parse them. Anything else —
 * a document built by hand, or taken from elsewhere — is deep-copied and fully validated first,
 * exactly as every patch used to be. Its own module so `document.ts` (which `patches.ts` imports) can
 * read it too.
 */
export const engineDocuments = new WeakSet<ChemDraftDocument>();
