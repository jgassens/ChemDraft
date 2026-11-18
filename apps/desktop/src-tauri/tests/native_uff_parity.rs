// SPDX-License-Identifier: Apache-2.0

mod uff_reference_fixtures;

use chemdraft_lib::native_uff::{
    Atom, Bond, EnergyGradient, Evaluation, PreparedUff, TermEvaluation, UffError,
};
use std::collections::BTreeMap;
use uff_reference_fixtures::{close, for_each_fixture_graph, Snapshot, KCAL_TO_KJ};

const NAMES: [&str; 6] = ["bond", "angle", "torsion", "oop", "vdw", "total"];

// Coverage from tools/spin3d-ff-reference/inventory.json, pinned independently
// of the generated fixture manifest. Each entry counts graph variants and snapshots.
const EXPECTED_COVERAGE: &[(&str, usize, usize)] = &[
    ("2-butanol-r", 2, 4),
    ("2-butanol-s", 2, 4),
    ("2-butanol-unspecified", 2, 4),
    ("2-butene-e", 2, 4),
    ("2-butene-unspecified", 2, 4),
    ("2-butene-z", 2, 4),
    ("acetamide", 2, 4),
    ("acetate", 2, 4),
    ("acetylene", 2, 4),
    ("antimony-trihydride", 2, 4),
    ("benzene", 4, 8),
    ("charged-pair", 1, 2),
    ("cyclohexane-chair", 2, 6),
    ("cyclopropane", 2, 4),
    ("element-scan-probe", 1, 1),
    ("ethanol", 2, 4),
    ("formaldehyde", 2, 4),
    ("furan", 2, 4),
    ("hydrogen-peroxide", 2, 4),
    ("iodomethane", 2, 4),
    ("iron-hexafluoride", 1, 2),
    ("methane", 2, 4),
    ("methylammonium", 2, 4),
    ("n-butane", 2, 6),
    ("naphthalene", 4, 8),
    ("sulfur-hexafluoride", 1, 2),
    ("water", 2, 6),
];

#[derive(Default)]
struct WorstError {
    absolute: f64,
    location: String,
}

impl WorstError {
    fn record(&mut self, actual: f64, reference: f64, context: &str) {
        let absolute = (actual - reference).abs();
        if absolute > self.absolute {
            self.absolute = absolute;
            self.location = context.to_string();
        }
    }
}

#[derive(Default)]
struct Errors {
    energy: WorstError,
    gradient: WorstError,
}

fn compare_values(
    actual: &EnergyGradient,
    expected_energy: f64,
    expected_gradient: impl IntoIterator<Item = f64>,
    errors: &mut Errors,
    context: &str,
) {
    close(actual.energy, expected_energy, 1e-6, 1e-8, context);
    errors
        .energy
        .record(actual.energy, expected_energy, context);
    let expected_gradient: Vec<_> = expected_gradient.into_iter().collect();
    assert_eq!(
        actual.gradient.len() * 3,
        expected_gradient.len(),
        "{context}"
    );
    for (component, (&actual, expected)) in actual
        .gradient
        .iter()
        .flatten()
        .zip(expected_gradient)
        .enumerate()
    {
        let context = format!("{context} gradient component {component}");
        close(actual, expected, 2e-5, 1e-7, &context);
        errors.gradient.record(actual, expected, &context);
    }
}

fn compare_term<const N: usize>(
    actual: &TermEvaluation<N>,
    reference: &Snapshot,
    name: &str,
    errors: &mut Errors,
    context: &str,
) {
    let context = format!("{context} {name}");
    let tuples = &reference.topology.tuples[name];
    assert_eq!(actual.tuples.len(), tuples.len(), "{context}: term count");
    for (actual, expected) in actual.tuples.iter().zip(tuples) {
        assert_eq!(actual.as_slice(), expected, "{context}: tuple");
    }
    let expected = &reference.terms[name];
    compare_values(
        &actual.result,
        expected.energy_kcal_mol * KCAL_TO_KJ,
        expected
            .gradient_kcal_mol_angstrom
            .iter()
            .map(|value| value * KCAL_TO_KJ),
        errors,
        &context,
    );
}

