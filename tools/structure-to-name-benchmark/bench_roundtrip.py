"""Stage 2: round-trip every name back through OPSIN and score the result.

    python bench_roundtrip.py <stage1.tsv> <stage2.tsv> [--java PATH] [--opsin-jar PATH]

OPSIN is the structural oracle, and its limits are stated up front: agreement means the two engines
agree, not that the name is a PREFERRED IUPAC name. A name can round-trip perfectly and still be
non-preferred, clumsy, or non-compliant. Disagreement is the informative direction.

Outcome per structure:
  round-trip        canonical(OPSIN(name)) == canonical(input)
  stereo-lost       skeletons match with stereochemistry stripped, but not with it
  MISNAMED          OPSIN read the name as a DIFFERENT molecule -- the dangerous case
  name-unparseable  OPSIN could not read the name the namer produced
  declined          the namer produced no name (the safe failure)
  error             the namer raised
  unusable          the name held a tab or newline and was not sent to OPSIN

Both ends are canonicalised by THIS process's RDKit, from the input SMILES in column 2, so stage-1
files written by namers with different RDKit builds are scored alike. (In August both stages shared one
RDKit, so this is the same rule.)

OPSIN runs with its default flags (radical names are NOT read) unless --allow-radicals is given.

The Java runtime and the OPSIN jar come from --java / --opsin-jar, else the OPSIN_JAVA / OPSIN_JAR
environment variables. Use ChemDraft's vendored ones:
apps/desktop/src-tauri/resources/opsin/jre/bin/java and .../opsin/opsin-cli-2.9.0.jar.
"""
import argparse
import os
import subprocess
import sys

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")


def strip_stereo(smiles):
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    Chem.RemoveStereochemistry(mol)
    return Chem.MolToSmiles(mol)


def canonical(smiles):
    mol = Chem.MolFromSmiles(smiles)
    return Chem.MolToSmiles(mol) if mol is not None else None


def run_opsin(names, java, jar, allow_radicals=False):
    """One JVM for the whole batch. Output is one line per input line, order preserved."""
    if not names:
        return []
    payload = "\n".join(names) + "\n"
    proc = subprocess.run(
        [java, "-jar", jar, "-o", "smi", "-n", *(["-r"] if allow_radicals else [])],
        input=payload, capture_output=True, text=True, timeout=1800
    )
    lines = proc.stdout.split("\n")
    # Trailing newline yields a final empty element; drop it without truncating real output.
    if lines and lines[-1] == "":
        lines.pop()
    if len(lines) != len(names):
        raise RuntimeError(
            f"OPSIN output line count mismatch: {len(names)} names in, {len(lines)} lines out"
        )
    # Empty first field = OPSIN could not parse that name. Exit code is 0 either way.
    return [line.split("\t")[0].strip() for line in lines]


def score(canon_in, smiles):
    """The August rule, unchanged."""
    if not smiles:
        return "name-unparseable"
    canon_out = canonical(smiles)
    if canon_out is None:
        return "name-unparseable"
    if canon_out == canon_in:
        return "round-trip"
    a, b = strip_stereo(canon_in), strip_stereo(canon_out)
    return "stereo-lost" if (a is not None and a == b) else "MISNAMED"


def read_stage1(path):
    rows = []
    with open(path) as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 7:
                parts += [""] * (7 - len(parts))
            rows.append(parts[:7])
    return rows


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("stage1")
    parser.add_argument("out")
    parser.add_argument("--java", default=os.environ.get("OPSIN_JAVA"))
    parser.add_argument("--opsin-jar", default=os.environ.get("OPSIN_JAR"))
    parser.add_argument("--allow-radicals", action="store_true",
                        help="let OPSIN read radical names (its -r flag). OFF by default, as in August, so "
                             "the headline numbers stay comparable; a correct radical name such as "
                             "'(2,2,6,6-tetramethylpiperidin-1-yl)oxyl' then scores name-unparseable")
    args = parser.parse_args(argv)
    if not args.java or not args.opsin_jar:
        parser.error("give --java and --opsin-jar (or set OPSIN_JAVA and OPSIN_JAR)")

    rows = read_stage1(args.stage1)
    named = [r for r in rows if r[3] == "named"]
    print(f"round-tripping {len(named)} names through OPSIN...", file=sys.stderr)
    produced = run_opsin([r[4] for r in named], args.java, args.opsin_jar, args.allow_radicals)
    by_id = {row[0]: smiles for row, smiles in zip(named, produced)}

    with open(args.out, "w") as out:
        out.write("id\tcanonical_input\tstatus\tname\topsin_smiles\toutcome\tseconds\tnamer_meta\n")
        for ident, src, canon_stage1, status, name, seconds, meta in rows:
            canon_in = canonical(src) or canon_stage1
            if status != "named":
                out.write(f"{ident}\t{canon_in}\t{status}\t{name}\t\t{status}\t{seconds}\t{meta}\n")
                continue
            smiles = by_id.get(ident, "")
            outcome = score(canon_in, smiles)
            out.write(f"{ident}\t{canon_in}\t{status}\t{name}\t{smiles}\t{outcome}\t{seconds}\t{meta}\n")

    print("stage 2 done", file=sys.stderr)


if __name__ == "__main__":
    main()
