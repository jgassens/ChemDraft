"""Turn the AQUEOUS rows of D2A-pKa into per-site training labels.

D2A-pKa (Zenodo 15277342, CC BY 4.0; "Solvation free energies of anions: from curated reference data to
predictive models") ships 8,241 experimental values across eight solvents as `acid>>base` reaction
SMILES — the same shape as Dwar-iBond and pKaCHU, so `changed_atom` reads it unmodified.

**Only water is taken, and that is a hard filter rather than a preference.** 3,796 of the rows are
aqueous; the other 4,445 are DMSO, acetonitrile, DMF, methanol, ethanol, NMP and ethylene glycol. This
method's contract says aqueous at room temperature, and a DMSO pKa is a different number for the same
molecule — often by more than ten log units. Pooling them would be the single fastest way to make every
value here quietly wrong.

**What it is good for, and what it is not.** Every aqueous row is a NEUTRAL ACID losing a proton: 3,722
acidic labels and zero basic ones. So it cannot touch this model's known weakness, which is weakly
basic ring nitrogens in fused heterocycles. What it does bring is range and unusual chemistry — its
values run -3.88 to 16.90 where pKaCHU is windowed to 2-12, and it carries 252 carbon-centred and 141
sulfur-centred sites, the classes this model measures worst (C+0 on saturated carbon, MAE 4.14).

    python3 d2a_labels.py D2A-pKa.csv <existing-labels.json> d2a-labels.json
"""
import ast
import csv
import json
import sys

from rdkit import Chem, RDLogger

from pka_labels import changed_atom
from parity_features import written_smiles_with_site

RDLogger.DisableLog("rdApp.*")

# SMILES for water. Anything else is a different solvent and a different number.
WATER = "O"

# Replicates further apart than this disagree about what was measured rather than scatter around it.
MAX_REPLICATE_SPREAD = 1.0


def extract(src, existing_path):
    known = {}
    if existing_path:
        for row in json.load(open(existing_path)):
            mol = Chem.MolFromSmiles(row["acid"])
            if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
                continue
            smiles, site = written_smiles_with_site(mol, row["acidAtomIdx"])
            if smiles is not None:
                known[(smiles, site)] = row["pKa"]

    kept, stats, seen = [], {}, {}

    def drop(reason):
        stats[reason] = stats.get(reason, 0) + 1

    for row in csv.DictReader(open(src)):
        if (row.get("solvent_smiles") or "").strip() != WATER:
            drop("not aqueous"); continue

        field = (row.get("reaction_smiles") or "").strip()
        if field.count(">>") != 1:
            drop("not a single acid/base pair"); continue
        acid_s, base_s = (part.strip() for part in field.split(">>"))

        try:
            replicates = [float(v) for v in ast.literal_eval(row["pka_vals"])]
        except Exception:
            try:
                replicates = [float(row["pKa_avg"])]
            except Exception:
                drop("unreadable value"); continue
        if not replicates:
            drop("no values"); continue
        if max(replicates) - min(replicates) > MAX_REPLICATE_SPREAD:
            drop("replicates disagree by more than 1.0"); continue
        pka = sum(replicates) / len(replicates)

        idx, acid, _base = changed_atom(acid_s, base_s)
        if idx is None:
            drop("not exactly one changed atom"); continue

        canonical, site = written_smiles_with_site(acid, idx)
        if canonical is None:
            drop("site atom is not written to SMILES"); continue
        key = (canonical, site)
        if key in known:
            drop("already covered by an existing label"); continue
        if key in seen:
            if abs(seen[key] - pka) > 0.5:
                drop("conflicting duplicate within D2A")
            else:
                drop("duplicate within D2A")
            continue
        seen[key] = pka

        kept.append({
            "acid": acid_s,
            "base": base_s,
            "acidAtomIdx": idx,
            "pKa": round(pka, 4),
            "replicates": len(replicates),
            "ref": row.get("original_source", ""),
            "label_source": "d2a-pka aqueous (experimental; site diffed from the acid/base pair)",
        })

    return kept, stats


def main(src, existing_path, out):
    kept, stats = extract(src, existing_path)
    json.dump(kept, open(out, "w"))
    print(f"kept {len(kept)} per-site labels (aqueous only)")
    for reason, count in sorted(stats.items(), key=lambda kv: -kv[1]):
        print(f"   dropped {count:5d}  {reason}")
    if kept:
        values = [row["pKa"] for row in kept]
        print(f"   pKa range {min(values):.2f} .. {max(values):.2f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if sys.argv[2] != "-" else None, sys.argv[3])