fn compare_snapshot(
    model: &PreparedUff,
    actual: &Evaluation,
    reference: &Snapshot,
    errors: &mut [Errors; 6],
    context: &str,
) {
    let expected_types = &reference.topology.atom_types;
    assert_eq!(
        model.atom_types().len(),
        expected_types.len(),
        "{context}: typed atoms"
    );
    for (index, (actual, expected)) in model.atom_types().iter().zip(expected_types).enumerate() {
        let label = expected["label"].as_str().unwrap();
        let row = expected["row"].as_u64().unwrap();
        assert_eq!(actual.label, label, "{context}: atom {index} label");
        assert_eq!(actual.row as u64, row, "{context}: atom {index} row");
    }
    let angle_coordinations: Vec<_> = model
        .angle_coordinations()
        .map(|value| value as usize)
        .collect();
    assert_eq!(
        angle_coordinations, reference.topology.angle_coordinations,
        "{context}: angle coordination"
    );
    assert_eq!(
        model.excluded_pairs(),
        reference.topology.excluded_pairs,
        "{context}: excluded pairs"
    );

    compare_term(&actual.bond, reference, NAMES[0], &mut errors[0], context);
    compare_term(&actual.angle, reference, NAMES[1], &mut errors[1], context);
    compare_term(
        &actual.torsion,
        reference,
        NAMES[2],
        &mut errors[2],
        context,
    );
    compare_term(
        &actual.inversion,
        reference,
        NAMES[3],
        &mut errors[3],
        context,
    );
    compare_term(
        &actual.van_der_waals,
        reference,
        NAMES[4],
        &mut errors[4],
        context,
    );
    compare_values(
        &actual.total,
        reference.total.evaluate_kj_mol,
        reference
            .total
            .derivatives
            .gradient_kj_mol_angstrom
            .iter()
            .copied(),
        &mut errors[5],
        &format!("{context} total"),
    );
    close(
        actual.total.energy,
        reference.total.value_kj_mol,
        1e-6,
        1e-8,
        context,
    );
}

fn results(evaluation: &Evaluation) -> [&EnergyGradient; 6] {
    [
        &evaluation.bond.result,
        &evaluation.angle.result,
        &evaluation.torsion.result,
        &evaluation.inversion.result,
        &evaluation.van_der_waals.result,
        &evaluation.total,
    ]
}

fn check_central_differences(
    model: &PreparedUff,
    coordinates: &[[f64; 3]],
    actual: &Evaluation,
    context: &str,
) {
    let mut perturbed = coordinates.to_vec();
    for (atom, point) in coordinates.iter().enumerate() {
        for (axis, &value) in point.iter().enumerate() {
            for step in [1e-5, 5e-6] {
                perturbed[atom][axis] = value + step;
                let plus = model.evaluate(&perturbed).unwrap();
                perturbed[atom][axis] = value - step;
                let minus = model.evaluate(&perturbed).unwrap();
                perturbed[atom][axis] = value;
                for (((name, analytic), plus), minus) in NAMES
                    .into_iter()
                    .zip(results(actual))
                    .zip(results(&plus))
                    .zip(results(&minus))
                {
                    close(
                        analytic.gradient[atom][axis],
                        (plus.energy - minus.energy) / (2.0 * step),
                        1e-4,
                        1e-4,
                        &format!("{context} {name}, central difference h={step}, atom {atom}, axis {axis}"),
                    );
                }
            }
        }
    }
}

fn expected_refusals(case: &str) -> &'static [u8] {
    match case {
        "iodomethane" => &[53],
        "antimony-trihydride" => &[51],
        "element-scan-probe" => &[54, 55, 71, 74, 86, 100, 101, 102, 103],
        _ => &[],
    }
}

fn prepare_compared_case(
    case: &str,
    atoms: &[Atom],
    bonds: &[Bond],
) -> Result<PreparedUff, UffError> {
    let (atomic_number, label) = match case {
        "sulfur-hexafluoride" => (16, "S_3+2"),
        "iron-hexafluoride" => (26, "Fe6+2"),
        _ => return PreparedUff::new(atoms, bonds),
    };
    let error = PreparedUff::new(atoms, bonds).unwrap_err();
    let UffError::UnsupportedAtomType {
        atom_index: 0,
        atomic_number: actual_element,
        atom_type,
        coordination: 6,
    } = error
    else {
        panic!("{case}: unexpected preparation error {error}");
    };
    assert_eq!(
        (actual_element, atom_type.label),
        (atomic_number, label),
        "{case}"
    );
    PreparedUff::new_for_parity_oracle(atoms, bonds)
}

