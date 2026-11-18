// SPDX-License-Identifier: Apache-2.0

use super::*;

fn atom(atomic_number: u8) -> Atom {
    Atom {
        atomic_number,
        formal_charge: 0,
    }
}

#[test]
fn refuses_the_full_shifted_and_unparameterized_element_ranges() {
    for atomic_number in std::iter::once(0).chain(51..=u8::MAX) {
        assert_eq!(
            PreparedUff::new(&[atom(6), atom(atomic_number)], &[]).unwrap_err(),
            UffError::UnsupportedElement {
                atom_index: 1,
                atomic_number
            },
        );
    }
    assert_eq!(
        PreparedUff::new(&[atom(51)], &[]).unwrap_err(),
        UffError::UnsupportedElement {
            atom_index: 0,
            atomic_number: 51
        },
    );
}

#[test]
fn rejects_typing_that_crosses_elements() {
    for (atomic_number, order) in [(5, 3), (50, 2)] {
        assert_eq!(
            PreparedUff::new(
                &[atom(6), atom(atomic_number)],
                &[Bond {
                    atoms: [0, 1],
                    order
                }]
            )
            .unwrap_err(),
            UffError::UnsupportedElement {
                atom_index: 1,
                atomic_number
            },
        );
    }

    let error = PreparedUff::new(
        &[atom(50), atom(1)],
        &[Bond {
            atoms: [0, 1],
            order: 1,
        }],
    )
    .unwrap_err();
    assert!(matches!(
        error,
        UffError::UnsupportedAtomType {
            atom_index: 0,
            atomic_number: 50,
            atom_type: AtomType { label: "Sn3", .. },
            coordination: 1
        }
    ));
}

#[test]
fn refuses_the_harmonic_angle_fallback_at_preparation() {
    let atoms = [
        atom(6),
        atom(1),
        atom(1),
        atom(1),
        atom(1),
        atom(1),
        atom(1),
        atom(1),
    ];
    let bonds: Vec<_> = (1..atoms.len())
        .map(|index| Bond {
            atoms: [0, index],
            order: 1,
        })
        .collect();
    assert_eq!(
        PreparedUff::new(&atoms, &bonds).unwrap_err(),
        UffError::UnsupportedAngleCoordination {
            atom_index: 0,
            atomic_number: 6,
            coordination: 7,
        },
    );
}

#[test]
fn validates_bonds_and_coordinates() {
    let atoms = [atom(6), atom(1)];
    let bond = Bond {
        atoms: [0, 1],
        order: 1,
    };
    for atoms_in_bond in [[0, 0], [1, 2]] {
        assert_eq!(
            PreparedUff::new(
                &atoms,
                &[Bond {
                    atoms: atoms_in_bond,
                    ..bond
                }]
            )
            .unwrap_err(),
            UffError::InvalidBondEndpoints {
                bond_index: 0,
                atoms: atoms_in_bond
            },
        );
    }
    for order in [0, 4] {
        assert_eq!(
            PreparedUff::new(&atoms, &[Bond { order, ..bond }]).unwrap_err(),
            UffError::UnsupportedBondOrder {
                bond_index: 0,
                order
            },
        );
    }
    assert_eq!(
        PreparedUff::new(
            &atoms,
            &[
                bond,
                Bond {
                    atoms: [1, 0],
                    ..bond
                }
            ]
        )
        .unwrap_err(),
        UffError::DuplicateBond {
            bond_index: 1,
            atoms: [0, 1]
        },
    );
    let model = PreparedUff::new(&atoms, &[bond]).unwrap();
    assert_eq!(
        model.evaluate(&[[0.0; 3]]).unwrap_err(),
        UffError::CoordinateCount {
            expected: 2,
            actual: 1
        },
    );
    assert_eq!(
        model
            .evaluate(&[[0.0; 3], [0.0, f64::NAN, 1.0]])
            .unwrap_err(),
        UffError::NonFiniteCoordinate {
            atom_index: 1,
            axis: 1
        },
    );
}

#[test]
fn uses_an_inclusive_cutoff_and_rejects_a_nonbonded_overlap() {
    let model = PreparedUff::new(&[atom(11), atom(17)], &[]).unwrap();
    for (distance, inside) in [
        (10.000_001, false),
        (10.0, true),
        (9.999_999, true),
        (11.0, false),
    ] {
        let output = model.evaluate(&[[0.0; 3], [distance, 0.0, 0.0]]).unwrap();
        assert_eq!(!output.van_der_waals.tuples.is_empty(), inside);
        assert_eq!(output.total.energy < 0.0, inside);
    }
    assert_eq!(
        model.evaluate(&[[0.0; 3]; 2]).unwrap_err(),
        UffError::NearCoincidentAtoms { atoms: [0, 1] },
    );
}

