// Adapted from Avogadro's avogadro/calc/uff.cpp and avogadro/core/graph.cpp,
// angleiterator.cpp and dihedraliterator.cpp at 416651ddaef33a4e20392392e7c0b505d446491b.
// Copyright (c) 2011-2020, Kitware, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// The Rust port builds ordered terms from indexed bonds and rejects mismatched type rows.

use super::geometry::{DEG_TO_RAD, RAD_TO_DEG};
use super::params::{Parameter, PARAMETERS, SCANNED_ROWS};
use super::{AngleCoordination, Atom, AtomType, Bond, UffError};
use std::collections::BTreeSet;

#[derive(Debug)]
pub(super) struct Stretch {
    pub atoms: [usize; 2],
    pub equilibrium: f64,
    pub stiffness: f64,
}

#[derive(Debug)]
pub(super) struct Bend {
    pub atoms: [usize; 3],
    pub equilibrium: f64,
    pub stiffness: f64,
    pub coefficients: [f64; 3],
    pub coordination: AngleCoordination,
    pub preserve_fe_oracle_boundary: bool,
}

#[derive(Debug)]
pub(super) struct Inversion {
    pub atoms: [usize; 4],
    pub stiffness: f64,
    pub coefficients: [f64; 3],
}

#[derive(Clone, Copy, Debug)]
pub(super) struct Torsion {
    pub atoms: [usize; 4],
    pub period: f64,
    pub phase_cosine: f64,
    pub barrier: f64,
}

#[derive(Debug)]
pub(super) struct VanDerWaals {
    pub atoms: [usize; 2],
    pub depth: f64,
    pub distance6: f64,
    pub distance12: f64,
}

#[derive(Clone, Copy)]
struct Neighbor {
    atom: usize,
    bond_index: usize,
}

