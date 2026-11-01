// Test corpus shared with the desktop integration suite. Expected neutral atomic masses use
// AME2020 nuclides, the native natural-isotope masses, and the native D/T masses 2.014102/3.016049.
export const isotopeFixtures = [
  { smiles: "[2H]/C=C/c1ccccc1", formula: "C8H7D", exactMass: 105.06888 },
  { smiles: "[2H]/C=C\\c1ccccc1", formula: "C8H7D", exactMass: 105.06888 },
  { smiles: "[2H]C(=C)c1ccccc1", formula: "C8H7D", exactMass: 105.06888 },
  { smiles: "[3H]/C=C/c1ccccc1", formula: "C8H7T", exactMass: 106.07082 },
  { smiles: "[3H]/C=C\\c1ccccc1", formula: "C8H7T", exactMass: 106.07082 },
  { smiles: "[3H]C(=C)c1ccccc1", formula: "C8H7T", exactMass: 106.07082 },
  { smiles: "[2H]C1(CC(=NO1)c1ccccc1)c1ccccc1", formula: "C15H12DNO", exactMass: 224.10599 },
  { smiles: "[2H]C1C(c2ccccc2)ON=C1c1ccccc1", formula: "C15H12DNO", exactMass: 224.10599 },
  { smiles: "[O-][N+]#Cc1ccccc1", formula: "C7H5NO", exactMass: 119.03711 },
  { smiles: "[13CH3]c1ccccc1", formula: "C6[13C]H8", exactMass: 93.06596 },
  { smiles: "c1cc[15n]cc1", formula: "C5H5[15N]", exactMass: 80.03923 },
  { smiles: "CC(=[18O])C", formula: "C3H6[18O]", exactMass: 60.04611 },
  { smiles: "[18OH]C(=O)c1ccccc1", formula: "C7H6O[18O]", exactMass: 124.04102 },
  { smiles: "[1H]C(Cl)(Cl)Cl", formula: "C[1H]Cl3", exactMass: 117.91438 }
] as const;
