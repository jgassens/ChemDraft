/**
 * Minimal NMReDATA/SDF parsing shared by the database compiler (`buildDatabase.ts`) and the
 * leakage-free benchmark (`benchmark.ts`). Pure string handling — no OCL — so both consumers apply
 * identical record semantics to the same raw export.
 */

export interface NmredataAssignment {
  label: string;
  shift: number;
  /** 1-based molfile atom indices. */
  atoms: number[];
}

export interface NmredataRecord {
  /** The raw record text (molfile + tags), reusable to reassemble a training corpus. */
  raw: string;
  molfile: string;
  assignments: NmredataAssignment[];
  carbonLabels: Set<string>;
  protonLabels: Set<string>;
}

/** Split an SD export into records and parse the NMReDATA tags of each usable one. Records without
 * a molfile or without assignments are dropped — exactly what the compiler ignores. */
export function parseNmredataRecords(sdContent: string): NmredataRecord[] {
  const records: NmredataRecord[] = [];
  for (const raw of splitRecords(sdContent)) {
    const molfile = extractMolfile(raw);
    if (!molfile) {
      continue;
    }
    const assignments = parseAssignments(raw);
    if (assignments.length === 0) {
      continue;
    }
    records.push({
      raw,
      molfile,
      assignments,
      carbonLabels: parseSpectrumLabels(raw, "NMREDATA_1D_13C"),
      protonLabels: parseSpectrumLabels(raw, "NMREDATA_1D_1H")
    });
  }
  return records;
}

export function splitRecords(content: string): string[] {
  return content.split(/^\$\$\$\$\s*$/m).filter((record) => record.trim().length > 0);
}

export function extractMolfile(record: string): string | undefined {
  const end = record.indexOf("M  END");
  if (end < 0) {
    return undefined;
  }
  // Anchor on the V2000/V3000 counts line and reconstruct the 4-line header from there, so a stray
  // leading newline from record splitting can't misalign the header (which silently yields 0 atoms).
  const lines = record.slice(0, end + "M  END".length).split("\n");
  const countsIndex = lines.findIndex((line) => /V2000|V3000/.test(line));
  if (countsIndex < 3) {
    return undefined;
  }
  return lines.slice(countsIndex - 3).join("\n");
}

export function parseAssignments(record: string): NmredataAssignment[] {
  const block = extractTag(record, "NMREDATA_ASSIGNMENT");
  if (!block) {
    return [];
  }
  const assignments: NmredataAssignment[] = [];
  for (const raw of block.split("\n")) {
    const line = raw.replace(/\\\s*$/, "").trim();
    if (!line) {
      continue;
    }
    const parts = line.split(",");
    if (parts.length < 3) {
      continue;
    }
    const label = parts[0].trim();
    const shift = Number(parts[1].trim());
    if (!Number.isFinite(shift)) {
      continue;
    }
    const atoms = parts
      .slice(2)
      .join(" ")
      .trim()
      .split(/[\s,]+/)
      .map(Number)
      .filter((value) => Number.isInteger(value) && value > 0);
    if (atoms.length === 0) {
      continue;
    }
    assignments.push({ label, shift, atoms });
  }
  return assignments;
}

export function parseSpectrumLabels(record: string, tag: string): Set<string> {
  const block = extractTag(record, tag);
  const labels = new Set<string>();
  if (block) {
    for (const match of block.matchAll(/L=(\w+)/g)) {
      labels.add(match[1]);
    }
  }
  return labels;
}

function extractTag(record: string, tag: string): string | undefined {
  const match = record.match(new RegExp(`>\\s*<${tag}>\\s*\\n([\\s\\S]*?)(?:\\n\\n|\\n>|$)`));
  return match?.[1];
}
