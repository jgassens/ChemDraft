/**
 * Empirical sp3 C-H increments in ppm. The first value is for a substituent directly attached to
 * the proton-bearing carbon (alpha), the second for one carbon removed (beta), and the third for two
 * carbons removed (gamma).
 *
 * Source: P. S. Beauchamp and R. Marquez, J. Chem. Educ. 1997, 74, 1483-1485,
 * DOI 10.1021/ed074p1483, Table 1 and equations 3-6. The compact keys below are ChemDraft's local
 * topology classifications; no third-party implementation or prose is copied.
 */

export type AliphaticIncrementKey =
  | "alkyl"
  | "vinyl"
  | "alkyne"
  | "aryl"
  | "F"
  | "Cl"
  | "Br"
  | "I"
  | "OH"
  | "OR"
  | "vinylO"
  | "ArO"
  | "OC(=O)R"
  | "ArCO2"
  | "NR2"
  | "NHC(=O)R"
  | "NO2"
  | "CHO"
  | "C(=O)R"
  | "ArCO"
  | "ClCO"
  | "COOH"
  | "COOR"
  | "C(=O)NR2"
  | "CN";

export const ALIPHATIC_BASE_PPM_BY_HYDROGEN_COUNT: Readonly<Record<number, number>> = {
  4: 0.23,
  3: 0.9,
  2: 1.2,
  1: 1.5
};

export const ALIPHATIC_INCREMENT_PPM: Readonly<
  Record<AliphaticIncrementKey, readonly [alpha: number, beta: number, gamma: number]>
> = {
  alkyl: [0, 0, 0],
  vinyl: [0.8, 0.2, 0.1],
  alkyne: [0.9, 0.3, 0.1],
  aryl: [1.4, 0.4, 0.1],
  F: [3.2, 0.5, 0.2],
  Cl: [2.2, 0.5, 0.2],
  Br: [2.1, 0.7, 0.2],
  I: [2.0, 0.9, 0.1],
  OH: [2.3, 0.3, 0.1],
  OR: [2.1, 0.3, 0.1],
  vinylO: [2.5, 0.4, 0.2],
  ArO: [2.8, 0.5, 0.3],
  "OC(=O)R": [2.8, 0.5, 0.1],
  ArCO2: [3.1, 0.5, 0.2],
  NR2: [1.5, 0.2, 0.1],
  "NHC(=O)R": [2.1, 0.3, 0.1],
  NO2: [3.2, 0.8, 0.1],
  CHO: [1.1, 0.4, 0.1],
  "C(=O)R": [1.2, 0.3, 0],
  ArCO: [1.7, 0.3, 0.1],
  ClCO: [1.8, 0.4, 0.1],
  COOH: [1.1, 0.3, 0.1],
  COOR: [1.1, 0.3, 0.1],
  "C(=O)NR2": [1.0, 0.3, 0.1],
  CN: [1.1, 0.4, 0.2]
};
