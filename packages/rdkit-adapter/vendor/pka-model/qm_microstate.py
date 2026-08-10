"""Relative free energy between two microstates of one molecule, by DFT with implicit solvent.

**What this is for.** The macroscopic fold sums over EVERY microstate, populated or not, so its accuracy
rests on rungs no titration can reach. `iupac_labels.py` records the failure that exposed it: a corpus
improved every labelled figure while putting glycine's NH3+ -> neutral rung at 2.07 against ~7.70, and
only the thermodynamic cycle defect caught it. There is no label to check a candidate model against.
This produces one.

**The task is smaller than "QM pKa prediction", and that is the point.** Glycine's four microstates form
a square whose two MACROSCOPIC values are measured (2.35, 9.78). Adding one number -- Kz, the ratio of
zwitterion to neutral -- determines both unpopulated rungs by cycle closure:

    k1  H2G+ -> HG+-   (lose COOH, amine protonated)      2.35   measured
    k3  HG+- -> G-     (lose NH3+, carboxylate)           9.78   measured
    k2  H2G+ -> HG0    (lose NH3+, carboxyl neutral)      k1 + log Kz
    k4  HG0  -> G-     (lose COOH, amine neutral)         k1 + k3 - k2

So what has to be computed is a relative free energy between two NEUTRAL ISOMERS of the same formula --
not an absolute pKa. Systematic errors in the functional and the cavity largely cancel, which is the
regime implicit solvation is least bad in, and the answer is checkable: glycine's Kz is experimentally
~10^5.3.

**What is approximated, stated rather than buried.** Thermal and entropic corrections are neglected:
the two species are isomers with identical formula and nearly identical vibrational manifolds, so the
difference in zero-point and thermal terms is small against the solvation term this is measuring. No
explicit water. Conformers are searched with RDKit/MMFF and re-ranked by DFT single points, which is a
weaker search than a dedicated conformer program -- for a zwitterion with an intramolecular hydrogen
bond that is the largest remaining source of error after the solvation model itself.

**MEASURED, AND NOT USABLE AS A GATE AT THIS LEVEL OF THEORY. Read this before running it.** Glycine,
B3LYP/6-31+G** with ddCOSMO(water), geometry optimised in solvent:

    conformer treatment              log Kz     versus experiment (~ +5.38)
    one MMFF minimum                  +1.43                          -3.95
    24 conformers, DFT-screened       +1.39                          -3.99

The conformer search moved the answer by 0.04 while the neutral form's own conformers spanned 3.24
kcal/mol, so the error is the SOLVATION MODEL and not the search -- a clean attribution and the useful
part of the result. An electrostatic-only continuum recovers only part of the ~27 kcal/mol of differential
solvation a zwitterion needs, and it under-stabilises it by about 5.4 kcal/mol here.

**And it fails in the direction that matters.** Turned into the rung it exists to label:

    route                                   glycine k2      error
    experiment, via the blocked analogue          7.73          --
    shipped model                                 7.91       +0.18
    IUPAC-trained model (rejected)                2.07       -5.66
    THIS, dE -> k1 + log Kz                       3.74       -3.99

A gate built on this number would rank the REJECTED model closer to correct than the shipped one. It
would have endorsed the regression it was built to catch. That is worse than having no gate.

What it would take: SMD, which is parameterised against measured solvation free energies including ions
and is not compiled into the PyPI PySCF wheel, or cluster-continuum with explicit water -- the literature
on this system finds the zwitterion becomes the stable form only with about four explicit waters. Either
is a real project, not a parameter change.

**The cheaper route beat it and needs no QM at all.** Glycine's unpopulated NH3+ -> neutral rung is
measurable in glycine METHYL ESTER, whose carboxyl is blocked and uncharged: pKa ~7.7 experimentally,
and this repo's model puts it at 7.77. See "unpopulated rungs against their blocked analogues" in
`macroscopicFold.real.test.ts`, which is that comparison turned into a gate. QM's place is the cases with
no analogue -- second protonations, ylides, carbanions -- and it needs better solvation before it earns
that either.

**Do not read the output as a pKa.** It is log10 of a tautomeric ratio. Turning it into a rung value
needs the measured macroscopic pair, and that arithmetic belongs to whoever assembles the gate set.

    python3 qm_microstate.py "<smiles A>" "<smiles B>" [label]

Reports log10([B]/[A]). For glycine pass the NEUTRAL first and the zwitterion second to get log Kz.
"""
import sys
import time

import numpy as np
from rdkit import Chem, RDLogger
from rdkit.Chem import AllChem

from pyscf import dft, gto
from pyscf.geomopt.geometric_solver import optimize

RDLogger.DisableLog("rdApp.*")

WATER_EPS = 78.3553
HARTREE_KCAL = 627.5094740631
RT_KCAL = 0.001987204258640832 * 298.15      # kcal/mol
LN10 = 2.302585092994046
# Hartree -> log10 units at 298.15 K
HARTREE_TO_LOG10 = HARTREE_KCAL / (LN10 * RT_KCAL)

CONFORMERS = 24
SCREEN_BASIS = "6-31g"
OPT_BASIS = "6-31g*"
FINAL_BASIS = "6-31+g**"
FUNCTIONAL = "b3lyp"
# "smd" or "ddcosmo". Overridable from the command line as the fourth argument.
SOLVENT_MODEL = "ddcosmo"


