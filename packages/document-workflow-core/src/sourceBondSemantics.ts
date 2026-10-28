export interface SourceBondSemantics {
  unspecifiedDoubleBondIndices: number[];
  dativeBondIndices: number[];
}

/** Read source CTAB semantics independently of the native depiction's stereo fields. */
export function sourceBondSemantics(molfile: string): SourceBondSemantics {
  const unspecifiedDoubleBondIndices: number[] = [];
  const dativeBondIndices: number[] = [];
  const lines = molfile.split(/\r?\n/);
  const v2000CountsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (v2000CountsIndex >= 0) {
    const counts = lines[v2000CountsIndex] ?? "";
    const atomCount = Number.parseInt(counts.slice(0, 3).trim(), 10);
    const bondCount = Number.parseInt(counts.slice(3, 6).trim(), 10);
    if (Number.isInteger(atomCount) && Number.isInteger(bondCount)) {
      const bondStart = v2000CountsIndex + 1 + atomCount;
      for (let index = 0; index < bondCount; index += 1) {
        const line = lines[bondStart + index] ?? "";
        const order = Number.parseInt(line.slice(6, 9).trim(), 10);
        const stereo = Number.parseInt(line.slice(9, 12).trim(), 10);
        if (order === 2 && stereo === 3) unspecifiedDoubleBondIndices.push(index);
      }
    }
    return { unspecifiedDoubleBondIndices, dativeBondIndices };
  }

  let inBondSection = false;
  let bondIndex = 0;
  for (const line of lines) {
    if (/^M\s+V30\s+BEGIN BOND\s*$/.test(line)) {
      inBondSection = true;
      continue;
    }
    if (/^M\s+V30\s+END BOND\s*$/.test(line)) {
      inBondSection = false;
      continue;
    }
    if (!inBondSection) continue;
    const match = /^M\s+V30\s+\d+\s+(\d+)\s+\d+\s+\d+\b(.*)$/.exec(line);
    if (!match) continue;
    const type = Number(match[1]);
    if (type === 9) dativeBondIndices.push(bondIndex);
    if (type === 2 && /\bCFG=2\b/.test(match[2] ?? "")) {
      unspecifiedDoubleBondIndices.push(bondIndex);
    }
    bondIndex += 1;
  }
  return { unspecifiedDoubleBondIndices, dativeBondIndices };
}

export function markV2000UnspecifiedDoubleBonds(
  molfile: string,
  indices: ReadonlySet<number>
): string {
  if (indices.size === 0) return molfile;
  const lines = molfile.split(/\r?\n/);
  const countsIndex = lines.findIndex((line) => /\bV2000\b/.test(line));
  if (countsIndex < 0) return molfile;
  const atomCount = Number.parseInt((lines[countsIndex] ?? "").slice(0, 3).trim(), 10);
  const bondCount = Number.parseInt((lines[countsIndex] ?? "").slice(3, 6).trim(), 10);
  if (!Number.isInteger(atomCount) || !Number.isInteger(bondCount)) return molfile;
  const bondStart = countsIndex + 1 + atomCount;
  for (const index of indices) {
    if (index < 0 || index >= bondCount) continue;
    const lineIndex = bondStart + index;
    const line = lines[lineIndex];
    if (!line || Number.parseInt(line.slice(6, 9).trim(), 10) !== 2) continue;
    lines[lineIndex] = `${line.slice(0, 9)}  3${line.slice(12)}`;
  }
  return lines.join(molfile.includes("\r\n") ? "\r\n" : "\n");
}

export function markV3000UnspecifiedDoubleBonds(
  molfile: string,
  indices: ReadonlySet<number>
): string {
  if (indices.size === 0) return molfile;
  const lines = molfile.split(/\r?\n/);
  let inBondSection = false;
  let bondIndex = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^M\s+V30\s+BEGIN BOND\s*$/.test(line)) {
      inBondSection = true;
      continue;
    }
    if (/^M\s+V30\s+END BOND\s*$/.test(line)) {
      inBondSection = false;
      continue;
    }
    if (!inBondSection || !/^M\s+V30\s+\d+\s+\d+\s+\d+\s+\d+\b/.test(line)) continue;
    if (indices.has(bondIndex) && !/\bCFG=/.test(line)) lines[index] = `${line} CFG=2`;
    bondIndex += 1;
  }
  return lines.join(molfile.includes("\r\n") ? "\r\n" : "\n");
}

