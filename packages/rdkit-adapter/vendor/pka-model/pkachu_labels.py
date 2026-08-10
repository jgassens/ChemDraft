"""Turn pKaCHU rows into per-site training labels.

pKaCHU (Zenodo 20089807, CC BY 4.0; "Unifying pKa and Protonation Prediction with Sequence-based Deep
Learning") ships 9,000 EXPERIMENTAL aqueous microscopic pKa values already in the shape this project
wants: `acid_smiles>>base_smiles`, a pair of microstates differing at one atom, with the replicate
measurements preserved rather than only their mean.

That is the same shape as Dwar-iBond, so the site-diffing logic is imported rather than rewritten --
`changed_atom` finds the single atom whose (element, charge, hydrogen count) differs, and returns an
index into the parse order of the ORIGINAL acid string. The original string is what gets stored, never
a canonical rewrite, because `MolToSmiles` reorders atoms and an index taken before that points at a
different atom afterwards. That mistake mis-sited 27.7% of the QupKake labels.

Two things this file adds beyond the Dwar-iBond path:

**The `prefix` column is a free cross-check.** It says whether the ionizing group is a protonated
cation (`Prot`) or a neutral acid (`Deprot`), which must agree with the changed atom's formal charge
in the acid. A row where they disagree is a row where the site was located wrongly, and it is dropped
rather than trusted. Nothing else in this project has had an independent check on site identity.

**Replicates are kept as provenance.** `pKas` holds every measurement, not just the mean. The spread
between them is the experimental floor -- no model can be asked to do better than the measurements
agree -- so it is recorded per row and rows whose replicates disagree wildly are dropped.

    python3 pkachu_labels.py pkachu.csv <existing-labels.json> pkachu-labels.json
"""
import ast
import csv
import json
import sys

from rdkit import Chem, RDLogger

from pka_labels import changed_atom
from parity_features import AQUEOUS_WINDOW, is_unactivated_amine, written_smiles_with_site

RDLogger.DisableLog("rdApp.*")

# Replicates further apart than this are not one measurement with noise; they are a disagreement about
# what was measured, and averaging them would bury it. Chosen to match the "conflicting duplicate" rule
# the QupKake path already applies across datasets.
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
        field = (row.get("micropka input") or "").strip()
        if field.count(">>") != 1:
            drop("not a single acid/base pair"); continue
        acid_s, base_s = (part.strip() for part in field.split(">>"))

        try:
            replicates = [float(v) for v in ast.literal_eval(row["pKas"])]
        except Exception:
            drop("unreadable replicate list"); continue
        if not replicates:
            drop("no replicate values"); continue
        if max(replicates) - min(replicates) > MAX_REPLICATE_SPREAD:
            drop("replicates disagree by more than 1.0"); continue
        pka = sum(replicates) / len(replicates)

        idx, acid, _base = changed_atom(acid_s, base_s)
        if idx is None:
            drop("not exactly one changed atom"); continue

        # The cross-check. `Prot` means the ionizing group is a protonated cation, so the changed atom
        # must carry a positive charge in the acid; `Deprot` means a neutral acid losing a proton.
        charge = acid.GetAtomWithIdx(idx).GetFormalCharge()
        prefix = (row.get("prefix") or "").strip()
        if prefix == "Prot" and charge <= 0:
            drop("labelled Prot but the changed atom is not cationic in the acid"); continue
        if prefix == "Deprot" and charge > 0:
            drop("labelled Deprot but the changed atom is cationic in the acid"); continue

        # The cross-check above asks whether the CHARGE matches the direction. It does not ask whether
        # the VALUE is possible for that direction, and for a neutral amine labelled `Deprot` it is
        # not: a neutral aliphatic amine's N-H comes off near pKa 35, which water cannot host at any pH.
        #
        # 15 rows arrived exactly this way -- `NCC(F)F` recorded as losing its N-H at 7.20, `N#CCCN` at
        # 7.75, `CNCCC#N` at 8.10. Every one of those numbers is the molecule's BASIC pKa, the pH at
        # which its ammonium gives a proton back, filed against the acidic transition. They passed both
        # the Prot/Deprot charge check (a neutral amine IS charge-0, as `Deprot` requires) and the
        # one-changed-atom check, and the shipped model trained on all 15 -- learning that deprotonating
        # a neutral amine in water is routine.
        #
        # Rejected only when the value lands INSIDE the aqueous window, because that is what makes it
        # demonstrably mislabelled rather than merely out of scope. A row recording the real ~35 would
        # be honest-but-unusable and is counted separately, so the two never get confused.
        if prefix != "Prot" and is_unactivated_amine(acid, idx):
            if AQUEOUS_WINDOW[0] <= pka <= AQUEOUS_WINDOW[1]:
                drop("acidic label on an unactivated amine, at a pKa water cannot host")
            else:
                drop("unactivated amine N-H acidity, outside the aqueous range this corpus covers")
            continue

        # Deduplicate through the SAME mapping the other sources use, or the key pairs a canonical
        # SMILES with an index in the pre-canonical numbering and never matches anything.
        canonical, site = written_smiles_with_site(acid, idx)
        if canonical is None:
            drop("site atom is not written to SMILES"); continue
        key = (canonical, site)
        if key in known:
            drop("already covered by an existing label"); continue
        if key in seen:
            if abs(seen[key] - pka) > 0.5:
                drop("conflicting duplicate within pKaCHU")
            else:
                drop("duplicate within pKaCHU")
            continue
        seen[key] = pka

        kept.append({
            "acid": acid_s,
            "base": base_s,
            "acidAtomIdx": idx,
            "pKa": round(pka, 4),
            "replicates": len(replicates),
            "replicateSpread": round(max(replicates) - min(replicates), 4),
            "ref": row.get("citation", ""),
            "label_source": "pkachu (experimental; site diffed from the acid/base pair, "
                            "cross-checked against the Prot/Deprot column)",
        })

    return kept, stats


def main(src, existing_path, out):
    kept, stats = extract(src, existing_path)
    json.dump(kept, open(out, "w"))
    print(f"kept {len(kept)} per-site labels")
    for reason, count in sorted(stats.items(), key=lambda kv: -kv[1]):
        print(f"   dropped {count:5d}  {reason}")
    if kept:
        values = [row["pKa"] for row in kept]
        spreads = [row["replicateSpread"] for row in kept]
        print(f"   pKa range {min(values):.2f} .. {max(values):.2f}")
        print(f"   mean replicate spread {sum(spreads) / len(spreads):.3f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2] if sys.argv[2] != "-" else None, sys.argv[3])
