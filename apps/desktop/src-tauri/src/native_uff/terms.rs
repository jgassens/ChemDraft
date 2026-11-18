// Adapted from Avogadro's avogadro/calc/uff.cpp and energycalculator.cpp at
// 416651ddaef33a4e20392392e7c0b505d446491b.
// Copyright (c) 2011-2020, Kitware, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// The Rust port returns per-term results, checks finiteness and applies the cutoff on each call.

use super::geometry::{bond_angle, dihedral, out_of_plane, Vector};
use super::topology::{Bend, Inversion, Stretch, Topology, Torsion, VanDerWaals};
use super::{
    AngleCoordination, EnergyGradient, Evaluation, Term, TermEvaluation, UffError, KCAL_TO_KJ,
};

const VDW_CUTOFF_SQUARED: f64 = 100.0;
// Treat distances strictly below 0.001 Å as overlapping.
const MIN_ATOM_DISTANCE_SQUARED: f64 = 1e-6;

pub(super) fn evaluate(
    topology: &Topology,
    coordinates: &[[f64; 3]],
) -> Result<Evaluation, UffError> {
    // The van der Waals pass checks all remaining pairs.
    for &atoms in &topology.excluded_pairs {
        let [a, b] = atoms.map(|index| Vector(coordinates[index]));
        let delta = a - b;
        if delta.dot(delta) < MIN_ATOM_DISTANCE_SQUARED {
            return Err(UffError::NearCoincidentAtoms { atoms });
        }
    }
    let mut total = zero_result(coordinates.len());
    let bond = accumulate(
        topology
            .bonds
            .iter()
            .map(|term| (term.atoms, Ok(stretch(term, coordinates)))),
        Term::Bond,
        &mut total,
    )?;
    let angle = accumulate(
        topology
            .angles
            .iter()
            .map(|term| (term.atoms, bend(term, coordinates))),
        Term::Angle,
        &mut total,
    )?;
    let torsion = accumulate(
        topology
            .torsions
            .iter()
            .map(|term| (term.atoms, torsion(term, coordinates))),
        Term::Torsion,
        &mut total,
    )?;
    let inversion = accumulate(
        topology
            .inversions
            .iter()
            .map(|term| (term.atoms, inversion(term, coordinates))),
        Term::Inversion,
        &mut total,
    )?;
    let van_der_waals = accumulate(
        topology
            .van_der_waals
            .iter()
            .filter_map(|term| van_der_waals(term, coordinates).map(|value| (term.atoms, value))),
        Term::VanDerWaals,
        &mut total,
    )?;
    convert_and_validate(&mut total, None)?;
    Ok(Evaluation {
        total,
        bond,
        angle,
        torsion,
        inversion,
        van_der_waals,
    })
}

type Contribution<const N: usize> = (f64, [Vector; N]);

fn accumulate<const N: usize>(
    interactions: impl Iterator<Item = ([usize; N], Result<Contribution<N>, UffError>)>,
    term: Term,
    total: &mut EnergyGradient,
) -> Result<TermEvaluation<N>, UffError> {
    let mut result = zero_result(total.gradient.len());
    let mut tuples = Vec::new();
    for (atoms, contribution) in interactions {
        let (energy, gradient) = contribution?;
        // Accumulate the total in upstream interaction order before conversion.
        result.energy += energy;
        total.energy += energy;
        for (atom, vector) in atoms.into_iter().zip(gradient) {
            for (axis, value) in vector.0.into_iter().enumerate() {
                result.gradient[atom][axis] += value;
                total.gradient[atom][axis] += value;
            }
        }
        tuples.push(atoms);
    }
    convert_and_validate(&mut result, Some(term))?;
    Ok(TermEvaluation { result, tuples })
}

fn zero_result(atoms: usize) -> EnergyGradient {
    EnergyGradient {
        energy: 0.0,
        gradient: vec![[0.0; 3]; atoms],
    }
}

fn convert_and_validate(result: &mut EnergyGradient, term: Option<Term>) -> Result<(), UffError> {
    result.energy *= KCAL_TO_KJ;
    if !result.energy.is_finite() {
        return Err(UffError::NonFiniteResult { term });
    }
    for value in result.gradient.iter_mut().flatten() {
        *value *= KCAL_TO_KJ;
        if !value.is_finite() {
            return Err(UffError::NonFiniteResult { term });
        }
    }
    Ok(())
}

