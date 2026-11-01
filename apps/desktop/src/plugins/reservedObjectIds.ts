/**
 * Ids this runtime has minted for proposals that have not landed yet.
 *
 * Module-scoped because the collision is across CALLS, not within one. Entries are never removed: an
 * accepted object puts its id in the document, where `nextObjectId` already sees it, and a rejected
 * one leaves a gap in the numbering, which costs nothing. The set is bounded by how many structures a
 * plugin builds in a session.
 */
export const RESERVED_PLUGIN_OBJECT_IDS = new Set<string>();
