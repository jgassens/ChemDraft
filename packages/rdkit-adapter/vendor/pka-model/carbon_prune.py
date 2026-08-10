"""Drop carbon-acid labels the shipped scanner will never locate. **MEASURED AND REJECTED.**

The corpus holds 449 rows whose ionizing atom is a carbon, and `isActivatedCarbonAcid` in
`ionization.ts` fires on only 349 of them. The other 100 are sites the product cannot present:
nothing in the pipeline will ever ask the model about that atom, so their only effect is on the
shared representation. They are also the worst-fit rows in the class -- out-of-fold MAE 2.552
against 1.142 for the rows the gate does reach -- and 20 of them sit outside pH 0-14 entirely.
The hypothesis was that they spend capacity on chemistry nobody asks about.

**THEY DO NOT. REMOVING THEM MAKES THE ROWS THE GATE DOES REACH WORSE.** Two runs on the same
device, same seeds, same stable split, differing only by these 100 rows, compared on the 11,996
rows both corpora share:

    subset                          n        full -> pruned
    ALL shared                  11996    0.7172 -> 0.7212   +0.0040 worse
      ionizing N                 6789    0.7321 -> 0.7336   +0.0015 worse
      ionizing O                 4669    0.6618 -> 0.6681   +0.0063 worse
      ionizing C                  349    1.1621 -> 1.1899   +0.0278 worse
      ionizing S                  189    0.7315 -> 0.7223   -0.0092 better
    carbon DETECTED, in window    342    1.1007 -> 1.1305   +0.0298 worse

The target metric moves 0.0278 the WRONG way, against a same-split retrain noise floor of 0.0164
measured on that exact subset, so it is roughly twice the noise and in the wrong direction. Every
larger class is worse too.

**AND THE EXTERNAL GATE AGREES, which is the one that matters.** 398 rows from the QupKake Novartis
and literature sets, never trained on and never used for fold selection -- the measurement that
overruled cross-validation on the HIDDEN=160 question:

    model                          n       MAE   novartis   literature
    shipped (committed)          398    1.1286      1.193        0.983
    stable split, FULL corpus    398    1.1287      1.201        0.966
    stable split, PRUNED corpus  398    1.1667      1.239        1.002

Pruned is worse on the total and on BOTH sub-sets. Paired over the same 398 rows the difference is
+0.0380 with a standard error of 0.0201, t = +1.89, 215 rows worse against 183 better -- suggestive
but NOT significant on its own, and stated that way rather than rounded up. The decision does not
rest on it: the burden is on the change, cross-validation puts the target subset twice its noise
floor in the wrong direction, and the external set agrees in direction on both halves. Nothing here
argues for the prune.

These rows are auxiliary signal: they are carbanion chemistry, and what the network learns from a
site the scanner will not present still transfers to the 342 it will.
That is the mirror image of the IUPAC finding in `iupac_labels.py` -- there, off-window rows
IMPROVED every per-site figure while destroying the macroscopic ones -- and the shared lesson is
that "the product never asks this" is not a reason to withhold a label from TRAINING. Withholding
it from the ANSWER is a different decision, which `isFullyDissociatedSulfonic` makes and this
does not.

**THE FIRST RUN OF THIS EXPERIMENT SAID THE OPPOSITE, AND THE REASON IS WORTH MORE THAN THE
RESULT.** `cross_validate` used to assign folds by `i % folds` over the sorted scaffold list, so a
scaffold's fold depended on how many scaffolds sorted before it. Pruning removed 47 scaffold groups
entirely and 96.3% of surviving rows changed held-out fold. Compared that way the prune looked
0.0402 BETTER on the target metric -- a 0.068 swing from the split alone, 2.4x the effect being
measured, with sulfur moving 0.078 in a class the prune does not touch. `pka_gnn.py` now hashes the
scaffold instead, which holds every surviving row in its fold and is what makes the table above a
comparison rather than a coincidence.

Kept, unused, for the same reason `capacity_sweep.py` is: the next person to wonder whether the
corpus should be trimmed to what the scanner detects can re-run it in an hour instead of a day.

The gate is ported here rather than re-derived. It has to agree with `carbanionStabilisers` and
`isActivatedCarbonAcid` exactly, or the pruning removes a different set than the one measured, so
the port is deliberately literal and reads on the KEKULE structure with aromaticity taken from the
pre-kekulised molecule -- the same pairing `parity_features.kekulized` establishes for features.

    python3 carbon_prune.py merged-labels.json pruned-labels.json [dropped.json]

Writes the kept rows, and optionally the dropped ones so the decision stays auditable.
"""
import collections
import json
import sys

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")


