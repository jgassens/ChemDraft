/**
 * Joback group contributions (PLANS.md §9, Later phases — estimates).
 *
 * Joback & Reid, *Chem. Eng. Commun.* **57** (1987) 233-243. The parameters are published scientific
 * data; the SMARTS patterns and the priority ordering follow the fragmentation Caleb Bell's `thermo`
 * (MIT) uses, which is the reference this implementation is validated against — two independent
 * implementations agreeing is worth more than either matching a number typed into a test.
 *
 * `priority` orders fragmentation: a higher-priority group claims its atoms first, so the specific
 * (`-COOH`) wins over the general (`>C=O`, `-OH`) rather than both matching the same carbon.
 *
 * A `null` contribution means the group has no published value for that property. It is not zero, and
 * a structure containing it must decline for that property rather than sum around the gap — `=NH`
 * has no Tb or Tc, which is exactly the case that would otherwise produce a confidently wrong number.
 */

export interface JobackGroup {
  id: number;
  /** The group as Joback writes it, e.g. `-CH3`. Shown to a reader in the fragmentation breakdown. */
  label: string;
  smarts: string;
  /** Higher wins. Specific groups outrank the general ones whose atoms they overlap. */
  priority: number;
  /** Normal-boiling-point contribution, K. */
  tb: number | null;
  /** Critical-temperature contribution (dimensionless, enters Joback's Tc correlation). */
  tc: number | null;
  /** Critical-pressure contribution, bar^-0.5 per Joback's form. */
  pc: number | null;
  /** Critical-volume contribution, cm3/mol. */
  vc: number | null;
}

