// Adapted from Avogadro's avogadro/calc/uff.cpp, uff.h and energycalculator.h at
// 416651ddaef33a4e20392392e7c0b505d446491b.
// Copyright (c) 2011-2020, Kitware, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// The Rust port replaces the calculator lifecycle with owned, immutable topology.

//! Nonperiodic Universal Force Field evaluation from an ordered mechanics graph.
//!
//! Coordinates are in Å, energies in kJ/mol and Cartesian gradients in
//! kJ/(mol·Å). The caller supplies every atom, including any hydrogens. The five
//! terms in pinned Avogadro UFF include no electrostatic term. Formal charge is
//! accepted as graph metadata and has no effect on typing or evaluation at this pin.
//!
//! ## Differences from the pinned implementation
//!
//! - Preparation validates the indexed graph and refuses shifted or cross-element
//!   parameter rows and angle coordinations that would use the harmonic fallback.
//!   [`PreparedUff::new`] also requires a validated type and coordination pairing.
//!   [`PreparedUff::new_for_parity_oracle`] bypasses that last check for the SF₆
//!   and Fe reference probes.
//! - Evaluation rebuilds the active pair list on every call with an inclusive
//!   10 Å cutoff. The cutoff trace records the pin's delayed rebuild in its
//!   persistent-model values and the expected native result in its fresh values.
//! - Distinct atoms less than 0.001 Å apart and undefined angles, torsion planes
//!   or inversion geometry return typed errors with atom indices. Defined
//!   geometries use analytic derivatives, including strained angles the pin
//!   suppresses. Bend energy and gradient share the angle computed with atan2
//!   of the cross-product magnitude and dot product. Collinear bends with a
//!   smooth energy retain their zero gradient. The Fe oracle retains the pin's
//!   zero gradient for exactly opposite angle arms, where the short-range
//!   correction has a cusp with a slope below numerical tolerance. Torsions
//!   use oriented plane normals.
//! - Wilson inversion uses an equivalent atan2 form. It refuses an inversion
//!   plane when the sine between its two arms is below 1e-6 and refuses the
//!   gradient when the absolute cosine of the out-of-plane angle is below 1e-8.
//!   The larger plane tolerance keeps roundoff from cancellation in the computed
//!   plane normal well below the gradient tolerance. The pin can return a zero
//!   or arbitrary gradient in these regimes.
//! - Nonfinite results return a typed error. A supplied coordinate mask zeros
//!   frozen components of the total gradient and leaves raw term results intact.
//!   This evaluator has no periodic-cell or general-restraint inputs.

mod geometry;
mod params;
mod terms;
mod topology;

#[cfg(test)]
mod tests;

use std::fmt;
use topology::Topology;

const KCAL_TO_KJ: f64 = 4.184;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Atom {
    pub atomic_number: u8,
    pub formal_charge: i32,
}

/// An integral single, double or triple bond between two zero-based atom indices.
/// Supply resolved integral orders for aromatic systems.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Bond {
    pub atoms: [usize; 2],
    pub order: u8,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct AtomType {
    pub row: usize,
    pub label: &'static str,
}

/// The numerical codes match the pinned upstream angle diagnostic.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum AngleCoordination {
    Linear = 1,
    Trigonal = 2,
    Tetrahedral = 3,
    SquarePlanar = 4,
    Octahedral = 6,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Term {
    Bond,
    Angle,
    Torsion,
    Inversion,
    VanDerWaals,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UffError {
    UnsupportedElement {
        atom_index: usize,
        atomic_number: u8,
    },
    UnsupportedAngleCoordination {
        atom_index: usize,
        atomic_number: u8,
        coordination: usize,
    },
    UnsupportedAtomType {
        atom_index: usize,
        atomic_number: u8,
        atom_type: AtomType,
        coordination: usize,
    },
    InvalidBondEndpoints {
        bond_index: usize,
        atoms: [usize; 2],
    },
    UnsupportedBondOrder {
        bond_index: usize,
        order: u8,
    },
    DuplicateBond {
        bond_index: usize,
        atoms: [usize; 2],
    },
    CoordinateCount {
        expected: usize,
        actual: usize,
    },
    CoordinateMaskLength {
        expected: usize,
        actual: usize,
    },
    NonFiniteCoordinate {
        atom_index: usize,
        axis: usize,
    },
    NearCoincidentAtoms {
        atoms: [usize; 2],
    },
    UndefinedAngleGradient {
        atoms: [usize; 3],
    },
    UndefinedTorsionPlane {
        atoms: [usize; 3],
    },
    UndefinedInversionPlane {
        atoms: [usize; 3],
    },
    UndefinedInversionGradient {
        atoms: [usize; 4],
    },
    NonFiniteResult {
        term: Option<Term>,
    },
}

impl fmt::Display for UffError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedElement {
                atom_index,
                atomic_number,
            } => {
                write!(
                    f,
                    "unsupported element (atomic number {atomic_number}) at atom {atom_index}"
                )
            }
            Self::UnsupportedAngleCoordination {
                atom_index,
                atomic_number,
                coordination,
            } => write!(
                f,
                "UFF harmonic angle fallback for atom {atom_index} (atomic number {atomic_number}, coordination {coordination})"
            ),
            Self::UnsupportedAtomType {
                atom_index,
                atomic_number,
                atom_type,
                coordination,
            } => write!(
                f,
                "unvalidated UFF type {} at atom {atom_index} (atomic number {atomic_number}, coordination {coordination})",
                atom_type.label,
            ),
            Self::InvalidBondEndpoints { bond_index, atoms } => {
                write!(f, "invalid endpoints {atoms:?} at bond {bond_index}")
            }
            Self::UnsupportedBondOrder { bond_index, order } => {
                write!(f, "unsupported integral order {order} at bond {bond_index}")
            }
            Self::DuplicateBond { bond_index, atoms } => {
                write!(f, "duplicate endpoints {atoms:?} at bond {bond_index}")
            }
            Self::CoordinateCount { expected, actual } => {
                write!(f, "expected coordinates for {expected} atoms, got {actual}")
            }
            Self::CoordinateMaskLength { expected, actual } => {
                write!(f, "expected {expected} coordinate mask entries, got {actual}")
            }
            Self::NonFiniteCoordinate { atom_index, axis } => {
                write!(f, "nonfinite coordinate at atom {atom_index}, axis {axis}")
            }
            Self::NearCoincidentAtoms { atoms: [a, b] } => {
                write!(f, "atoms {a} and {b} are less than 0.001 Å apart")
            }
            Self::UndefinedAngleGradient { atoms } => {
                write!(f, "undefined UFF angle gradient at atoms {atoms:?}")
            }
            Self::UndefinedTorsionPlane { atoms } => {
                write!(f, "undefined UFF torsion plane at atoms {atoms:?}")
            }
            Self::UndefinedInversionPlane { atoms } => {
                write!(f, "undefined UFF inversion plane at atoms {atoms:?}")
            }
            Self::UndefinedInversionGradient { atoms } => {
                write!(f, "undefined UFF inversion gradient at atoms {atoms:?}")
            }
            Self::NonFiniteResult { term: Some(term) } => {
                write!(f, "nonfinite UFF {term:?} result")
            }
            Self::NonFiniteResult { term: None } => write!(f, "nonfinite total UFF result"),
        }
    }
}