def carbanion_stabilisers(mol, idx, aromatic):
    """Port of `carbanionStabilisers` in ionization.ts. Returns (nitro, other)."""
    atom = mol.GetAtomWithIdx(idx)
    nitro = other = 0
    for neighbour in atom.GetNeighbors():
        element = neighbour.GetSymbol()
        bonds = neighbour.GetBonds()
        if (element == "N" and neighbour.GetFormalCharge() > 0
                and any(x.GetSymbol() == "O" for x in neighbour.GetNeighbors())):
            nitro += 1
            continue
        if element == "S" and sum(
                1 for b in bonds
                if b.GetBondTypeAsDouble() > 1 and b.GetOtherAtom(neighbour).GetSymbol() == "O") >= 2:
            other += 1
            continue
        if element != "C":
            continue
        if any(b.GetBondTypeAsDouble() > 1 and b.GetOtherAtom(neighbour).GetSymbol() in ("O", "S")
               for b in bonds):
            # A carbonyl belonging to a CARBOXYL does not count -- see the comment on the same clause
            # in ionization.ts, and malonic acid's cycle defect of 3.07 when it did.
            ionisable = any(
                o.GetSymbol() == "O" and (o.GetTotalNumHs() > 0 or o.GetFormalCharge() < 0)
                for o in neighbour.GetNeighbors() if o.GetIdx() != idx)
            if not ionisable:
                other += 1
        elif any(b.GetBondTypeAsDouble() > 2 for b in bonds):
            other += 1  # nitrile or alkyne
        elif aromatic[neighbour.GetIdx()]:
            other += 1  # aryl
    return nitro, other


def detected(smiles, idx):
    """Would `isActivatedCarbonAcid` fire here? `None` when the molecule cannot be read."""
    mol = Chem.MolFromSmiles(smiles)
    if mol is None or idx >= mol.GetNumAtoms():
        return None
    aromatic = [a.GetIsAromatic() for a in mol.GetAtoms()]
    kekule = Chem.Mol(mol)
    try:
        Chem.Kekulize(kekule, clearAromaticFlags=True)
    except Exception:
        return None
    atom = kekule.GetAtomWithIdx(idx)
    if atom.GetSymbol() != "C" or atom.GetFormalCharge() != 0 or atom.GetTotalNumHs() == 0:
        return False
    if aromatic[idx]:
        return False
    nitro, other = carbanion_stabilisers(kekule, idx, aromatic)
    return nitro >= 1 or nitro + other >= 2


def main(labels_path, out_path, dropped_path=None):
    rows = json.load(open(labels_path))
    kept, dropped, unreadable = [], [], 0
    for row in rows:
        mol = Chem.MolFromSmiles(row["acid"])
        if mol is None or row["acidAtomIdx"] >= mol.GetNumAtoms():
            # Not this script's business to judge: `pka_gnn.load` drops these itself.
            unreadable += 1
            kept.append(row)
            continue
        if mol.GetAtomWithIdx(row["acidAtomIdx"]).GetSymbol() != "C":
            kept.append(row)
            continue
        if detected(row["acid"], row["acidAtomIdx"]):
            kept.append(row)
        else:
            dropped.append(row)

    json.dump(kept, open(out_path, "w"))
    if dropped_path:
        json.dump(dropped, open(dropped_path, "w"), indent=1)

    carbon = sum(1 for r in rows
                 if (m := Chem.MolFromSmiles(r["acid"])) is not None
                 and r["acidAtomIdx"] < m.GetNumAtoms()
                 and m.GetAtomWithIdx(r["acidAtomIdx"]).GetSymbol() == "C")
    outside = sum(1 for r in dropped if not 0 <= r["pKa"] <= 14)
    print(f"read {len(rows)} labels, {carbon} of them on a carbon")
    print(f"   kept    {len(kept)}")
    print(f"   dropped {len(dropped)}  ({outside} of those outside pH 0-14)")
    if unreadable:
        print(f"   {unreadable} rows RDKit could not read were left alone")
    print("   dropped by source:")
    for source, n in collections.Counter(
            str(r.get("label_source") or r.get("ref"))[:52] for r in dropped).most_common(8):
        print(f"     {n:4d}  {source}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else None)