fn check_gradient(
    model: &PreparedUff,
    coordinates: &[[f64; 3]],
    result: fn(&Evaluation) -> &EnergyGradient,
    step: f64,
) {
    let evaluated = model.evaluate(coordinates).unwrap();
    let mut perturbed = coordinates.to_vec();
    for (atom, point) in coordinates.iter().enumerate() {
        for (axis, &value) in point.iter().enumerate() {
            perturbed[atom][axis] = value + step;
            let plus = result(&model.evaluate(&perturbed).unwrap()).energy;
            perturbed[atom][axis] = value - step;
            let minus = result(&model.evaluate(&perturbed).unwrap()).energy;
            perturbed[atom][axis] = value;
            let numeric = (plus - minus) / (2.0 * step);
            let analytic = result(&evaluated).gradient[atom][axis];
            // Allow 1e-4 relative error with a 1e-4 kJ/(mol·Å) floor near zero.
            assert!(
                (numeric - analytic).abs() <= 1e-4_f64.max(1e-4 * numeric.abs()),
                "atom {atom}, axis {axis}: analytic {analytic}, numerical {numeric}"
            );
        }
    }
}

#[test]
fn rejects_near_coincident_hydrogen_and_differentiates_a_stretched_bond() {
    let model = PreparedUff::new(
        &[atom(1), atom(1)],
        &[Bond {
            atoms: [0, 1],
            order: 1,
        }],
    )
    .unwrap();
    assert_eq!(
        model.evaluate(&[[0.0; 3], [0.0005, 0.0, 0.0]]).unwrap_err(),
        UffError::NearCoincidentAtoms { atoms: [0, 1] },
    );
    check_gradient(
        &model,
        &[[0.0; 3], [3.0, 0.2, 0.1]],
        |evaluation| &evaluation.bond.result,
        1e-5,
    );
}

#[test]
fn differentiates_a_strained_water_angle() {
    let atoms = [atom(8), atom(1), atom(1)];
    let bonds = [
        Bond {
            atoms: [0, 1],
            order: 1,
        },
        Bond {
            atoms: [0, 2],
            order: 1,
        },
    ];
    let model = PreparedUff::new(&atoms, &bonds).unwrap();
    let theta: f64 = 0.05;
    let coordinates = [[0.0; 3], [1.0, 0.0, 0.0], [theta.cos(), theta.sin(), 0.0]];
    check_gradient(
        &model,
        &coordinates,
        |evaluation| &evaluation.angle.result,
        1e-5,
    );
    assert_eq!(
        model
            .evaluate(&[[0.0; 3], [1.0, 0.0, 0.0], [1.0, 0.0005, 0.0]])
            .unwrap_err(),
        UffError::NearCoincidentAtoms { atoms: [1, 2] },
    );
}

#[test]
fn rejects_a_collinear_peroxide_plane_and_differentiates_a_trans_torsion() {
    let atoms = [atom(1), atom(8), atom(8), atom(1)];
    let bonds = [
        Bond {
            atoms: [0, 1],
            order: 1,
        },
        Bond {
            atoms: [1, 2],
            order: 1,
        },
        Bond {
            atoms: [2, 3],
            order: 1,
        },
    ];
    let model = PreparedUff::new(&atoms, &bonds).unwrap();
    let collinear = [[-1.0, 0.0, 0.0], [0.0; 3], [1.5, 0.0, 0.0], [1.5, 1.0, 0.0]];
    assert_eq!(
        model.evaluate(&collinear).unwrap_err(),
        UffError::UndefinedTorsionPlane { atoms: [0, 1, 2] },
    );
    let trans = [
        [-0.5, 1.0, 0.0],
        [0.0; 3],
        [1.5, 0.0, 0.0],
        [2.0, -1.0, 0.0],
    ];
    check_gradient(
        &model,
        &trans,
        |evaluation| &evaluation.torsion.result,
        1e-5,
    );
}

fn formaldehyde() -> PreparedUff {
    let atoms = [atom(6), atom(8), atom(1), atom(1)];
    let bonds = [
        Bond {
            atoms: [0, 1],
            order: 2,
        },
        Bond {
            atoms: [0, 2],
            order: 1,
        },
        Bond {
            atoms: [0, 3],
            order: 1,
        },
    ];
    PreparedUff::new(&atoms, &bonds).unwrap()
}

