"""Was a "relocated" site really the SAME ionization event, or is the audit crediting itself?

The recall audit credits a miss as `same-event-relocated` when canonicalization took the proton off the
labelled atom and the app reported a site on an atom that GAINED it. That is proton bookkeeping, and an
adversarial review was right that bookkeeping alone can flatter: a proton landing somewhere else does not
by itself mean the same acid is being described.

There is a stronger test available, and it costs nothing extra, because 8,074 of the 12,096 corpus rows
record the CONJUGATE BASE. The labelled event is fully specified as `acid -> base`. So:

    deprotonate the atom the app reported, in the structure the app actually scored,
    and ask whether the result is the species the label calls the base

If it is, the app described the labelled equilibrium and the atom index is a bookkeeping difference. If it
is not, the app described a different reaction and the credit is unearned -- which is the failure mode this
project already ruled on once, when histidine's amine was handed 9.03 against a measured 9.25 and read as
correct while describing a different reaction.

Compared on the InChIKey SKELETON block, which is insensitive to where a mobile proton sits, so two
drawings of one anion agree. Full canonical SMILES equality is reported separately as the strict form.

    python3 relocation_audit.py <site-classification.json> merged-labels.json
"""
import collections
import json
import sys

from rdkit import Chem, RDLogger
from rdkit.Chem import inchi

RDLogger.DisableLog("rdApp.*")


def deprotonated(smiles, index):
    """Remove one hydrogen from `index` and drop the charge by one. Atom order is preserved."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None or index >= mol.GetNumAtoms():
        return None
    edit = Chem.RWMol(mol)
    atom = edit.GetAtomWithIdx(index)
    total = atom.GetTotalNumHs()
    if total < 1:
        return None
    atom.SetNumExplicitHs(max(0, atom.GetNumExplicitHs() - 1) if atom.GetNumExplicitHs() else 0)
    atom.SetNoImplicit(True)
    atom.SetFormalCharge(atom.GetFormalCharge() - 1)
    if atom.GetNumExplicitHs() == 0 and total > 1:
        atom.SetNumExplicitHs(total - 1)
    out = edit.GetMol()
    try:
        Chem.SanitizeMol(out)
    except Exception:
        return None
    return out


def skeleton(mol):
    """First block of the standard InChIKey: the connectivity, without the proton layer."""
    if mol is None:
        return None
    try:
        key = inchi.MolToInchiKey(mol)
    except Exception:
        return None
    return key.split("-")[0] if key else None


def main(dump_path, labels_path):
    records = json.load(open(dump_path))
    corpus = {}
    for row in json.load(open(labels_path)):
        corpus[(row["acid"], row["acidAtomIdx"], float(row["pKa"]))] = row

    relocated = [r for r in records if r["verdict"] == "same-event-relocated"]
    print(f"{len(records)} classified rows, {len(relocated)} credited as same-event-relocated\n")

    verdicts = collections.Counter()
    failures = []
    for r in relocated:
        row = corpus.get((r["smiles"], r["site"], float(r["pKa"])))
        if row is None or not row.get("base"):
            verdicts["no base recorded -- cannot verify"] += 1
            continue
        want = skeleton(Chem.MolFromSmiles(row["base"]))
        # The app's own claim: a site on one of the atoms that gained the proton.
        gained = [g for g in (r.get("gainedProton") or []) if g in set(r.get("reported") or [])]
        got = None
        for g in gained:
            # Deprotonate in the DRAWN frame -- indices are stable through both derivations, verified
            # separately, and this corpus is single-fragment so the frames coincide.
            candidate = deprotonated(r["smiles"], g)
            if candidate is None:
                continue
            if skeleton(candidate) == want:
                got = g
                break
        if got is not None:
            verdicts["SAME conjugate base -- credit earned"] += 1
        elif not gained:
            verdicts["no reported site on a proton-gaining atom"] += 1
        else:
            verdicts["DIFFERENT conjugate base -- credit UNEARNED"] += 1
            if len(failures) < 12:
                failures.append(f"{r['smiles']} @{r['site']} pKa {r['pKa']} "
                                f"reported {r.get('reported')} gained {r.get('gainedProton')} "
                                f"base {row['base']}")

    total = sum(verdicts.values())
    print(f"{'outcome':46s} {'n':>5s} {'share':>7s}")
    for name, n in verdicts.most_common():
        print(f"  {name:44s} {n:5d} {100*n/max(1,total):6.1f}%")
    if failures:
        print("\nunearned credits:")
        for line in failures:
            print("   " + line)

    earned = verdicts["SAME conjugate base -- credit earned"]
    print(f"\n-> of the relocation credits that can be verified, {earned} describe the labelled "
          f"equilibrium.")
    print("   Any 'DIFFERENT' row must be reclassified as a failure: a right-looking number for the "
          "wrong reaction")
    print("   is the error this project already ruled on with histidine.")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
