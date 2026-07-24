import type {
  PluginAnalysisQuery,
  PluginAnalysisRecord,
  PluginAnalysisRecordInput
} from "@chemdraft/plugin-api";
import { parsePluginAnalysisRecordInput } from "@chemdraft/plugin-api";

export interface AnalysisStoreOptions {
  /** Returns an ISO timestamp; the host passes its injectable clock. */
  now: () => string;
  /** Generates a record id; the host passes its injectable id factory. */
  createId: () => string;
  /** Fired after a successful write so subscribers (e.g. the desktop) can refresh. */
  onChange?: () => void;
}

interface StoredRecord {
  sequence: number;
  record: PluginAnalysisRecord;
}

/**
 * In-memory, session-scoped store for derived analysis records (ADR-0005). The host stamps id,
 * plugin id, and time; input is deep-copied on write and records are deep-copied on read, so a
 * caller can never mutate stored state through a retained reference. Unbounded by design — records
 * die with the session and never enter the native document.
 */
export class AnalysisStore {
  private readonly records: StoredRecord[] = [];
  private nextSequence = 0;

  constructor(private readonly options: AnalysisStoreOptions) {}

  write<TPayload>(pluginId: string, input: PluginAnalysisRecordInput<TPayload>): PluginAnalysisRecord<TPayload> {
    const parsedInput = parsePluginAnalysisRecordInput<TPayload>(input);
    const record: PluginAnalysisRecord<TPayload> = {
      ...structuredClone(parsedInput),
      id: this.options.createId(),
      pluginId,
      createdAt: this.options.now()
    };
    this.records.push({ sequence: this.nextSequence++, record: record as PluginAnalysisRecord });
    this.options.onChange?.();
    return structuredClone(record);
  }

  list<TPayload = unknown>(query: PluginAnalysisQuery = {}): readonly PluginAnalysisRecord<TPayload>[] {
    return this.records
      .filter((entry) => matchesQuery(entry.record, query))
      .sort((a, b) => a.sequence - b.sequence)
      .map((entry) => structuredClone(entry.record) as PluginAnalysisRecord<TPayload>);
  }

  getLatest<TPayload = unknown>(query: PluginAnalysisQuery = {}): PluginAnalysisRecord<TPayload> | undefined {
    let best: StoredRecord | undefined;
    for (const entry of this.records) {
      if (!matchesQuery(entry.record, query)) {
        continue;
      }
      if (best === undefined || isNewer(entry, best)) {
        best = entry;
      }
    }
    return best === undefined ? undefined : (structuredClone(best.record) as PluginAnalysisRecord<TPayload>);
  }
}

/** Newest by `createdAt`, with insertion sequence as a deterministic tie-breaker. */
function isNewer(candidate: StoredRecord, incumbent: StoredRecord): boolean {
  if (candidate.record.createdAt !== incumbent.record.createdAt) {
    return candidate.record.createdAt > incumbent.record.createdAt;
  }
  return candidate.sequence > incumbent.sequence;
}

/** Query fields are optional and conjunctive; identity fields match against the record's source. */
function matchesQuery(record: PluginAnalysisRecord, query: PluginAnalysisQuery): boolean {
  if (query.pluginId !== undefined && record.pluginId !== query.pluginId) {
    return false;
  }
  if (query.analysisType !== undefined && record.analysisType !== query.analysisType) {
    return false;
  }
  if (query.documentId !== undefined && record.source.documentId !== query.documentId) {
    return false;
  }
  if (query.pageId !== undefined && record.source.pageId !== query.pageId) {
    return false;
  }
  if (query.objectId !== undefined && record.source.objectId !== query.objectId) {
    return false;
  }
  return true;
}
