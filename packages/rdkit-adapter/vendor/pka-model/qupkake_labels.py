"""Turn the QupKake experimental set into per-site labels in the same acid-microstate form as ours.

**Provenance, which is the reason this file is long.** The pKa values are experimental, curated from
ChEMBL and DataWarrior by Baltruschat & Czodrowski (Machine-learning-meets-pKa) and redistributed with
QupKake (BSD-3-Clause). The values are measurements, not another model's output, so they do not make a
result `inherited-from-another-predictor`.

The SITE INDEX is a different matter. `marvin_atom` is ChemAxon's Marvin saying which atom ionises, and
`marvin_pKa_type` is Marvin saying whether that is an acidity or a basicity. Those are predictor
annotations sitting inside the label. A wrong one attaches a real measurement to the wrong atom, which
is exactly the failure the Dwar-iBond extraction was built to avoid -- there the site came from the
DATA, by diffing an acid/base microstate pair, with no predictor involved.

So Marvin's call is checked rather than trusted, on three counts:

  1. the atom must be capable of the transition it is credited with (an acidic site needs a proton;
     a basic site must be a nitrogen with a lone pair to accept one);
  2. protonating a basic site must actually produce the cation it should;
  3. a label that contradicts one we already have for the same site is dropped, not averaged.

Rows that fail are discarded rather than guessed at. What survives still carries a site attribution
this project did not derive itself, and `label_source` records that per row.

    python qupkake_labels.py <exp_training_data.sdf> <existing-labels.json> <out.json>
"""
import json
import sys

from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")


def protonated(mol, idx):
    """The cation formed by protonating `idx`, or None.

    Only the formal charge is set; RDKit adds the hydrogen itself on re-parse, so a pyridine nitrogen
    picks one up and an -NH2 becomes -NH3+. The result is checked to have actually gained a proton,
    because a silent failure here would file a basic pKa against the neutral form.
    """
    edit = Chem.RWMol(mol)
    atom = edit.GetAtomWithIdx(idx)
    atom.SetFormalCharge(atom.GetFormalCharge() + 1)
    atom.SetNoImplicit(False)
    atom.SetNumExplicitHs(0)
    try:
        out = edit.GetMol()
        Chem.SanitizeMol(out)
    except Exception:
        return None
    before, after = mol.GetAtomWithIdx(idx), out.GetAtomWithIdx(idx)
    if after.GetFormalCharge() != before.GetFormalCharge() + 1:
        return None
    if after.GetTotalNumHs() != before.GetTotalNumHs() + 1:
        return None
    return out


def extract(sdf_path, existing_path):
    existing = json.load(open(existing_path))
    known = {}
    for row in existing:
        mol = Chem.MolFromSmiles(row["acid"])
        if mol:
            known[(Chem.MolToSmiles(mol), row["acidAtomIdx"])] = row["pKa"]

    kept, stats = [], {}
    def drop(reason):
        stats[reason] = stats.get(reason, 0) + 1

    seen = {}
    for mol in Chem.SDMolSupplier(sdf_path, removeHs=False):
        if mol is None:
            drop("unparsable"); continue
        try:
            idx = int(mol.GetProp("marvin_atom"))
            kind = mol.GetProp("marvin_pKa_type")
            pka = float(mol.GetProp("pKa"))
        except Exception:
            drop("missing annotation"); continue
        if idx >= mol.GetNumAtoms():
            drop("site index out of range"); continue

        atom = mol.GetAtomWithIdx(idx)
        # (1) capability
        if kind == "acidic":
            if atom.GetTotalNumHs() == 0:
                drop("acidic site with no proton"); continue
            acid = mol
        elif kind == "basic":
            if atom.GetSymbol() != "N":
                drop("basic site that is not nitrogen"); continue
            # (2) the microstate must really form
            acid = protonated(mol, idx)
            if acid is None:
                drop("could not protonate the basic site"); continue
        else:
            drop(f"unknown pKa type {kind}"); continue

        try:
            smiles = Chem.MolToSmiles(acid)
        except Exception:
            drop("unwritable"); continue
        # The index must survive canonicalisation, so store the form the index belongs to.
        key = (smiles, idx)

        if key in known:
            drop("already covered by the Dwar-iBond labels"); continue
        # (3) conflicting duplicates are dropped, not averaged: two different measurements for one site
        # mean at least one is wrong about something, and averaging hides it.
        if key in seen:
            if abs(seen[key] - pka) > 0.5:
                drop("conflicting duplicate")
            else:
                drop("duplicate")
            continue
        seen[key] = pka

        kept.append({
            "acid": Chem.MolToSmiles(acid, canonical=False),
            "acidAtomIdx": idx,
            "pKa": pka,
            "transition": kind,
            "ref": mol.GetProp("original_dataset") if mol.HasProp("original_dataset") else "",
            # Recorded per row: the value is experimental, the SITE came from ChemAxon's Marvin.
            "label_source": "qupkake-exp (value experimental; site index from Marvin)",
        })
    return kept, stats


if __name__ == "__main__":
    kept, stats = extract(sys.argv[1], sys.argv[2])
    json.dump(kept, open(sys.argv[3], "w"))
    print(f"kept {len(kept)} new per-site labels")
    for reason, count in sorted(stats.items(), key=lambda kv: -kv[1]):
        print(f"   dropped {count:>5}  {reason}")