fn check_frozen_water(model: &PreparedUff, coordinates: &[[f64; 3]], unmasked: &Evaluation) {
    // The shared fixture loader keeps the optimizer trajectory private.
    let fixture: serde_json::Value =
        serde_json::from_str(include_str!("fixtures/uff_reference/water.json")).unwrap();
    let graph = fixture["graphs"]
        .as_array()
        .unwrap()
        .iter()
        .find(|graph| graph["hydrogenModel"] == "explicit-hydrogen")
        .unwrap();
    let snapshot = graph["snapshots"]
        .as_array()
        .unwrap()
        .iter()
        .find(|snapshot| snapshot["id"] == "optimizer-start")
        .unwrap();
    let trajectory = snapshot["optimizationRuns"]
        .as_array()
        .unwrap()
        .iter()
        .find(|run| {
            run["algorithm"] == "ABC-FIRE"
                && run["frozenCoordinates"] == serde_json::json!([0, 1, 2])
        })
        .unwrap();
    let mobile = [false, false, false, true, true, true, true, true, true];
    let masked = model.evaluate_with_mask(coordinates, &mobile).unwrap();
    assert_eq!(masked.total.gradient[0], [0.0; 3]);
    assert_eq!(masked.total.gradient[1..], unmasked.total.gradient[1..]);
    assert_ne!(unmasked.total.gradient[0], [0.0; 3]);
    assert_eq!(masked.bond, unmasked.bond);
    assert_eq!(masked.angle, unmasked.angle);
    assert_eq!(masked.torsion, unmasked.torsion);
    assert_eq!(masked.inversion, unmasked.inversion);
    assert_eq!(masked.van_der_waals, unmasked.van_der_waals);
    assert_eq!(masked.total.energy, unmasked.total.energy);
    let mut errors = Errors::default();
    compare_values(
        &masked.total,
        trajectory["initialEnergyKjMol"].as_f64().unwrap(),
        trajectory["initialGradientKjMolAngstrom"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_f64().unwrap()),
        &mut errors,
        "water with frozen oxygen",
    );
    assert_eq!(
        model
            .evaluate_with_mask(coordinates, &mobile[..8])
            .unwrap_err(),
        UffError::CoordinateMaskLength {
            expected: 9,
            actual: 8
        },
    );
}

