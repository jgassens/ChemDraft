/**
 * Ionizable-site substructures with per-site-type pKa statistics.
 *
 * Transcribed from Dimorphite-DL 2.0.2 (`smarts/site_substructures.smarts`, Apache-2.0), whose values
 * were fitted by its authors over sets of compounds with experimentally measured pKa. **These are
 * averages over a site TYPE, not predictions about any particular molecule** — every consumer has to
 * say so, because a carboxylic acid's neighbours move its pKa by more than this table's spread.
 *
 * Three details verified against Dimorphite's source rather than inferred, because each would produce
 * a wrong atom or a wrong number with nothing in the output to reveal it:
 *
 * 1. **`matchPosition` indexes the MATCH TUPLE, not the SMARTS atom-map number.** Confirmed at
 *    `protonate/site.py:251` (`idx_atom = self.idxs_match[pka.idx_site]`). The two readings disagree on
 *    real entries — `Nitro`'s position 3 is the hydroxyl oxygen positionally and the carbonyl `=O` by
 *    map number.
 * 2. **`aromaticNitrogen` is Dimorphite's `*` name prefix**, which its own docs gloss as "an aromatic
 *    nitrogen that needs special treatment".
 * 3. **With recursive SMARTS, RDKit counts only the first atom as the match** — later atoms define the
 *    environment and do not occupy match positions. Dimorphite's file comments state this.
 *
 * `pKaMean` may be a SENTINEL rather than a value: `Nitro` carries -1000, meaning the site never
 * titrates in any accessible range. See `SENTINEL_PKA_MAGNITUDE`.
 */

export interface IonizationSiteType {
  name: string;
  smarts: string;
  /** Dimorphite's `*` flag — an aromatic nitrogen its enumeration treats specially. */
  aromaticNitrogen: boolean;
  /**
   * Added by THIS project, not transcribed from Dimorphite-DL.
   *
   * The dataset record credited Dimorphite with the full table length, so five entries this project
   * fitted itself sat under another group's name and licence. Attribution is not decoration: their
   * means and spreads were fitted here, from this corpus, and a reader tracing a number back to
   * `site_substructures.smarts` would not find it.
   */
  addedHere?: true;
  sites: readonly {
    /** 0-based index into the substructure match, NOT the SMARTS atom map number. */
    matchPosition: number;
    pKaMean: number;
    pKaStd: number;
  }[];
}

/**
 * Beyond this magnitude a tabulated mean is a sentinel, not a pKa.
 *
 * Dimorphite uses -1000 for a site it recognises but which does not titrate in any accessible range.
 * Rendering that as "pKa -1000" would be absurd; the site is reported as recognised-but-not-titratable.
 */
export const SENTINEL_PKA_MAGNITUDE = 100;