#[test]
fn rejects_collinear_formaldehyde_bends_and_differentiates_near_zero() {
    let model = formaldehyde();
    // This near-zero bend keeps the inversion plane sine above the 1e-6 cutoff.
    let offset = 1e-5;
    let mut coordinates = [
        [0.0; 3],
        [1.0, 0.0, 0.0],
        [2.0, offset, 0.0],
        [0.0, 1.0, 0.0],
    ];
    let evaluated = model.evaluate(&coordinates).unwrap();
    let analytic = evaluated.angle.result.gradient[2][1];
    // Stay on the same side of the cusp and compare the component that sees it.
    let step = 1e-10;
    coordinates[2][1] = offset + step;
    let plus = model.evaluate(&coordinates).unwrap().angle.result.energy;
    coordinates[2][1] = offset - step;
    let minus = model.evaluate(&coordinates).unwrap().angle.result.energy;
    let numeric = (plus - minus) / (2.0 * step);
    assert!(
        analytic < 0.0 && (analytic - numeric).abs() <= 1e-6 * analytic.abs(),
        "analytic {analytic}, numerical {numeric}"
    );

    for x in [2.0, -2.0] {
        coordinates[2] = [x, 0.0, 0.0];
        assert_eq!(
            model.evaluate(&coordinates).unwrap_err(),
            UffError::UndefinedAngleGradient { atoms: [1, 0, 2] },
        );
    }
}

#[test]
fn rejects_a_perpendicular_inversion_and_differentiates_near_it() {
    let model = formaldehyde();
    for mut coordinates in [
        [[0.0; 3], [1.2, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
        [
            [0.0; 3],
            [0.0, 0.5, 1.0],
            [0.5, 1.0, 0.5],
            [-0.9375, 0.625, -0.3125], // 1.25 times the raw plane normal.
        ],
    ] {
        assert_eq!(
            model.evaluate(&coordinates).unwrap_err(),
            UffError::UndefinedInversionGradient {
                atoms: [0, 1, 2, 3]
            },
        );
        coordinates[3][0] += 5e-7;
        check_gradient(
            &model,
            &coordinates,
            |evaluation| &evaluation.inversion.result,
            1e-9,
        );
    }
}

#[test]
fn rejects_inversions_below_the_plane_or_gradient_tolerance() {
    let model = formaldehyde();
    for (arms, error) in [
        (
            [[0.49, 0.51, -1.0], [-0.491, -0.509, 1.0], [0.5; 3]],
            UffError::UndefinedInversionGradient {
                atoms: [0, 1, 2, 3],
            },
        ),
        (
            [[1.0, 0.0, 0.0], [2.0, 1e-15, 0.0], [0.0, 1.0, 0.0]],
            UffError::UndefinedInversionPlane { atoms: [0, 1, 2] },
        ),
        (
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [1e-15, 1e-15, 1.0]],
            UffError::UndefinedInversionGradient {
                atoms: [0, 1, 2, 3],
            },
        ),
        // Both ratios are also refused well above floating-point roundoff.
        (
            [[1.0, 0.0, 0.0], [2.0, 1e-8, 0.0], [0.0, 1.0, 0.0]],
            UffError::UndefinedInversionPlane { atoms: [0, 1, 2] },
        ),
        (
            [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [3e-9, 4e-9, 1.0]],
            UffError::UndefinedInversionGradient {
                atoms: [0, 1, 2, 3],
            },
        ),
        // At a plane sine of about 1.27e-8, cancellation can mask a singular gradient.
        (
            [
                [0.62, 0.44, 0.6],
                [-0.620000016, -0.439999998, -0.600000002],
                [-0.1740757, -0.69965043, 0.69295521],
            ],
            UffError::UndefinedInversionPlane { atoms: [0, 1, 2] },
        ),
    ] {
        let [a, b, c] = arms;
        assert_eq!(
            model.evaluate(&[[0.0; 3], a, b, c]).unwrap_err(),
            error,
            "arms {arms:?}",
        );
    }
}

#[test]
fn differentiates_inversions_above_the_plane_and_gradient_tolerances() {
    let model = formaldehyde();
    for coordinates in [
        // The in-plane sine of about 1e-4 leaves room for both samples above the cutoff.
        [[0.0; 3], [1.0, 0.0, 0.0], [2.0, 2e-4, 0.0], [0.0, 1.0, 0.5]],
        // The absolute cosine of the out-of-plane angle is approximately 1e-6.
        [
            [0.0; 3],
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [6e-7, 8e-7, 1.0],
        ],
    ] {
        // This displacement keeps both samples outside the degeneracy tolerances.
        check_gradient(
            &model,
            &coordinates,
            |evaluation| &evaluation.inversion.result,
            1e-9,
        );
    }
}

#[test]
fn prepared_model_and_results_can_cross_threads() {
    fn require_send_sync<T: Send + Sync>() {}
    require_send_sync::<PreparedUff>();
    require_send_sync::<Evaluation>();
    require_send_sync::<UffError>();
}
