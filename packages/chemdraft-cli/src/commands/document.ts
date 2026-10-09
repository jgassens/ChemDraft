import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { serializeDocument } from "@chemdraft/chem-core";
import { documentInventory, pastedStructureDepictionFromMolfile } from "@chemdraft/document-workflow-core";
import { ensureRdkit } from "@chemdraft/rdkit-adapter";
import { numericOption, parseOptions, stringOption } from "../args";
import { buildSmilesDocument, type BuiltSmilesDocument } from "../document";
import { validateDocumentOutputPath } from "../documentInput";
import { CliUsageError, cliExitCode, defaultCliIo, handleCliError, parseNamedSmilesJob,
  readBatchFile, resultExitCode, writeJsonLine, writeProgress, type CliIo } from "../output";

const documentOptions = {
  "--smiles": { kind: "value" }, "--batch": { kind: "value" },
  "--out": { kind: "value" }, "--out-dir": { kind: "value" },
  "--bond-length": { kind: "value" }, "--help": { kind: "boolean" }
} as const;

export const documentHelp = `Build an editable ChemDraft native document and report atom, bond and ring ids.
Usage:
  pnpm -s chemdraft document --smiles <SMILES> --out <doc.json> [--bond-length <px>]
  pnpm -s chemdraft document --batch <jobs.json> --out-dir <dir> [--bond-length <px>]
Batch: [{"name":"decalin","smiles":"C1CCC2CCCCC2C1"}].
inputAtomIndex is the 0-based SMILES atom token index, or null when no verified mapping exists.
Exit 0 all jobs succeeded, 1 a job failed, 2 invalid arguments or batch input.`;

/** RDKit keeps SMILES parse order during depiction. Verify it against the actual native graph.
 * This token scan only locates input indices; chemical parsing remains the engine's job.
 * OCL fallback order and partially retained explicit H are deliberately left unmapped.
 */
async function inputAtomIndices(built: BuiltSmilesDocument): Promise<(number | null)[]> {
  const unmapped = built.molecule.atoms.map(() => null);
  if (built.engine !== "rdkit") return unmapped;
  const tokens = [...built.smiles.matchAll(/\[[^\]]+\]|Br|Cl|[BCNOPSFIbcnops*]/g)];
  const input = tokens.map((token, index) => {
    const element = token[0].startsWith("[")
      ? /^\[\d*([A-Z][a-z]?|[a-z]+|\*)/.exec(token[0])?.[1] ?? "?"
      : token[0];
    return { element: element[0]!.toUpperCase() + element.slice(1), index };
  });
  const elements = built.molecule.atoms.map((atom) => atom.element);
  const sameElements = (entries: typeof input) => entries.length === elements.length &&
    entries.every((entry, index) => entry.element === elements[index]);
  const mapped = sameElements(input) ? input : input.filter((entry) => entry.element !== "H");
  if (!sameElements(mapped)) return unmapped;
  const module = await ensureRdkit();
  const source = module.get_mol(built.smiles);
  try {
    const molfile = source?.get_molblock?.();
    if (!molfile) return unmapped;
    const graph = pastedStructureDepictionFromMolfile(molfile);
    if (graph.atoms.length !== elements.length ||
        !graph.atoms.every((atom, index) => atom.element === elements[index]) ||
        graph.bonds.length !== built.molecule.bonds.length ||
        !graph.bonds.every((bond, index) => {
          const native = built.molecule.bonds[index]!;
          return native.fromAtomId === built.molecule.atoms[bond.from]?.id &&
            native.toAtomId === built.molecule.atoms[bond.to]?.id && native.order === bond.order;
        })) return unmapped;
    return mapped.map((entry) => entry.index);
  } finally { source?.delete(); }
}

export async function runDocumentCommand(argv: readonly string[], io: CliIo = defaultCliIo) {
  try {
    if (argv.includes("--help")) { io.stdout(documentHelp); return cliExitCode.ok; }
    const parsed = parseOptions(argv, documentOptions);
    if (parsed.positionals.length) throw new CliUsageError(`Unknown argument "${parsed.positionals[0]}".`);
    const smiles = stringOption(parsed, "--smiles"), batch = stringOption(parsed, "--batch");
    const out = stringOption(parsed, "--out"), outDir = stringOption(parsed, "--out-dir");
    if (Number(smiles !== undefined) + Number(batch !== undefined) !== 1) {
      throw new CliUsageError("Provide exactly one of --smiles or --batch.");
    }
    if (smiles !== undefined ? (!out || outDir !== undefined) : (!outDir || out !== undefined)) {
      throw new CliUsageError("Single mode requires --out; batch mode requires --out-dir.");
    }
    const bondLengthValue = stringOption(parsed, "--bond-length");
    const bondLength = bondLengthValue === undefined ? undefined : numericOption(bondLengthValue, "--bond-length");
    const jobs = smiles !== undefined
      ? [{ name: basename(out!, ".json"), smiles }]
      : await readBatchFile(batch!, parseNamedSmilesJob, (job) => {
          if (!job.smiles.trim()) throw new CliUsageError(`Batch job "${job.name}" has an empty SMILES.`);
        });
    const files = jobs.map((job) => out ?? join(outDir!, `${job.name}.json`));
    files.forEach(validateDocumentOutputPath);
    let allSucceeded = true;
    for (const [index, job] of jobs.entries()) {
      writeProgress(io, `Building document ${job.name}…`);
      try {
        const built = await buildSmilesDocument(job.smiles, { name: job.name, bondLength });
        const indices = await inputAtomIndices(built);
        const inventory = documentInventory(built.document, new Map([[built.molecule.id, indices]]));
        const file = files[index]!;
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, serializeDocument(built.document));
        writeJsonLine(io, { name: job.name, smiles: built.smiles, ok: true, document: file,
          files: [file], ...inventory, engine: built.engine, canonicalSmiles: built.sourceCanonicalSmiles,
          warnings: [...built.warnings, ...(indices.some((value) => value === null)
            ? ["Input atom mapping unavailable; inputAtomIndex is null for unmapped atoms."] : [])] });
      } catch (error) {
        allSucceeded = false;
        writeJsonLine(io, { name: job.name, smiles: job.smiles, ok: false,
          error: error instanceof Error ? error.message : String(error) });
      }
    }
    return resultExitCode(allSucceeded);
  } catch (error) { return handleCliError(error, io, "document"); }
}

export const documentCommand = {
  name: "document", summary: "Build native document JSON with editable ids and ring centers.", run: runDocumentCommand
} as const;