fn stretch(term: &Stretch, x: &[[f64; 3]]) -> Contribution<2> {
    let [a, b] = term.atoms.map(|index| Vector(x[index]));
    let delta = a - b;
    let radius = delta.norm();
    let extension = radius - term.equilibrium;
    let energy = term.stiffness * extension * extension;
    let gradient = (delta / radius) * (2.0 * term.stiffness * extension);
    (energy, [gradient, -gradient])
}

fn bend(term: &Bend, x: &[[f64; 3]]) -> Result<Contribution<3>, UffError> {
    use AngleCoordination::*;
    let [a, b, c] = term.atoms.map(|index| Vector(x[index]));
    let [ab, cb] = [a - b, c - b];
    let (theta, derivatives) = bond_angle(ab, cb);
    let k = term.stiffness;
    let [c0, c1, c2] = term.coefficients;
    let (energy, derivative) = match term.coordination {
        Linear => {
            let (sine, cosine) = (c0 * theta).sin_cos();
            (k * (1.0 + cosine), -k * c0 * sine)
        }
        Trigonal | SquarePlanar | Octahedral => {
            let (sine, cosine) = (c0 * theta).sin_cos();
            let repulsion = (-20.0 * (theta - term.equilibrium + 0.25)).exp();
            (
                k * (1.0 - cosine) + repulsion,
                k * c0 * sine - 20.0 * repulsion,
            )
        }
        Tetrahedral => {
            let (sine, cosine) = theta.sin_cos();
            (
                k * (c0 + c1 * cosine + c2 * (2.0 * cosine * cosine - 1.0)),
                -k * (c1 * sine + c2 * 2.0 * (2.0 * cosine * sine)),
            )
        }
    };

    let Some(derivatives) = derivatives else {
        // Linear and tetrahedral energies are smooth functions of cos(theta).
        // The periodic branches also have an exponential in theta itself.
        if matches!(term.coordination, Linear | Tetrahedral)
            || (term.preserve_fe_oracle_boundary && ab.dot(cb) < 0.0)
        {
            return Ok((energy, [Vector::ZERO; 3]));
        }
        return Err(UffError::UndefinedAngleGradient { atoms: term.atoms });
    };
    Ok((energy, derivatives.map(|value| value * derivative)))
}

fn torsion(term: &Torsion, x: &[[f64; 3]]) -> Result<Contribution<4>, UffError> {
    let [i, j, k, l] = term.atoms.map(|index| Vector(x[index]));
    let (phi, derivatives) = dihedral(j - i, k - j, l - k, term.atoms)?;
    let phase = term.period * phi;
    let energy = term.barrier * (1.0 - term.phase_cosine * phase.cos());
    let derivative = term.barrier * term.period * phase.sin() * term.phase_cosine;
    Ok((energy, derivatives.map(|value| value * derivative)))
}

fn inversion(term: &Inversion, x: &[[f64; 3]]) -> Result<Contribution<4>, UffError> {
    let [center, a, b, c] = term.atoms.map(|index| Vector(x[index]));
    let (chi, derivatives) = out_of_plane(a - center, b - center, c - center, term.atoms)?;
    let [c0, c1, c2] = term.coefficients;
    let energy = term.stiffness * (c0 + c1 * chi.cos() + c2 * (2.0 * chi).cos());
    let derivative = term.stiffness * (-c1 * chi.sin() - 2.0 * c2 * (2.0 * chi).sin());
    Ok((energy, derivatives.map(|value| value * derivative)))
}

fn van_der_waals(term: &VanDerWaals, x: &[[f64; 3]]) -> Option<Result<Contribution<2>, UffError>> {
    let [a, b] = term.atoms.map(|index| Vector(x[index]));
    let delta = a - b;
    let r2 = delta.dot(delta);
    if r2 > VDW_CUTOFF_SQUARED {
        return None;
    }
    if r2 < MIN_ATOM_DISTANCE_SQUARED {
        return Some(Err(UffError::NearCoincidentAtoms { atoms: term.atoms }));
    }
    let r6 = r2 * r2 * r2;
    let energy = term.depth * (term.distance12 / (r6 * r6) - 2.0 * term.distance6 / r6);
    let radius = r2.sqrt();
    let derivative =
        12.0 * term.depth * term.distance6 / (r6 * radius) * (1.0 - term.distance6 / r6);
    let gradient = (delta / radius) * derivative;
    Some(Ok((energy, [gradient, -gradient])))
}