export const IONIZATION_SITE_TYPES: readonly IonizationSiteType[] = [
  { name: "Azide", smarts: "[N+0:1]=[N+:2]=[N+0:3]-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 2, pKaMean: 4.65, pKaStd: 0.07071067811865513 }] },
  { name: "Nitro", smarts: "[C,c,N,n,O,o:1]-[NX3:2](=[O:3])-[O:4]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 3, pKaMean: -1000.0, pKaStd: 0.0 }] },
  { name: "AmidineGuanidine1", smarts: "[N:1]-[C:2](-[N:3])=[NX2:4]-[H:5]", aromaticNitrogen: false, sites: [{ matchPosition: 3, pKaMean: 12.025333333333334, pKaStd: 1.5941046150769165 }] },
  { name: "AmidineGuanidine2", smarts: "[C:1](-[N:2])=[NX2+0:3]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 10.035538461538462, pKaStd: 2.1312826469414716 }] },
  { name: "Sulfate", smarts: "[SX4:1](=[O:2])(=[O:3])([O:4]-[C,c,N,n:5])-[OX2:6]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 5, pKaMean: -2.36, pKaStd: 1.3048043093561141 }] },
  { name: "Sulfonate", smarts: "[SX4:1](=[O:2])(=[O:3])(-[C,c,N,n:4])-[OX2:5]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 4, pKaMean: -1.8184615384615386, pKaStd: 1.4086213481855594 }] },
  { name: "Sulfinic_acid", smarts: "[SX3:1](=[O:2])-[O:3]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 1.7933333333333332, pKaStd: 0.4372070447739835 }] },
  { name: "Phenyl_carboxyl", smarts: "[c,n,o:1]-[C:2](=[O:3])-[O:4]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 3, pKaMean: 3.463441968255319, pKaStd: 1.2518054407928614 }] },
  { name: "Carboxyl", smarts: "[C:1](=[O:2])-[O:3]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 3.456652971502591, pKaStd: 1.2871420886834017 }] },
  { name: "Thioic_acid", smarts: "[C,c,N,n:1](=[O,S:2])-[SX2,OX2:3]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 0.678267, pKaStd: 1.497048763660801 }] },
  { name: "Phenyl_Thiol", smarts: "[c,n:1]-[SX2:2]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 4.978235294117647, pKaStd: 2.6137000480499806 }] },
  { name: "Thiol", smarts: "[C,N:1]-[SX2:2]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 9.12448275862069, pKaStd: 1.3317968158171463 }] },
  { name: "Phosphate", smarts: "[PX4:1](=[O:2])(-[OX2:3]-[H])(-[O+0:4])-[OX2:5]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 2.4182608695652172, pKaStd: 1.1091177991945305 }, { matchPosition: 5, pKaMean: 6.5055, pKaStd: 0.9512787792174668 }] },
  { name: "Internal_phosphate_polyphos_chain", smarts: "[$([PX4:1](=O)([OX2][PX4](=O)([OX2])(O[H]))([OX2][PX4](=O)(O[H])([OX2])))][O:2]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 0.9, pKaStd: 1.0 }] },
  { name: "Initial_phosphate_like_in_ATP_ADP", smarts: "[$([PX4:1]([OX2][C,c,N,n])(=O)([OX2][PX4](=O)([OX2])(O[H])))]O-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 2.4182608695652172, pKaStd: 1.1091177991945305 }] },
  { name: "Phosphonate", smarts: "[PX4:1](=[O:2])(-[OX2:3]-[H])(-[C,c,N,n:4])-[OX2:5]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 1.8835714285714287, pKaStd: 0.5925999820080644 }, { matchPosition: 5, pKaMean: 7.247254901960784, pKaStd: 0.8511476450801531 }] },
  { name: "Phenol", smarts: "[c,n,o:1]-[O:2]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 7.065359866910526, pKaStd: 3.277356122295936 }] },
  { name: "Peroxide1", smarts: "[O:1]([$(C=O),$(C[Cl]),$(CF),$(C[Br]),$(CC#N):2])-[O:3]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 8.738888888888889, pKaStd: 0.7562592839596507 }] },
  { name: "Peroxide2", smarts: "[C:1]-[O:2]-[O:3]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 11.978235294117647, pKaStd: 0.8697645895163075 }] },
  { name: "O=C-C=C-OH", smarts: "[O:1]=[C;R:2]-[C;R:3]=[C;R:4]-[O:5]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 4, pKaMean: 3.554, pKaStd: 0.803339458581667 }] },
  { name: "Vinyl_alcohol", smarts: "[C:1]=[C:2]-[O:3]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 8.871850714285713, pKaStd: 1.660200255394124 }] },
  { name: "Alcohol", smarts: "[C:1]-[O:2]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 14.780384615384616, pKaStd: 2.546464970533435 }] },
  { name: "N-hydroxyamide", smarts: "[C:1](=[O:2])-[N:3]-[O:4]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 3, pKaMean: 9.301904761904762, pKaStd: 1.2181897185891002 }] },
  // NOT from Dimorphite — the only entry in this table that is not, and the statistics are this
  // project's own. Dimorphite has no oxime pattern, so the app found ZERO of the 345 oxime sites in the
  // training corpus: 85 of 85 in a randomised sample, a 100% miss rate. Handed acetone oxime it reported
  // no ionizable site at all, which reads to a user as "there is nothing here" rather than "I did not
  // look". Nothing distinguishes those two, which is what makes a missing pattern worse than a wrong
  // number.
  //
  // The mean and spread below are measured over exactly the sites this SMARTS selects in
  // `merged-labels.json` — 345 rows, all of them inside the aqueous window, spanning pKa 3.02 to 12.60.
  // As with every other row here the table only LOCATES; the trained model supplies the value, and it
  // was already trained on these 345 rows. So this entry asks the model a question it could always
  // answer and was never asked.
  //
  // `[OX2H1,OX1H0-]` matches the oxime drawn either protonated or already deprotonated, since
  // canonicalization may hand either form to the scanner. Distinct from `N-hydroxyamide` above, which is
  // C(=O)-N-O-H; this is C=N-O-H, with no carbonyl.
  { name: "Oxime", addedHere: true, smarts: "[CX3:1]=[NX2:2]-[OX2H1,OX1H0-:3]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 8.655701, pKaStd: 1.703249 }] },
  // The other four entries this project added, and the two it refused to. Each was chosen by measuring how
  // many atoms the pattern hits that are NOT labelled sites, because a pattern that locates atoms the model
  // was never trained on trades a silent omission for a confident fabrication -- the worse of the two.
  //
  //   candidate            labelled  unlabelled  verdict
  //   Imine_protonated          514          17  added
  //   Alpha_nitro               115           6  added
  //   N_hydroxylamine            19          13  added
  //   Aryl_hydroperoxide          7           0  added
  //   alpha-to-carbonyl         459       3,436  REFUSED -- would put a site on every ketone's alpha
  //                                              carbon, 7.5 unlabelled for every labelled one
  //   As/Se/B/Si heteroacids     55          38  REFUSED -- the element sits outside the domain the
  //                                              method declares, so the molecule declines anyway
  //
  // Statistics are measured over exactly the sites each SMARTS selects in `merged-labels.json`. All four
  // fall entirely inside the aqueous window. Overlap with existing entries is expected and harmless --
  // acetic acid already matches Alcohol, Carboxyl and Thioic_acid together -- so the incremental gain is
  // only the sites currently going unreported, not the full labelled count above.
  { name: "Imine_protonated", addedHere: true, smarts: "[CX3:1]=[NX3H1+,NX3H2+:2]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 8.214413, pKaStd: 2.007783 }] },
  { name: "Alpha_nitro", addedHere: true, smarts: "[CX4H1,CX4H2,CX4H3:1][NX3+](=[OX1])[OX1-]", aromaticNitrogen: false, sites: [{ matchPosition: 0, pKaMean: 6.189045, pKaStd: 2.265162 }] },
  // Excludes the N of a hydroxamic acid (`N[CX3]=[OX1]`, already covered by N-hydroxyamide) and of an
  // oxime (`N=*`, covered above), so the three N-O entries partition rather than overlap.
  { name: "N_hydroxylamine", addedHere: true, smarts: "[OX2H1,OX1H0-:1][NX3;!$(N[CX3]=[OX1]);!$(N=*)]", aromaticNitrogen: false, sites: [{ matchPosition: 0, pKaMean: 8.903158, pKaStd: 2.786721 }] },
  // `Peroxide1` and `Peroxide2` both require an ALIPHATIC carbon, so an aryl hydroperoxide matched neither.
  { name: "Aryl_hydroperoxide", addedHere: true, smarts: "[c:1][OX2][OX2H1:2]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 8.6, pKaStd: 0.447214 }] },
  { name: "Ringed_imide1", smarts: "[O,S:1]=[C;R:2]([$([#8]),$([#7]),$([#16]),$([#6][Cl]),$([#6]F),$([#6][Br]):3])-[N;R:4]([C;R:5]=[O,S:6])-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 3, pKaMean: 6.4525, pKaStd: 0.5555627777308341 }] },
  { name: "Ringed_imide2", smarts: "[O,S:1]=[C;R:2]-[N;R:3]([C;R:4]=[O,S:5])-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 2, pKaMean: 8.681666666666667, pKaStd: 1.8657779975741713 }] },
  { name: "Imide", smarts: "[F,Cl,Br,S,s,P,p:1][#6:2][CX3:3](=[O,S:4])-[NX3+0:5]([CX3:6]=[O,S:7])-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 4, pKaMean: 2.466666666666667, pKaStd: 1.4843629385474877 }] },
  { name: "Imide2", smarts: "[O,S:1]=[CX3:2]-[NX3+0:3]([CX3:4]=[O,S:5])-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 2, pKaMean: 10.23, pKaStd: 1.1198214143335534 }] },
  { name: "Amide_electronegative", smarts: "[C:1](=[O:2])-[N:3](-[Br,Cl,I,F,S,O,N,P:4])-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 2, pKaMean: 3.4896, pKaStd: 2.688124315081677 }] },
  { name: "Amide", smarts: "[C:1](=[O:2])-[N:3]-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 2, pKaMean: 12.00611111111111, pKaStd: 4.512491341218857 }] },
  { name: "Sulfonamide", smarts: "[SX4:1](=[O:2])(=[O:3])-[NX3+0:4]-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 3, pKaMean: 7.9160326086956525, pKaStd: 1.9842121316708763 }] },
  { name: "Anilines_primary", smarts: "[c:1]-[NX3+0:2]([H:3])[H:4]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 3.899298673194805, pKaStd: 2.068768503987161 }] },
  { name: "Anilines_secondary", smarts: "[c:1]-[NX3+0:2]([H:3])[!H:4]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 4.335408163265306, pKaStd: 2.1768842022330843 }] },
  { name: "Anilines_tertiary", smarts: "[c:1]-[NX3+0:2]([!H:3])[!H:4]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 4.16690685045614, pKaStd: 2.005865735782679 }] },
  { name: "Aromatic_nitrogen_unprotonated", smarts: "[n+0&H0:1]", aromaticNitrogen: false, sites: [{ matchPosition: 0, pKaMean: 4.3535441240733945, pKaStd: 2.0714072661859584 }] },
  { name: "Amines_primary_secondary_tertiary", smarts: "[C:1]-[NX3+0:2]", aromaticNitrogen: false, sites: [{ matchPosition: 1, pKaMean: 8.159107682388349, pKaStd: 2.5183597445318147 }] },
  { name: "Phosphinic_acid", smarts: "[PX4:1](=[O:2])(-[C,c,N,n,F,Cl,Br,I:3])(-[C,c,N,n,F,Cl,Br,I:4])-[OX2:5]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 4, pKaMean: 2.9745, pKaStd: 0.6867886750744557 }] },
  { name: "Phosphate_diester", smarts: "[PX4:1](=[O:2])(-[OX2:3]-[C,c,N,n,F,Cl,Br,I:4])(-[O+0:5]-[C,c,N,n,F,Cl,Br,I:4])-[OX2:6]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 6, pKaMean: 2.7280434782608696, pKaStd: 2.5437448856908316 }] },
  { name: "Phosphonate_ester", smarts: "[PX4:1](=[O:2])(-[OX2:3]-[C,c,N,n,F,Cl,Br,I:4])(-[C,c,N,n,F,Cl,Br,I:5])-[OX2:6]-[H]", aromaticNitrogen: false, sites: [{ matchPosition: 5, pKaMean: 2.0868, pKaStd: 0.4503028610465036 }] },
  { name: "Primary_hydroxyl_amine", smarts: "[C,c:1]-[O:2]-[NH2:3]", aromaticNitrogen: false, sites: [{ matchPosition: 2, pKaMean: 4.035714285714286, pKaStd: 0.8463816543155368 }] },
  { name: "Indole_pyrrole", smarts: "[c;R:1]1[c;R:2][c;R:3][c;R:4][n;R:5]1[H]", aromaticNitrogen: true, sites: [{ matchPosition: 4, pKaMean: 14.52875, pKaStd: 4.06702491591416 }] },
  { name: "Aromatic_nitrogen_protonated", smarts: "[n:1]-[H]", aromaticNitrogen: true, sites: [{ matchPosition: 0, pKaMean: 7.17, pKaStd: 2.94602395490212 }] },];
