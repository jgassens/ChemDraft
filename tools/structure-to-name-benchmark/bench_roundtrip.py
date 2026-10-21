"""Stage 2: round-trip every OpenClatura name back through OPSIN and score the result.

OPSIN is the structural oracle, and its limits are stated up front: agreement means the two engines
agree, not that the name is a PREFERRED IUPAC name. A name can round-trip perfectly and still be
non-preferred, clumsy, or non-compliant. Disagreement is the informative direction.

Outcome per structure:
  round-trip        canonical(OPSIN(name)) == canonical(input)
  stereo-lost       skeletons match with stereochemistry stripped, but not with it
  MISNAMED          OPSIN read the name as a DIFFERENT molecule -- the dangerous case
  name-unparseable  OPSIN could not read the name OpenClatura produced
  declined          OpenClatura produced no name (the safe failure)
  error             OpenClatura raised
"""
import subprocess, sys
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")

JAVA = "/Users/jeremiahgassensmith/programming/chemdraft-analyzers/apps/desktop/src-tauri/resources/opsin/jre/bin/java"
JAR = "/Users/jeremiahgassensmith/programming/chemdraft-analyzers/apps/desktop/src-tauri/resources/opsin/opsin-cli-2.9.0.jar"


def strip_stereo(smiles):
    mol = Chem.MolFromSmiles(smiles)
    if mol is None:
        return None
    Chem.RemoveStereochemistry(mol)
    return Chem.MolToSmiles(mol)


def canonical(smiles):
    mol = Chem.MolFromSmiles(smiles)
    return Chem.MolToSmiles(mol) if mol is not None else None


def run_opsin(names):
    """One JVM for the whole batch. Output is one line per input line, order preserved."""
    payload = "\n".join(names) + "\n"
    proc = subprocess.run(
        [JAVA, "-jar", JAR, "-o", "smi", "-n"],
        input=payload, capture_output=True, text=True, timeout=1800
    )
    lines = proc.stdout.split("\n")
    # Trailing newline yields a final empty element; drop it without truncating real output.
    if lines and lines[-1] == "":
        lines.pop()
    if len(lines) != len(names):
        print(f"WARNING: {len(names)} names in, {len(lines)} lines out", file=sys.stderr)
    # Empty first field = OPSIN could not parse that name. Exit code is 0 either way.
    return [line.split("\t")[0].strip() for line in lines]


def main(stage1_path, out_path):
    rows = []
    with open(stage1_path) as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 5:
                parts += [""] * (5 - len(parts))
            rows.append(parts[:5])

    named = [r for r in rows if r[3] == "named"]
    print(f"round-tripping {len(named)} names through OPSIN...", file=sys.stderr)
    produced = run_opsin([r[4] for r in named])

    by_id = {}
    for row, smiles in zip(named, produced):
        by_id[row[0]] = smiles

    with open(out_path, "w") as out:
        out.write("id\tcanonical_input\tstatus\tname\topsin_smiles\toutcome\n")
        for ident, _src, canon_in, status, name in rows:
            if status != "named":
                out.write(f"{ident}\t{canon_in}\t{status}\t{name}\t\t{status}\n")
                continue
            smiles = by_id.get(ident, "")
            if not smiles:
                outcome = "name-unparseable"
            else:
                canon_out = canonical(smiles)
                if canon_out is None:
                    outcome = "name-unparseable"
                elif canon_out == canon_in:
                    outcome = "round-trip"
                else:
                    a, b = strip_stereo(canon_in), strip_stereo(canon_out)
                    outcome = "stereo-lost" if (a is not None and a == b) else "MISNAMED"
            out.write(f"{ident}\t{canon_in}\t{status}\t{name}\t{smiles}\t{outcome}\n")

    print("stage 2 done", file=sys.stderr)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
