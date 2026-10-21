"""Stage 3: compare scored runs of several namers on the same corpus.

    python compare.py --out-dir DIR LABEL=stage2.tsv [LABEL=stage2.tsv ...]

Writes, into DIR:
  summary.csv          per namer: counts of every outcome, round-trip rates, timing
  outcomes.csv         per structure, each namer's outcome
  misnamed-any.csv     every structure ANY namer misnamed, with what each namer did with it
  elements.csv         per namer, outcomes for structures holding each element outside C H N O S P
                       F Cl Br I (the August arsenic table, for every element)
  stereo.csv           per namer, outcomes for inputs that carry stereochemistry
  provenance.csv       per namer that reports provenance (Orthonym), its own verdict crossed with
                       ours: where the namer's validation and this oracle disagree
and prints the same tables as Markdown.

Misnames are also classified by what happened to the atoms (the August categories): the molecular
formula of OPSIN's structure against the input's, counting isotopes and hydrogens. A misname whose
structure has the same standard InChI as the input (a resonance form, a mobile-H tautomer, or a
zwitterion read as its neutral form) gets its own class, "same standard InChI", ahead of the others.
August's categoriser was not committed; this one reproduces its "atoms dropped" count (14) for 0.2.0
and splits the rest slightly differently.
"""
import argparse
import csv
import json
import os
import statistics
from collections import Counter, defaultdict

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")

OUTCOMES = ["round-trip", "stereo-lost", "MISNAMED", "name-unparseable", "declined", "error", "unusable"]
COMMON = {"C", "H", "N", "O", "S", "P", "F", "Cl", "Br", "I"}


def read_stage2(path):
    with open(path) as handle:
        return list(csv.DictReader(handle, delimiter="\t", quoting=csv.QUOTE_NONE))


def atom_counts(smiles):
    mol = Chem.MolFromSmiles(smiles) if smiles else None
    if mol is None:
        return None
    counts = Counter()
    for atom in Chem.AddHs(mol).GetAtoms():
        iso = atom.GetIsotope()
        counts[f"{iso}{atom.GetSymbol()}" if iso else atom.GetSymbol()] += 1
    return counts


def std_inchi(smiles):
    mol = Chem.MolFromSmiles(smiles) if smiles else None
    return Chem.MolToInchi(mol) if mol is not None else None


def misname_kind(canon_in, opsin_smiles):
    a, b = atom_counts(canon_in), atom_counts(opsin_smiles)
    if a is None or b is None:
        return "unclassified"
    if std_inchi(canon_in) == std_inchi(opsin_smiles):
        # Standard InChI does not separate resonance forms of a delocalised ion, mobile-H tautomers, or a
        # zwitterion from its neutral form. Still a MISNAMED by the oracle (formal charges or H moved).
        return "same standard InChI"
    if a == b:
        return "same formula, different connectivity"
    keys = set(a) | set(b)
    if all(b[k] <= a[k] for k in keys):
        return "atoms dropped"
    if all(b[k] >= a[k] for k in keys):
        return "atoms invented"
    return "formula changed in both directions"


def elements_of(smiles):
    mol = Chem.MolFromSmiles(smiles) if smiles else None
    return {atom.GetSymbol() for atom in mol.GetAtoms()} if mol is not None else set()


def has_stereo(smiles):
    mol = Chem.MolFromSmiles(smiles) if smiles else None
    if mol is None:
        return False
    for atom in mol.GetAtoms():
        if atom.GetChiralTag() != Chem.ChiralType.CHI_UNSPECIFIED:
            return True
    return any(b.GetStereo() != Chem.BondStereo.STEREONONE for b in mol.GetBonds())


def pct(n, d):
    return f"{100 * n / d:.2f}%" if d else "n/a"


def md_table(header, rows):
    lines = ["| " + " | ".join(header) + " |", "|" + "|".join("---" for _ in header) + "|"]
    lines += ["| " + " | ".join(str(c) for c in row) + " |" for row in rows]
    return "\n".join(lines)


