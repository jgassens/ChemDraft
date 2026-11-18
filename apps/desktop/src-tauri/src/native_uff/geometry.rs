// Adapted from Avogadro's avogadro/calc/gradients.h and avogadro/core/angletools.h
// and avogadrocore.h at 416651ddaef33a4e20392392e7c0b505d446491b.
// Copyright (c) 2011-2020, Kitware, Inc.
// SPDX-License-Identifier: BSD-3-Clause
// The Rust port uses fixed-size scalar vectors and returns derivative arrays.

use super::UffError;
use std::f64::consts::PI;
use std::ops::{Add, Div, Mul, Neg, Sub};

pub(super) const DEG_TO_RAD: f64 = PI / 180.0;
pub(super) const RAD_TO_DEG: f64 = 180.0 / PI;

const INVERSION_PLANE_SINE_TOLERANCE: f64 = 1e-6;
const INVERSION_GRADIENT_COSINE_TOLERANCE: f64 = 1e-8;

#[derive(Clone, Copy)]
pub(super) struct Vector(pub [f64; 3]);

impl Vector {
    pub const ZERO: Self = Self([0.0; 3]);

    pub fn dot(self, other: Self) -> f64 {
        let [x, y, z] = self.0;
        let [u, v, w] = other.0;
        x * u + (y * v + z * w)
    }

    pub fn cross(self, other: Self) -> Self {
        let [x, y, z] = self.0;
        let [u, v, w] = other.0;
        Self([y * w - z * v, z * u - x * w, x * v - y * u])
    }

    pub fn norm(self) -> f64 {
        self.dot(self).sqrt()
    }

    // Raw cross products can span a wider range than the bond lengths.
    fn stable_norm(self) -> f64 {
        let [x, y, z] = self.0;
        x.hypot(y).hypot(z)
    }
}

impl Add for Vector {
    type Output = Self;

    fn add(self, rhs: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] + rhs.0[i]))
    }
}

impl Sub for Vector {
    type Output = Self;

    fn sub(self, rhs: Self) -> Self {
        Self(std::array::from_fn(|i| self.0[i] - rhs.0[i]))
    }
}

impl Mul<f64> for Vector {
    type Output = Self;

    fn mul(self, scalar: f64) -> Self {
        Self(self.0.map(|component| component * scalar))
    }
}

impl Div<f64> for Vector {
    type Output = Self;

    fn div(self, scalar: f64) -> Self {
        Self(self.0.map(|component| component / scalar))
    }
}

impl Neg for Vector {
    type Output = Self;

    fn neg(self) -> Self {
        Self(self.0.map(|component| -component))
    }
}

/// Angle at the central atom, with derivatives when the arms are noncollinear.
pub(super) fn bond_angle(ab: Vector, cb: Vector) -> (f64, Option<[Vector; 3]>) {
    let dot = ab.dot(cb);
    let cross = ab.cross(cb);
    let norm = cross.stable_norm();
    let angle = norm.atan2(dot);
    if norm == 0.0 {
        return (angle, None);
    }

    let normal = cross / norm;
    let cross_a = cb.cross(normal);
    let cross_c = normal.cross(ab);
    let cross_b = -(cross_a + cross_c);
    let dot_b = -(cb + ab);
    let denominator = norm * norm + dot * dot;
    let grad_a = (cross_a * dot - cb * norm) / denominator;
    let grad_b = (cross_b * dot - dot_b * norm) / denominator;
    let grad_c = (cross_c * dot - ab * norm) / denominator;
    (angle, Some([grad_a, grad_b, grad_c]))
}

/// Signed angle and gradient in the pinned i–j–k–l convention.
pub(super) fn dihedral(
    ij: Vector,
    jk: Vector,
    kl: Vector,
    atoms: [usize; 4],
) -> Result<(f64, [Vector; 4]), UffError> {
    let [i, j, k, l] = atoms;
    let [rij, rjk, rkl] = [ij, jk, kl].map(Vector::norm);
    let first_cross = ij.cross(jk);
    let last_cross = jk.cross(kl);
    let first_norm = first_cross.norm();
    let last_norm = last_cross.norm();
    if first_norm == 0.0 {
        return Err(UffError::UndefinedTorsionPlane { atoms: [i, j, k] });
    }
    if last_norm == 0.0 {
        return Err(UffError::UndefinedTorsionPlane { atoms: [j, k, l] });
    }

    let n1 = ij / rij;
    let n2 = jk / rjk;
    let n3 = kl / rkl;
    let first_normal = first_cross / first_norm;
    let last_normal = last_cross / last_norm;
    let phi = (n2
        .dot(first_normal.cross(last_normal))
        .atan2(first_normal.dot(last_normal))
        * RAD_TO_DEG)
        * DEG_TO_RAD;

    let first_cosine = n1.dot(n2).clamp(-1.0, 1.0);
    let last_cosine = n2.dot(n3).clamp(-1.0, 1.0);
    let i = -first_normal * (rjk / first_norm);
    let l = last_normal * (rjk / last_norm);
    let first_fraction = (rij / rjk) * -first_cosine;
    let last_fraction = (rkl / rjk) * -last_cosine;
    let j = i * (first_fraction - 1.0) - l * last_fraction;
    let k = -(i + l + j);
    Ok((phi, [i, j, k, l]))
}

/// Wilson out-of-plane angle and gradient, with the central atom first.
pub(super) fn out_of_plane(
    ab: Vector,
    ac: Vector,
    ad: Vector,
    atoms: [usize; 4],
) -> Result<(f64, [Vector; 4]), UffError> {
    let [rb, rc, rd] = [ab, ac, ad].map(Vector::norm);
    let normal = ab.cross(ac);
    let normal_length = normal.stable_norm();
    // The sine of the angle between the in-plane arms is |ab × ac| / (rb rc).
    if normal_length < INVERSION_PLANE_SINE_TOLERANCE * rb * rc {
        let [center, b, c, _] = atoms;
        return Err(UffError::UndefinedInversionPlane {
            atoms: [center, b, c],
        });
    }

    let cross = normal.cross(ad);
    let cross_length = cross.stable_norm();
    // |cos χ| is the sine of the angle between the arm and the plane normal.
    // The cross product measures it directly even near perpendicularity to the plane.
    if cross_length < INVERSION_GRADIENT_COSINE_TOLERANCE * normal_length * rd {
        return Err(UffError::UndefinedInversionGradient { atoms });
    }

    let u1 = ab / rb;
    let u2 = ac / rc;
    let u3 = ad / rd;
    let unit_normal = normal / normal_length;
    let chi = (normal.dot(ad).atan2(cross_length) * RAD_TO_DEG) * DEG_TO_RAD;
    // The cross products give unit tangents without subtracting nearly
    // parallel vectors as the out-of-plane arm approaches perpendicular.
    let tangent = cross / cross_length;
    let plane_gradient = tangent.cross(unit_normal);
    let d = u3.cross(tangent) / rd;
    let b = u2.cross(plane_gradient) * (rc / normal_length);
    let c = plane_gradient.cross(u1) * (rb / normal_length);
    let a = -(b + c + d);
    Ok((chi, [a, b, c, d]))
}
