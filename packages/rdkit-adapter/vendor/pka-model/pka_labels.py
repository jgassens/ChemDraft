"""Turn Dwar-iBond macro-pKa rows into per-site training labels.

Each row is `acid_microstates >> base_microstates` with a macro-pKa. When both sides carry exactly one
microstate, the two structures differ at exactly one atom — the one that lost the proton — and that
atom is the site the pKa belongs to. Rows where more than one atom differs are DISCARDED rather than
guessed at: attributing a pKa to the wrong atom would poison the label, and there are enough clean
rows to not need them.

Emits: acid SMILES, base SMILES, the ionizable atom index in the acid, and the pKa.
"""
import csv, json, sys
from rdkit import Chem, RDLogger

RDLogger.DisableLog("rdApp.*")


def atom_signature(mol):
    """Per-atom (element, charge, total H) — enough to spot a protonation change."""
    return [(a.GetSymbol(), a.GetFormalCharge(), a.GetTotalNumHs()) for a in mol.GetAtoms()]


def changed_atom(acid_smiles, base_smiles):
    """The single atom that differs, or None when it is not exactly one."""
    acid = Chem.MolFromSmiles(acid_smiles)
    base = Chem.MolFromSmiles(base_smiles)
    if acid is None or base is None:
        return None, None, None
    if acid.GetNumAtoms() != base.GetNumAtoms():
        return None, None, None

    # The enumerator that built these pairs preserves atom order, verified on a sample: 94% of clean
    # pairs have identical element sequences. Index correspondence is therefore both available and far
    # more reliable than a substructure match, which fails outright when a charge differs — a charged
    # nitrogen does not match a neutral one, which is exactly the atom being looked for.
    #
    # The element-sequence check is the guard. Without it this would silently mis-attribute a pKa to
    # whatever atom happened to sit at that index.
    a_sig, b_sig = atom_signature(acid), atom_signature(base)
    if [x[0] for x in a_sig] != [x[0] for x in b_sig]:
        return None, None, None
    diffs = [i for i in range(acid.GetNumAtoms()) if a_sig[i] != b_sig[i]]
    if len(diffs) != 1:
        return None, None, None
    return diffs[0], acid, base


def main(src, out):
    rows = list(csv.reader(open(src), delimiter="\t"))[1:]
    kept, skipped_multi, skipped_diff = [], 0, 0
    for row in rows:
        if len(row) < 3:
            continue
        field, target = row[1], row[2]
        if "," in field or field.count(">>") != 1:
            skipped_multi += 1
            continue
        acid_s, base_s = field.split(">>")
        idx, acid, base = changed_atom(acid_s.strip(), base_s.strip())
        if idx is None:
            skipped_diff += 1
            continue
        try:
            pka = float(target)
        except ValueError:
            continue
        kept.append({
            # The ORIGINAL SMILES, not the canonical form. `acidAtomIdx` is an index into the parse
            # order of this exact string; MolToSmiles reorders atoms, so storing the canonical form
            # beside an index taken before canonicalisation would point at a different atom.
            "acid": acid_s.strip(),
            "base": base_s.strip(),
            "acidAtomIdx": idx,
            "pKa": pka,
            "ref": row[3] if len(row) > 3 else ""
        })

    json.dump(kept, open(out, "w"))
    print(f"rows in: {len(rows)}")
    print(f"  skipped, multi-microstate macrostate: {skipped_multi}")
    print(f"  skipped, element order differs or not one changed atom: {skipped_diff}")
    print(f"  KEPT per-site labels: {len(kept)}")
    if kept:
        vals = [k["pKa"] for k in kept]
        print(f"  pKa range {min(vals):.2f} .. {max(vals):.2f}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