#[derive(Debug, Default)]
pub(super) struct Topology {
    pub atom_types: Vec<AtomType>,
    pub bonds: Vec<Stretch>,
    pub angles: Vec<Bend>,
    pub torsions: Vec<Torsion>,
    pub inversions: Vec<Inversion>,
    pub van_der_waals: Vec<VanDerWaals>,
    pub excluded_pairs: Vec<[usize; 2]>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Preparation {
    Checked,
    ParityOracle,
}

impl Topology {
    pub fn new(atoms: &[Atom], bonds: &[Bond], preparation: Preparation) -> Result<Self, UffError> {
        let (neighbors, mut exclusions) = build_adjacency(atoms.len(), bonds)?;
        let types = atom_types(atoms, bonds, &neighbors)?;
        let parameters: Vec<_> = types
            .iter()
            .map(|atom_type| PARAMETERS[atom_type.row])
            .collect();
        let mut angle_coordinations = Vec::with_capacity(atoms.len());
        for (atom_index, adjacent) in neighbors.iter().enumerate() {
            let coordination = adjacent.len();
            let atomic_number = atoms[atom_index].atomic_number;
            let atom_type = types[atom_index];
            let angle_coordination = angle_coordination(parameters[atom_index], coordination)
                .ok_or(UffError::UnsupportedAngleCoordination {
                    atom_index,
                    atomic_number,
                    coordination,
                })?;
            if preparation == Preparation::Checked && !validated_type(atom_type.label, coordination)
            {
                return Err(UffError::UnsupportedAtomType {
                    atom_index,
                    atomic_number,
                    atom_type,
                    coordination,
                });
            }
            angle_coordinations.push(angle_coordination);
        }
        if atoms.len() < 2 {
            return Ok(Self::default());
        }

        let stretches: Vec<_> = bonds
            .iter()
            .map(|bond| stretch(bond, &parameters))
            .collect();
        let mut angles = Vec::new();
        let mut inversions = Vec::new();
        for (center, adjacent) in neighbors.iter().enumerate() {
            for (index, &first) in adjacent.iter().enumerate() {
                for &last in &adjacent[index + 1..] {
                    exclusions.insert(ordered_pair(first.atom, last.atom));
                    angles.push(bend(
                        first,
                        center,
                        last,
                        angle_coordinations[center],
                        &parameters,
                        &stretches,
                    ));
                }
            }
            if let [a, b, c] = adjacent.as_slice() {
                if let Some(term) = inversion([center, a.atom, b.atom, c.atom], &parameters) {
                    inversions.push(term);
                }
            }
        }

        let mut torsions = Vec::new();
        if atoms.len() >= 4 && bonds.len() >= 3 {
            for bond in bonds.iter().filter(|bond| bond.order == 1) {
                let [j, k] = ordered_pair(bond.atoms[0], bond.atoms[1]);
                let Some(term) = torsion(j, k, &parameters) else {
                    continue;
                };
                for i in neighbors[j].iter().map(|n| n.atom).filter(|&i| i != k) {
                    for l in neighbors[k].iter().map(|n| n.atom).filter(|&l| l != j) {
                        // The two outer atoms may coincide in a three-membered ring.
                        torsions.push(Torsion {
                            atoms: [i, j, k, l],
                            ..term
                        });
                    }
                }
            }
        }

        let mut nonbonded = Vec::new();
        for i in 0..atoms.len() {
            for j in i + 1..atoms.len() {
                if !exclusions.contains(&[i, j]) {
                    nonbonded.push(van_der_waals(i, j, &parameters));
                }
            }
        }
        Ok(Self {
            atom_types: types,
            bonds: stretches,
            angles,
            torsions,
            inversions,
            van_der_waals: nonbonded,
            excluded_pairs: exclusions.into_iter().collect(),
        })
    }
}

fn ordered_pair(a: usize, b: usize) -> [usize; 2] {
    [a.min(b), a.max(b)]
}

type Adjacency = Vec<Vec<Neighbor>>;
type Exclusions = BTreeSet<[usize; 2]>;

fn build_adjacency(atom_count: usize, bonds: &[Bond]) -> Result<(Adjacency, Exclusions), UffError> {
    let mut neighbors = vec![Vec::new(); atom_count];
    let mut exclusions = BTreeSet::new();
    for (bond_index, bond) in bonds.iter().enumerate() {
        let [a, b] = ordered_pair(bond.atoms[0], bond.atoms[1]);
        if a == b || b >= atom_count {
            return Err(UffError::InvalidBondEndpoints {
                bond_index,
                atoms: bond.atoms,
            });
        }
        if !(1..=3).contains(&bond.order) {
            return Err(UffError::UnsupportedBondOrder {
                bond_index,
                order: bond.order,
            });
        }
        if !exclusions.insert([a, b]) {
            return Err(UffError::DuplicateBond {
                bond_index,
                atoms: [a, b],
            });
        }
        // Avogadro sorts the endpoints of each bond and appends neighbors in bond order.
        neighbors[a].push(Neighbor {
            atom: b,
            bond_index,
        });
        neighbors[b].push(Neighbor {
            atom: a,
            bond_index,
        });
    }
    Ok((neighbors, exclusions))
}

fn atom_types(
    atoms: &[Atom],
    bonds: &[Bond],
    neighbors: &[Vec<Neighbor>],
) -> Result<Vec<AtomType>, UffError> {
    let mut rows = Vec::with_capacity(atoms.len());
    for (atom_index, atom) in atoms.iter().enumerate() {
        let z = atom.atomic_number;
        let error = UffError::UnsupportedElement {
            atom_index,
            atomic_number: z,
        };
        if !(1..=50).contains(&z) {
            return Err(error);
        }
        let first = PARAMETERS[..SCANNED_ROWS]
            .iter()
            .position(|parameter| parameter.element == z)
            .ok_or(error)?;
        let adjacent = &neighbors[atom_index];

        let next = first + 1;
        let row = if next >= SCANNED_ROWS || PARAMETERS[next].element != z {
            first
        } else if z == 1 {
            if adjacent.len() == 1 {
                first
            } else {
                next
            }
        } else if adjacent.len() > 4 {
            // The pin checks the first two rows, keeping the first when neither matches.
            let coordination = Some(b'0'.wrapping_add(adjacent.len() as u8));
            if PARAMETERS[first].coordination() != coordination
                && PARAMETERS[next].coordination() == coordination
            {
                next
            } else {
                first
            }
        } else {
            let mut doubles = 0;
            let mut triples = 0;
            for neighbor in adjacent {
                match bonds[neighbor.bond_index].order {
                    2 => doubles += 1,
                    3 => triples += 1,
                    _ => {}
                }
            }
            let coordination = if triples > 0 || doubles > 1 {
                b'1'
            } else if doubles == 1 {
                b'2'
            } else {
                b'3'
            };
            // Upstream keeps scanning across elements. Refuse as soon as the scan
            // leaves this element, including the shifted Sb row stored under Sn.
            (first..SCANNED_ROWS)
                .take_while(|&row| row_matches_element(row, z))
                .find(|&row| PARAMETERS[row].coordination() == Some(coordination))
                .ok_or(error)?
        };
        if !row_matches_element(row, z) {
            return Err(error);
        }
        rows.push(row);
    }

    // Upstream mutates rows in atom order. Later atoms see the resonance types
    // already assigned to earlier neighbors.
    for (i, atom) in atoms.iter().enumerate() {
        let z = atom.atomic_number;
        let row = rows[i];
        let coordination = PARAMETERS[row].coordination();
        if !matches!(z, 6 | 7 | 8 | 16)
            || (z == 6 && coordination == Some(b'3'))
            || (matches!(z, 8 | 16) && neighbors[i].len() == 1)
            || !neighbors[i].iter().any(|adjacent| {
                matches!(
                    PARAMETERS[rows[adjacent.atom]].coordination(),
                    Some(b'2' | b'R')
                )
            })
        {
            continue;
        }

        let next = match (z, coordination) {
            (7, Some(b'3')) => Some(row + 1),
            (8, Some(b'3')) => Some(row + 2),
            (16, Some(b'3')) => (row..SCANNED_ROWS)
                .take_while(|&candidate| row_matches_element(candidate, z))
                .find(|&candidate| PARAMETERS[candidate].coordination() == Some(b'R')),
            _ => row.checked_sub(1),
        };
        rows[i] = next
            .filter(|&candidate| row_matches_element(candidate, z))
            .ok_or(UffError::UnsupportedElement {
                atom_index: i,
                atomic_number: z,
            })?;
    }

    Ok(rows
        .into_iter()
        .map(|row| AtomType {
            row,
            label: PARAMETERS[row].label,
        })
        .collect())
}

fn row_matches_element(row: usize, z: u8) -> bool {
    row < SCANNED_ROWS
        && PARAMETERS[row].element == z
        && (z != 50 || PARAMETERS[row].label == "Sn3")
}

fn validated_type(label: &str, coordination: usize) -> bool {
    // Neighbor counts observed in the supported explicit-H and drawn-atom fixtures.
    matches!(
        (label, coordination),
        ("C_3", 0..=4)
            | ("C_1", 1..=2)
            | ("C_R", 1..=3)
            | ("N_3", 1 | 4)
            | ("N_R", 1 | 3)
            | ("O_3", 0..=2)
            | ("O_R", 2)
            | ("H_" | "F_" | "O_2", 1)
            | ("Na" | "Cl", 0)
    )
}

fn resonance_order(a: Parameter, b: Parameter) -> Option<f64> {
    if a.coordination() != Some(b'R') || b.coordination() != Some(b'R') {
        return None;
    }
    let amide = matches!(
        (a.label.as_bytes()[0], b.label.as_bytes()[0]),
        (b'C', b'N') | (b'N', b'C')
    );
    Some(if amide { 1.41 } else { 1.5 })
}

fn stretch(bond: &Bond, parameters: &[Parameter]) -> Stretch {
    let atoms = ordered_pair(bond.atoms[0], bond.atoms[1]);
    let [a, b] = atoms.map(|index| parameters[index]);
    let [ri, rj] = [a.bond_radius, b.bond_radius].map(f64::from);
    let [chi_i, chi_j] = [a.electronegativity, b.electronegativity].map(f64::from);
    let [zi, zj] = [a.effective_charge, b.effective_charge].map(f64::from);
    let r0 = ri + rj;
    let order = resonance_order(a, b).unwrap_or(f64::from(bond.order));
    let order_correction = -0.1332 * r0 * order.ln();
    let electronegativity_correction =
        ri * rj * (chi_i.sqrt() - chi_j.sqrt()).powi(2) / (chi_i * ri + chi_j * rj);
    let equilibrium = r0 + order_correction - electronegativity_correction;
    Stretch {
        atoms,
        equilibrium,
        stiffness: 664.12 * zi * zj / equilibrium.powi(3),
    }
}

fn angle_coordination(parameter: Parameter, degree: usize) -> Option<AngleCoordination> {
    use AngleCoordination::*;
    // Follow the pin's precedence and refuse exactly the angle branches with
    // the harmonic fallback. Atoms with fewer than two neighbors have no bend.
    let coordination = match parameter.coordination() {
        _ if degree < 2 => Linear,
        None | Some(b'1') => Linear,
        Some(b'2' | b'R') if degree == 3 => Trigonal,
        Some(b'4') => SquarePlanar,
        Some(b'6') => Octahedral,
        Some(b'5') => return None,
        _ if degree > 6 => return None,
        _ => Tetrahedral,
    };
    Some(coordination)
}

fn bend(
    first: Neighbor,
    center: usize,
    last: Neighbor,
    coordination: AngleCoordination,
    parameters: &[Parameter],
    bonds: &[Stretch],
) -> Bend {
    use AngleCoordination::*;
    let atoms = [first.atom, center, last.atom];
    let [a, b, c] = atoms.map(|index| parameters[index]);
    let theta = f64::from(b.angle_degrees) * DEG_TO_RAD;
    let cosine = theta.cos();
    let rij = bonds[first.bond_index].equilibrium;
    let rjk = bonds[last.bond_index].equilibrium;
    let rik = (rij * rij + rjk * rjk - 2.0 * rij * rjk * cosine).sqrt();
    let zi_zk = f64::from(a.effective_charge) * f64::from(c.effective_charge);
    let mut stiffness = 664.12 / (rij * rjk) * zi_zk / rik.powi(5) * rij * rjk;
    stiffness *= 3.0 * rij * rjk * (1.0 - cosine * cosine) - rik * rik * cosine;
    let (divisor, coefficients) = match coordination {
        Linear => (1.0, [1.0, 0.0, 0.0]),
        Trigonal => (9.0, [3.0, 0.0, 0.0]),
        SquarePlanar | Octahedral => (16.0, [4.0, 0.0, 0.0]),
        Tetrahedral => {
            let sine = theta.sin();
            let c2 = 1.0 / (4.0 * sine * sine);
            (
                1.0,
                [c2 * (2.0 * cosine * cosine + 1.0), -4.0 * c2 * cosine, c2],
            )
        }
    };
    Bend {
        atoms,
        equilibrium: (theta * RAD_TO_DEG) * DEG_TO_RAD,
        stiffness: stiffness / divisor,
        coefficients,
        coordination,
        // Checked preparation refuses Fe6+2.
        preserve_fe_oracle_boundary: b.label == "Fe6+2",
    }
}

fn inversion(atoms: [usize; 4], parameters: &[Parameter]) -> Option<Inversion> {
    let [center, a, b, c] = atoms.map(|index| parameters[index].label);
    let (stiffness, coefficients) = match center {
        "N_R" | "N_2" | "O_R" | "O_2" => (6.0, [1.0, -1.0, 0.0]),
        "C_2" | "C_R" => {
            let stiffness = if [a, b, c].contains(&"O_2") {
                50.0
            } else {
                6.0
            };
            (stiffness, [1.0, -1.0, 0.0])
        }
        "P_3+3" | "As3+3" => {
            let angle = if center == "P_3+3" { 84.4339 } else { 86.9735 };
            let phi = angle * DEG_TO_RAD;
            let c1 = -4.0 * phi.cos();
            (22.0, [-c1 * phi.cos() + (2.0 * phi).cos(), c1, 1.0])
        }
        _ => return None,
    };
    Some(Inversion {
        atoms,
        stiffness,
        coefficients,
    })
}

fn torsion(j: usize, k: usize, parameters: &[Parameter]) -> Option<Torsion> {
    let [a, b] = [parameters[j], parameters[k]];
    let barrier_override = |z| match z {
        8 => Some(2.0),
        16 | 34 => Some(6.8),
        _ => None,
    };
    let [a_coord, b_coord] = [a.coordination(), b.coordination()];
    let (period, phase_cosine, barrier) =
        if matches!(a_coord, None | Some(b'3')) || matches!(b_coord, None | Some(b'3')) {
            let a_override = barrier_override(a.element);
            let b_override = barrier_override(b.element);
            let (period, phase) = if a_override.is_some() || b_override.is_some() {
                (2.0, 90.0)
            } else {
                (3.0, 60.0)
            };
            let a_barrier = a_override.unwrap_or(f64::from(a.torsion_barrier));
            let b_barrier = b_override.unwrap_or(f64::from(b.torsion_barrier));
            (
                period,
                (period * phase * DEG_TO_RAD).cos(),
                0.5 * (a_barrier * b_barrier).sqrt(),
            )
        } else {
            // The pin's subsequent sp2–sp3 branch is already covered by its sp3 branch.
            let order = resonance_order(a, b)?;
            let barrier = 5.0 * f64::from((a.torsion_u * b.torsion_u).sqrt());
            (
                2.0,
                (2.0 * 180.0 * DEG_TO_RAD).cos(),
                barrier * (0.5 * (1.0 + 4.18 * order.ln())),
            )
        };
    Some(Torsion {
        atoms: [0, j, k, 0],
        period,
        phase_cosine,
        barrier,
    })
}

fn van_der_waals(i: usize, j: usize, parameters: &[Parameter]) -> VanDerWaals {
    let [a, b] = [parameters[i], parameters[j]];
    // Both the product and its square root are float operations at the pin.
    let depth = f64::from((a.vdw_depth * b.vdw_depth).sqrt());
    let x = f64::from((a.vdw_distance * b.vdw_distance).sqrt());
    let x3 = x * x * x;
    let distance6 = x3 * x3;
    VanDerWaals {
        atoms: [i, j],
        depth,
        distance6,
        distance12: distance6 * distance6,
    }
}
