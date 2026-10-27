import type { Plugin3DMethod } from "@chemdraft/plugin-api";

export function chemistry3dMethod(seed: number, forceField: Plugin3DMethod["forceField"] = "none", interfragment = false): Plugin3DMethod {
  return {
    engine: "RDKit MinimalLib Release_2026_03_3 + patches 0001-0008",
    embedding: "ETKDGv3", seed, forceField, interfragment,
    coordinateUnits: "Angstrom", energyUnits: "kcal/mol",
    conventions: [
      "nonbonded cutoff 10 A, gas phase, no counterions or solvent; energies rank starting geometries only and are not binding energies; a local minimum, not an equilibrium structure",
      `Interfragment nonbonded interactions ${interfragment ? "on" : "off"}.`,
      "Components are supplied explicitly; no counterions or solvent are added.",
      "Explicit hydrogens; unchanged chemical graph; iterationsBudget counts requested iterations, not measured steps.",
      "Embedding follows Spin 3D: up to four deterministic ETKDGv3 candidates, ranked by 50-step MMFF94 scoring when parameterized; useRandomCoords rescue for failed embeds with at least 50 input atoms."
    ]
  };
}