impl std::error::Error for UffError {}

#[derive(Debug, PartialEq)]
pub struct EnergyGradient {
    /// kJ/mol
    pub energy: f64,
    /// kJ/(mol·Å), in input atom order with x, y and z components per atom.
    pub gradient: Vec<[f64; 3]>,
}

#[derive(Debug, PartialEq)]
pub struct TermEvaluation<const N: usize> {
    pub result: EnergyGradient,
    /// Interaction tuples in upstream order. Inversion tuples start with the
    /// central atom. Van der Waals tuples include only pairs within the cutoff.
    pub tuples: Vec<[usize; N]>,
}

#[derive(Debug, PartialEq)]
pub struct Evaluation {
    pub total: EnergyGradient,
    pub bond: TermEvaluation<2>,
    pub angle: TermEvaluation<3>,
    pub torsion: TermEvaluation<4>,
    pub inversion: TermEvaluation<4>,
    pub van_der_waals: TermEvaluation<2>,
}

#[derive(Debug)]
pub struct PreparedUff {
    atom_count: usize,
    topology: Topology,
}

impl PreparedUff {
    /// Prepare topology for app use, requiring a validated (type, neighbor count)
    /// pairing for every atom.
    pub fn new(atoms: &[Atom], bonds: &[Bond]) -> Result<Self, UffError> {
        Ok(Self {
            atom_count: atoms.len(),
            topology: Topology::new(atoms, bonds, topology::Preparation::Checked)?,
        })
    }

    /// Prepare the SF₆ and Fe parity probes using the pin's assignments. Graph,
    /// parameter-row and harmonic-fallback checks still apply.
    pub fn new_for_parity_oracle(atoms: &[Atom], bonds: &[Bond]) -> Result<Self, UffError> {
        Ok(Self {
            atom_count: atoms.len(),
            topology: Topology::new(atoms, bonds, topology::Preparation::ParityOracle)?,
        })
    }

    /// Type assignments in atom order. The pin skips setup on graphs of size zero
    /// or one, so those graphs have an empty assignment list.
    pub fn atom_types(&self) -> &[AtomType] {
        &self.topology.atom_types
    }

    pub fn angle_coordinations(&self) -> impl ExactSizeIterator<Item = AngleCoordination> + '_ {
        self.topology.angles.iter().map(|angle| angle.coordination)
    }

    /// Sorted 1–2 and 1–3 exclusions.
    pub fn excluded_pairs(&self) -> &[[usize; 2]] {
        &self.topology.excluded_pairs
    }

    /// Evaluate all terms and analytic gradients at a geometry in Å.
    pub fn evaluate(&self, coordinates: &[[f64; 3]]) -> Result<Evaluation, UffError> {
        if coordinates.len() != self.atom_count {
            return Err(UffError::CoordinateCount {
                expected: self.atom_count,
                actual: coordinates.len(),
            });
        }
        for (atom_index, point) in coordinates.iter().enumerate() {
            if let Some(axis) = point.iter().position(|component| !component.is_finite()) {
                return Err(UffError::NonFiniteCoordinate { atom_index, axis });
            }
        }
        terms::evaluate(&self.topology, coordinates)
    }

    /// Evaluate with a mask of exactly 3N entries in atom order (x, y, z).
    /// True entries are mobile. False entries zero only the total gradient.
    pub fn evaluate_with_mask(
        &self,
        coordinates: &[[f64; 3]],
        mobile: &[bool],
    ) -> Result<Evaluation, UffError> {
        let expected = 3 * self.atom_count;
        if mobile.len() != expected {
            return Err(UffError::CoordinateMaskLength {
                expected,
                actual: mobile.len(),
            });
        }
        let mut evaluation = self.evaluate(coordinates)?;
        for (component, &mobile) in evaluation.total.gradient.iter_mut().flatten().zip(mobile) {
            if !mobile {
                *component = 0.0;
            }
        }
        Ok(evaluation)
    }
}