def conformers(smiles, n=CONFORMERS):
    """MMFF-optimised conformers as (xyz string, charge). Deterministic seed, so this reproduces."""
    mol = Chem.AddHs(Chem.MolFromSmiles(smiles))
    if mol is None:
        raise SystemExit(f"cannot parse {smiles}")
    params = AllChem.ETKDGv3()
    params.randomSeed = 0xC0FFEE
    # NO RMS PRUNING. At 0.25 A this collapsed glycine to ONE conformer and at 0.1 A to two, which
    # silently turned the conformer search into a single MMFF minimisation -- and for a zwitterion, whose
    # folded and extended forms differ by an intramolecular hydrogen bond, that is a several-kcal/mol
    # error masquerading as a solvation-model error. The DFT screen below does the selecting instead.
    params.pruneRmsThresh = -1.0
    AllChem.EmbedMultipleConfs(mol, numConfs=n, params=params)
    if mol.GetNumConformers() == 0:
        raise SystemExit(f"no conformer embedded for {smiles}")
    AllChem.MMFFOptimizeMoleculeConfs(mol, maxIters=4000)
    charge = Chem.GetFormalCharge(mol)
    out = []
    for conf in mol.GetConformers():
        xyz = "\n".join(
            f"{a.GetSymbol()} {conf.GetAtomPosition(a.GetIdx()).x:.8f} "
            f"{conf.GetAtomPosition(a.GetIdx()).y:.8f} {conf.GetAtomPosition(a.GetIdx()).z:.8f}"
            for a in mol.GetAtoms())
        out.append(xyz)
    return out, charge


def solvated(xyz, charge, basis, model=None):
    """`model` is "ddcosmo" or "iefpcm".

    A zwitterion needs about 27 kcal/mol of differential solvation relative to its neutral form -- gas
    phase favours the neutral by roughly 20, water favours the zwitterion by about 7 -- so this quantity
    is almost entirely a solvation number and the model choice dominates everything else here.

    SMD would be the right choice, being parameterised against measured solvation free energies including
    ions, and it is NOT AVAILABLE: the PyPI PySCF wheel ships without it ("SMD module is not available.
    You can compile this module with cmake option -DENABLE_SMD=ON"). Asking for it raises at kernel time.
    What is available is electrostatic-only -- ddCOSMO, ddPCM, and PCM's C-PCM/IEF-PCM -- which is the
    family that under-stabilises a zwitterion.
    """
    model = (model or SOLVENT_MODEL).lower()
    mol = gto.M(atom=xyz, basis=basis, charge=charge, spin=0, verbose=0)
    if model == "iefpcm":
        mf = dft.RKS(mol, xc=FUNCTIONAL).PCM()
        mf.with_solvent.method = "IEF-PCM"
        mf.with_solvent.eps = WATER_EPS
    else:
        mf = dft.RKS(mol, xc=FUNCTIONAL).ddCOSMO()
        mf.with_solvent.eps = WATER_EPS
    mf.conv_tol = 1e-9
    return mf


def best_energy(smiles, label):
    """Screen conformers cheaply, optimise the winner, then a larger single point."""
    geoms, charge = conformers(smiles)
    print(f"  {label:26s} {smiles:28s} charge {charge:+d}, {len(geoms)} conformers", flush=True)

    screened = []
    for i, xyz in enumerate(geoms):
        mf = solvated(xyz, charge, SCREEN_BASIS)
        try:
            e = mf.kernel()
        except Exception:
            continue
        if mf.converged:
            screened.append((e, xyz))
    if not screened:
        raise SystemExit(f"no conformer converged for {smiles}")
    screened.sort(key=lambda t: t[0])
    spread = (screened[-1][0] - screened[0][0]) * HARTREE_KCAL
    print(f"  {'':26s} screened: {len(screened)} converged, "
          f"conformer spread {spread:.2f} kcal/mol", flush=True)

    t = time.time()
    mf = solvated(screened[0][1], charge, OPT_BASIS)
    opt = optimize(mf, maxsteps=60)
    print(f"  {'':26s} optimised in solvent ({time.time()-t:.0f}s)", flush=True)

    final = solvated(
        "\n".join(f"{s} {c[0]:.8f} {c[1]:.8f} {c[2]:.8f}"
                  for s, c in zip([a[0] for a in opt.atom], opt.atom_coords() * 0.52917721092)),
        charge, FINAL_BASIS)
    e = final.kernel()
    print(f"  {'':26s} {FUNCTIONAL}/{FINAL_BASIS} + {SOLVENT_MODEL}(water)  E = {e:.6f} Ha  "
          f"converged={final.converged}", flush=True)
    return e


def main(smiles_a, smiles_b, label="pair"):
    print(f"=== {label}")
    ea = best_energy(smiles_a, "state A (reference)")
    eb = best_energy(smiles_b, "state B")
    d_ha = eb - ea
    log_k = -d_ha * HARTREE_TO_LOG10
    print()
    print(f"  dE (B - A)      {d_ha * HARTREE_KCAL:+.2f} kcal/mol")
    print(f"  log10([B]/[A])  {log_k:+.2f}")
    return log_k


if __name__ == "__main__":
    if len(sys.argv) > 4:
        SOLVENT_MODEL = sys.argv[4]
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "pair")