def write_csv(path, header, rows):
    with open(path, "w", newline="") as handle:
        writer = csv.writer(handle, lineterminator="\n")
        writer.writerow(header)
        writer.writerows(rows)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("runs", nargs="+", help="LABEL=stage2.tsv")
    args = parser.parse_args(argv)
    os.makedirs(args.out_dir, exist_ok=True)

    runs = {}
    for spec in args.runs:
        label, path = spec.split("=", 1)
        runs[label] = {row["id"]: row for row in read_stage2(path)}
    labels = list(runs)
    ids = list(next(iter(runs.values())))

    # Summary.
    summary = []
    for label in labels:
        rows = runs[label].values()
        counts = Counter(row["outcome"] for row in rows)
        n = len(runs[label])
        named = sum(counts[o] for o in ("round-trip", "stereo-lost", "MISNAMED", "name-unparseable"))
        secs = [float(row["seconds"]) for row in rows if row.get("seconds")]
        summary.append([
            label, n, *[counts[o] for o in OUTCOMES],
            pct(counts["round-trip"], n), pct(counts["round-trip"], named), pct(counts["declined"], n),
            pct(counts["MISNAMED"], n),
            f"{sum(secs):.1f}" if secs else "",
            f"{statistics.median(secs) * 1000:.1f}" if secs else "",
            f"{sorted(secs)[int(0.95 * (len(secs) - 1))] * 1000:.0f}" if secs else "",
            f"{max(secs):.2f}" if secs else "",
        ])
    header = ["namer", "n", *OUTCOMES, "round-trip % of all", "round-trip % of named", "declined %",
              "misnamed %", "namer seconds total", "median ms", "p95 ms", "max s"]
    write_csv(os.path.join(args.out_dir, "summary.csv"), header, summary)
    print("## Summary\n")
    print(md_table(header, summary))

    # Per structure, every namer's outcome (the raw stage-2 files hold the names; this is the compact form).
    write_csv(os.path.join(args.out_dir, "outcomes.csv"), ["id", "canonical_input", *labels],
              [[ident, next(runs[l][ident]["canonical_input"] for l in labels if ident in runs[l]),
                *[runs[l].get(ident, {}).get("outcome", "") for l in labels]] for ident in ids])

    # Misnamed by any namer, with what each did.
    kinds = defaultdict(Counter)
    any_rows = []
    for ident in ids:
        if not any(runs[label].get(ident, {}).get("outcome") == "MISNAMED" for label in labels):
            continue
        canon = next(runs[label][ident]["canonical_input"] for label in labels if ident in runs[label])
        row = [ident, canon]
        for label in labels:
            r = runs[label].get(ident)
            if r is None:
                row += ["", "", ""]
                continue
            kind = ""
            if r["outcome"] == "MISNAMED":
                kind = misname_kind(r["canonical_input"], r["opsin_smiles"])
                kinds[label][kind] += 1
            row += [r["outcome"], r["name"], kind]
        any_rows.append(row)
    header = ["id", "canonical_input"]
    for label in labels:
        header += [f"{label} outcome", f"{label} name", f"{label} misname kind"]
    write_csv(os.path.join(args.out_dir, "misnamed-any.csv"), header, any_rows)
    print(f"\n## Misnamed by any namer: {len(any_rows)} structures\n")
    for label in labels:
        print(f"- {label}: " + ", ".join(f"{k} {v}" for k, v in kinds[label].most_common()))

    # Elements outside the common set.
    per_element = defaultdict(lambda: defaultdict(Counter))
    for label in labels:
        for row in runs[label].values():
            for element in elements_of(row["canonical_input"]) - COMMON:
                per_element[element][label][row["outcome"]] += 1
    erows = []
    for element in sorted(per_element, key=lambda e: -sum(per_element[e][labels[0]].values())):
        for label in labels:
            c = per_element[element][label]
            erows.append([element, label, sum(c.values()), c["round-trip"], c["MISNAMED"], c["declined"],
                          c["name-unparseable"], c["error"], c["stereo-lost"]])
    header = ["element", "namer", "n", "round-trip", "MISNAMED", "declined", "name-unparseable", "error",
              "stereo-lost"]
    write_csv(os.path.join(args.out_dir, "elements.csv"), header, erows)
    print("\n## Elements outside C H N O S P halogens (rows with any misname)\n")
    print(md_table(header, [r for r in erows if any(
        x[4] for x in erows if x[0] == r[0])]))

    # Stereo-bearing inputs.
    srows = []
    for label in labels:
        c = Counter(row["outcome"] for row in runs[label].values() if has_stereo(row["canonical_input"]))
        srows.append([label, sum(c.values()), *[c[o] for o in OUTCOMES]])
    header = ["namer", "inputs with stereo", *OUTCOMES]
    write_csv(os.path.join(args.out_dir, "stereo.csv"), header, srows)
    print("\n## Inputs carrying stereochemistry\n")
    print(md_table(header, srows))

    # The namer's own validation against this oracle.
    prow = []
    for label in labels:
        cross = Counter()
        for row in runs[label].values():
            if not row.get("namer_meta"):
                continue
            meta = json.loads(row["namer_meta"])
            cross[(meta.get("tier"), meta.get("opsin"), meta.get("gate_outcome"), row["outcome"])] += 1
        for (tier, opsin, gate, outcome), n in sorted(cross.items(), key=lambda kv: (-kv[1], str(kv[0]))):
            prow.append([label, tier, opsin, gate, outcome, n])
    if prow:
        header = ["namer", "tier", "opsin", "gate_outcome", "our outcome", "n"]
        write_csv(os.path.join(args.out_dir, "provenance.csv"), header, prow)
        print("\n## Namer's own verdict against the oracle\n")
        print(md_table(header, prow))


if __name__ == "__main__":
    main()