export const JOBACK_GROUPS: readonly JobackGroup[] = [
  { id: 1, label: "-CH3", smarts: "[CX4H3]", priority: 103, tb: 23.58, tc: 0.0141, pc: -0.0012, vc: 65.0 },
  { id: 2, label: "-CH2-", smarts: "[!R;CX4H2]", priority: 102, tb: 22.88, tc: 0.0189, pc: 0.0, vc: 56.0 },
  { id: 3, label: ">CH-", smarts: "[!R;CX4H]", priority: 101, tb: 21.74, tc: 0.0164, pc: 0.002, vc: 41.0 },
  { id: 4, label: ">C<", smarts: "[!R;CX4H0]", priority: 100, tb: 18.25, tc: 0.0067, pc: 0.0043, vc: 27.0 },
  { id: 5, label: "=CH2", smarts: "[CX3H2]", priority: 102, tb: 18.18, tc: 0.0113, pc: -0.0028, vc: 56.0 },
  { id: 6, label: "=CH-", smarts: "[!R;CX3H1;!$([CX3H1](=O))]", priority: 101, tb: 24.96, tc: 0.0129, pc: -0.0006, vc: 46.0 },
  { id: 7, label: "=C<", smarts: "[$([!R;#6X3H0]);!$([!R;#6X3H0]=[#8])]", priority: 100, tb: 24.14, tc: 0.0117, pc: 0.0011, vc: 38.0 },
  { id: 8, label: "=C=", smarts: "[$([CX2H0](=*)=*)]", priority: 100, tb: 26.15, tc: 0.0026, pc: 0.0028, vc: 36.0 },
  { id: 9, label: "\u2261CH", smarts: "[$([CX2H1]#[!#7])]", priority: 101, tb: 9.2, tc: 0.0027, pc: -0.0008, vc: 46.0 },
  { id: 10, label: "\u2261C-", smarts: "[$([CX2H0]#[!#7])]", priority: 100, tb: 27.38, tc: 0.002, pc: 0.0016, vc: 37.0 },
  { id: 11, label: "-CH2- (ring)", smarts: "[R;CX4H2]", priority: 102, tb: 27.15, tc: 0.01, pc: 0.0025, vc: 48.0 },
  { id: 12, label: ">CH- (ring)", smarts: "[R;CX4H]", priority: 101, tb: 21.78, tc: 0.0122, pc: 0.0004, vc: 38.0 },
  { id: 13, label: ">C< (ring)", smarts: "[R;CX4H0]", priority: 100, tb: 21.32, tc: 0.0042, pc: 0.0061, vc: 27.0 },
  { id: 14, label: "=CH- (ring)", smarts: "[R;CX3H1,cX3H1]", priority: 101, tb: 26.73, tc: 0.0082, pc: 0.0011, vc: 41.0 },
  { id: 15, label: "=C< (ring)", smarts: "[$([R;#6X3H0]);!$([R;#6X3H0]=[#8])]", priority: 100, tb: 31.01, tc: 0.0143, pc: 0.0008, vc: 32.0 },
  { id: 16, label: "-F", smarts: "[F]", priority: 400, tb: -0.03, tc: 0.0111, pc: -0.0057, vc: 27.0 },
  { id: 17, label: "-Cl", smarts: "[Cl]", priority: 300, tb: 38.13, tc: 0.0105, pc: -0.0049, vc: 58.0 },
  { id: 18, label: "-Br", smarts: "[Br]", priority: 0, tb: 66.86, tc: 0.0133, pc: 0.0057, vc: 71.0 },
  { id: 19, label: "-I", smarts: "[I]", priority: 0, tb: 93.84, tc: 0.0068, pc: -0.0034, vc: 97.0 },
  { id: 20, label: "-OH (alcohol)", smarts: "[OX2H;!$([OX2H]-[#6]=[O]);!$([OX2H]-a)]", priority: 151, tb: 92.88, tc: 0.0741, pc: 0.0112, vc: 28.0 },
  { id: 21, label: "-OH (phenol)", smarts: "[$([OX2H]-a)]", priority: 151, tb: 76.34, tc: 0.024, pc: 0.0184, vc: -25.0 },
  { id: 22, label: "-O- (nonring)", smarts: "[OX2H0;!R;!$([OX2H0]-[#6]=[#8])]", priority: 150, tb: 22.42, tc: 0.0168, pc: 0.0015, vc: 18.0 },
  { id: 23, label: "-O- (ring)", smarts: "[#8X2H0;R;!$([#8X2H0]~[#6]=[#8])]", priority: 150, tb: 31.22, tc: 0.0098, pc: 0.0048, vc: 13.0 },
  { id: 24, label: ">C=O (nonring)", smarts: "[$([CX3H0](=[OX1]));!$([CX3](=[OX1])-[OX2]);!R]=O", priority: 250, tb: 76.75, tc: 0.038, pc: 0.0031, vc: 62.0 },
  { id: 25, label: ">C=O (ring)", smarts: "[$([#6X3H0](=[OX1]));!$([#6X3](=[#8X1])~[#8X2]);R]=O", priority: 250, tb: 94.97, tc: 0.0284, pc: 0.0028, vc: 55.0 },
  { id: 26, label: "O=CH- (aldehyde)", smarts: "[CH;D2;$(C-!@C)](=O)", priority: 251, tb: 72.24, tc: 0.0379, pc: 0.003, vc: 82.0 },
  { id: 27, label: "-COOH (acid)", smarts: "[OX2H]-[C]=O", priority: 401, tb: 169.09, tc: 0.0791, pc: 0.0077, vc: 89.0 },
  { id: 28, label: "-COO- (ester)", smarts: "[#6X3H0;!$([#6X3H0](~O)(~O)(~O))](=[#8X1])[#8X2H0]", priority: 400, tb: 81.1, tc: 0.0481, pc: 0.0005, vc: 82.0 },
  { id: 29, label: "=O (other than above)", smarts: "[OX1H0;!$([OX1H0]~[#6X3]);!$([OX1H0]~[#7X3]~[#8])]", priority: 150, tb: -10.5, tc: 0.0143, pc: 0.0101, vc: 36.0 },
  { id: 30, label: "-NH2", smarts: "[NX3H2]", priority: 177, tb: 73.23, tc: 0.0243, pc: 0.0109, vc: 38.0 },
  { id: 31, label: ">NH (nonring)", smarts: "[NX3H1;!R]", priority: 176, tb: 50.17, tc: 0.0295, pc: 0.0077, vc: 35.0 },
  { id: 32, label: ">NH (ring)", smarts: "[#7X3H1;R]", priority: 176, tb: 52.82, tc: 0.013, pc: 0.0114, vc: 29.0 },
  { id: 33, label: ">N- (nonring)", smarts: "[#7X3H0;!$([#7](~O)~O)]", priority: 175, tb: 11.74, tc: 0.0169, pc: 0.0074, vc: 9.0 },
  { id: 34, label: "-N= (nonring)", smarts: "[#7X2H0;!R]", priority: 175, tb: 74.6, tc: 0.0255, pc: -0.0099, vc: null },
  { id: 35, label: "-N= (ring)", smarts: "[#7X2H0;R]", priority: 175, tb: 57.55, tc: 0.0085, pc: 0.0076, vc: 34.0 },
  { id: 36, label: "=NH", smarts: "[#7X2H1]", priority: 176, tb: 83.08, tc: null, pc: null, vc: null },
  { id: 37, label: "-CN", smarts: "[#6X2]#[#7X1H0]", priority: 275, tb: 125.66, tc: 0.0496, pc: -0.0101, vc: 91.0 },
  { id: 38, label: "-NO2", smarts: "[$([#7X3,#7X3+][!#8])](=[O])~[O-]", priority: 475, tb: 152.54, tc: 0.0437, pc: 0.0064, vc: 91.0 },
  { id: 39, label: "-SH", smarts: "[SX2H]", priority: 251, tb: 63.56, tc: 0.0031, pc: 0.0084, vc: 63.0 },
  { id: 40, label: "-S- (nonring)", smarts: "[#16X2H0;!R]", priority: 250, tb: 68.78, tc: 0.0119, pc: 0.0049, vc: 54.0 },
  { id: 41, label: "-S- (ring)", smarts: "[#16X2H0;R]", priority: 250, tb: 52.1, tc: 0.0019, pc: 0.0051, vc: 38.0 },
];