#[test]
fn native_uff_parity() {
    let mut errors: [Errors; 6] = Default::default();
    let (mut compared, mut refused, mut cutoff_steps) = (0, 0, 0);
    let mut coverage = BTreeMap::<String, (usize, usize)>::new();
    let mut checked_frozen_water = false;
    for_each_fixture_graph(|case, input, reference, expected_steps, context| {
        assert!(!input.atoms.is_empty(), "{context}: empty graph");
        assert!(
            !input.graph.snapshots.is_empty(),
            "{context}: empty input snapshots"
        );
        assert!(
            !reference.snapshots.is_empty(),
            "{context}: empty reference snapshots"
        );
        let (graphs, snapshots) = coverage.entry(case.to_owned()).or_default();
        *graphs += 1;
        *snapshots += input.graph.snapshots.len();

        let atoms: Vec<_> = input
            .atoms
            .iter()
            .map(|atom| Atom {
                atomic_number: atom.atomic_number,
                formal_charge: atom.formal_charge,
            })
            .collect();
        let bonds: Vec<_> = input
            .bonds
            .iter()
            .map(|bond| Bond {
                atoms: [bond.a, bond.b],
                order: bond.order,
            })
            .collect();
        let rejected = expected_refusals(case);
        let mut refusal_positions = Vec::new();
        for &atomic_number in rejected {
            let index = atoms
                .iter()
                .position(|atom| atom.atomic_number == atomic_number)
                .unwrap();
            refusal_positions.push((index, atomic_number));
        }
        refusal_positions.sort_unstable();

        for (input, reference) in input.graph.snapshots.iter().zip(&reference.snapshots) {
            let context = format!("{context} {}", input.id);
            assert_eq!(input.id, reference.id, "{context}: snapshot ID");
            assert_eq!(
                input.coordinates_angstrom.len(),
                atoms.len(),
                "{context}: atom count"
            );
            if !refusal_positions.is_empty() {
                // Check each rejected element in order. The isolated element probe has
                // several, so replace each with helium after checking its original index.
                let mut remaining = atoms.clone();
                for &(atom_index, atomic_number) in &refusal_positions {
                    assert_eq!(
                        PreparedUff::new(&remaining, &bonds).unwrap_err(),
                        UffError::UnsupportedElement {
                            atom_index,
                            atomic_number
                        },
                        "{context}",
                    );
                    remaining[atom_index] = Atom {
                        atomic_number: 2,
                        formal_charge: 0,
                    };
                }
                refused += 1;
                continue;
            }
            let model = prepare_compared_case(case, &atoms, &bonds)
                .unwrap_or_else(|error| panic!("{context}: {error}"));
            let actual = model
                .evaluate(&input.coordinates_angstrom)
                .unwrap_or_else(|error| panic!("{context}: {error}"));
            compare_snapshot(&model, &actual, reference, &mut errors, &context);
            if case == "water" && atoms.len() == 3 && input.id == "optimizer-start" {
                assert_eq!(atoms[0].atomic_number, 8, "{context}: frozen atom");
                assert!(!checked_frozen_water, "{context}: duplicate mask fixture");
                check_frozen_water(&model, &input.coordinates_angstrom, &actual);
                checked_frozen_water = true;
            }
            match input.gradient_check.as_str() {
                "smooth" => check_central_differences(
                    &model,
                    &input.coordinates_angstrom,
                    &actual,
                    &context,
                ),
                "linear-boundary" => {}
                check => panic!("{context}: unknown gradient check {check}"),
            }
            compared += 1;
        }

        let input_trace = input.graph.cutoff_crossing.as_ref();
        let trace = reference.cutoff_crossing.as_ref();
        let expected_len = (expected_steps > 0).then_some(expected_steps);
        assert_eq!(
            input_trace.map(|trace| trace.snapshot_ids.len()),
            expected_len,
            "{context}: input cutoff trace"
        );
        assert_eq!(
            trace.map(|trace| trace.steps.len()),
            expected_len,
            "{context}: reference cutoff trace"
        );
        if let (Some(input_trace), Some(trace)) = (input_trace, trace) {
            // Reuse the native model while comparing with each fresh upstream model.
            // The pin's persistent values show the lag when the pair enters the cutoff.
            let model = PreparedUff::new(&atoms, &bonds).unwrap();
            for (index, (id, step)) in input_trace
                .snapshot_ids
                .iter()
                .zip(&trace.steps)
                .enumerate()
            {
                let context = format!("{context} cutoff step {}", index + 1);
                assert_eq!(id, &step.snapshot_id, "{context}");
                let snapshot = input
                    .graph
                    .snapshots
                    .iter()
                    .find(|snapshot| &snapshot.id == id)
                    .unwrap();
                let expected = reference
                    .snapshots
                    .iter()
                    .find(|snapshot| &snapshot.id == id)
                    .unwrap();
                let actual = model.evaluate(&snapshot.coordinates_angstrom).unwrap();
                compare_snapshot(&model, &actual, expected, &mut errors, &context);
                compare_values(
                    &actual.total,
                    step.fresh.energy_kj_mol,
                    step.fresh.gradient_kj_mol_angstrom.iter().copied(),
                    &mut errors[5],
                    &context,
                );
                cutoff_steps += 1;
            }
        }
    });
    for &(case, graphs, snapshots) in EXPECTED_COVERAGE {
        assert_eq!(
            coverage.remove(case),
            Some((graphs, snapshots)),
            "{case}: graph and snapshot coverage",
        );
    }
    assert!(coverage.is_empty(), "unexpected fixture cases {coverage:?}");
    assert_eq!(compared, 104, "compared snapshots");
    assert_eq!(refused, 9, "refused snapshots");
    assert_eq!(cutoff_steps, 11, "cutoff evaluations");
    assert!(checked_frozen_water, "missing frozen-oxygen water fixture");
    println!("{compared} matched snapshots, {refused} refused snapshots, {cutoff_steps} fresh cutoff steps");
    for (name, errors) in NAMES.into_iter().zip(errors) {
        println!(
            "{name}: energy {:.6e} kJ/mol ({}), gradient {:.6e} kJ/(mol·Å) ({})",
            errors.energy.absolute,
            errors.energy.location,
            errors.gradient.absolute,
            errors.gradient.location,
        );
    }
}
