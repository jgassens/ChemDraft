// SPDX-License-Identifier: Apache-2.0

use serde::de::DeserializeOwned;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::Path;

const UPSTREAM: &str = "416651ddaef33a4e20392392e7c0b505d446491b";
pub(crate) const KCAL_TO_KJ: f64 = 4.184;
const TERMS: [(&str, usize); 5] = [
    ("bond", 2),
    ("angle", 3),
    ("oop", 4),
    ("torsion", 4),
    ("vdw", 2),
];
const CHECKPOINTS: [usize; 3] = [1, 10, 100];
const RMS_LIMIT: f64 = 1e-2;
const ITERATION_CAP: usize = 10_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    upstream_commit: String,
    eigen_version: String,
    generator_version: u32,
    diagnostic_matches_unmodified: bool,
    inventory_sha256: String,
    build: BTreeMap<String, String>,
    settings: Value,
    files: BTreeMap<String, FileHashes>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHashes {
    input_sha256: String,
    output_sha256: String,
}

#[derive(Deserialize)]
struct Case<G> {
    id: String,
    graphs: Vec<G>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Graph<S, C> {
    hydrogen_model: String,
    kekule: Option<String>,
    pub(crate) snapshots: Vec<S>,
    pub(crate) cutoff_crossing: Option<C>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequiredGraph {
    hydrogen_model: String,
    kekule: Option<String>,
    snapshots: Vec<String>,
    #[serde(default)]
    runs: Vec<RequiredRun>,
    #[serde(default)]
    cutoff_crossing_steps: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RequiredRun {
    snapshot_id: String,
    #[serde(flatten)]
    run: Run,
}

#[derive(Deserialize)]
pub(crate) struct InputGraph {
    #[serde(flatten)]
    pub(crate) graph: Graph<InputSnapshot, CutoffCrossingInput>,
    pub(crate) atoms: Vec<InputAtom>,
    pub(crate) bonds: Vec<InputBond>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputAtom {
    pub(crate) atomic_number: u8,
    pub(crate) formal_charge: i32,
}

#[derive(Deserialize)]
pub(crate) struct InputBond {
    pub(crate) a: usize,
    pub(crate) b: usize,
    pub(crate) order: u8,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CutoffCrossingInput {
    gradient_check: String,
    pub(crate) snapshot_ids: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CutoffCrossing {
    gradient_check: String,
    pub(crate) steps: Vec<CutoffStep>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CutoffStep {
    pub(crate) snapshot_id: String,
    persistent: Evaluation,
    pub(crate) fresh: Evaluation,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Evaluation {
    pub(crate) energy_kj_mol: f64,
    pub(crate) gradient_kj_mol_angstrom: Vec<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct InputSnapshot {
    pub(crate) id: String,
    pub(crate) gradient_check: String,
    pub(crate) coordinates_angstrom: Vec<[f64; 3]>,
    #[serde(default)]
    optimization_runs: Vec<Run>,
}

#[derive(Debug, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct Run {
    algorithm: String,
    frozen_coordinates: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    pub(crate) id: String,
    gradient_check: String,
    pub(crate) topology: Topology,
    pub(crate) total: Total,
    pub(crate) terms: BTreeMap<String, Term>,
    #[serde(default)]
    optimization_runs: Vec<Trajectory>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Topology {
    pub(crate) atom_types: Vec<Value>,
    pub(crate) tuples: BTreeMap<String, Vec<Vec<usize>>>,
    pub(crate) excluded_pairs: Vec<[usize; 2]>,
    pub(crate) angle_coordinations: Vec<usize>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Total {
    pub(crate) value_kj_mol: f64,
    pub(crate) evaluate_kj_mol: f64,
    #[serde(flatten)]
    pub(crate) derivatives: Derivatives,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Derivatives {
    pub(crate) gradient_kj_mol_angstrom: Vec<f64>,
    central_difference_kj_mol_angstrom: [Vec<f64>; 2],
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Term {
    energy_kj_mol: f64,
    pub(crate) energy_kcal_mol: f64,
    pub(crate) gradient_kcal_mol_angstrom: Vec<f64>,
    central_difference_kcal_mol_angstrom: [Vec<f64>; 2],
    #[serde(flatten)]
    derivatives: Derivatives,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Trajectory {
    #[serde(flatten)]
    run: Run,
    initial_energy_kj_mol: f64,
    initial_gradient_kj_mol_angstrom: Vec<f64>,
    initial_mobile_gradient_rms_kj_mol_angstrom: f64,
    checkpoints: [Checkpoint; 3],
    endpoint: Endpoint,
}

#[derive(Deserialize)]
struct Endpoint {
    status: String,
    #[serde(flatten)]
    checkpoint: Checkpoint,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
    iteration: usize,
    coordinates_angstrom: Vec<f64>,
    energy_kj_mol: f64,
    gradient_kj_mol_angstrom: Vec<f64>,
    mobile_gradient_rms_kj_mol_angstrom: f64,
    velocity: Vec<f64>,
}

fn json_files(dir: &Path) -> BTreeSet<String> {
    fs::read_dir(dir)
        .unwrap_or_else(|error| panic!("{}: {error}", dir.display()))
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .filter(|name| name.ends_with(".json") && name != "manifest.json")
        .collect()
}

fn finite_values(value: &Value, context: &str) {
    match value {
        Value::Null => panic!("{context}: null value, possibly a nonfinite harness result"),
        Value::Number(value) => {
            assert!(
                value.as_f64().is_some_and(f64::is_finite),
                "{context}: nonfinite number {value}"
            );
        }
        Value::Array(items) => {
            for (i, item) in items.iter().enumerate() {
                finite_values(item, &format!("{context}[{i}]"));
            }
        }
        Value::Object(entries) => {
            for (name, value) in entries {
                finite_values(value, &format!("{context}.{name}"));
            }
        }
        _ => {}
    }
}

fn load<T: DeserializeOwned>(path: &Path, expected_hash: Option<&str>) -> T {
    let bytes = fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    if let Some(expected) = expected_hash {
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            expected,
            "{}",
            path.display()
        );
    }
    // Inspect the full JSON, including diagnostic fields outside the typed checks.
    let raw = serde_json::from_slice(&bytes)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    finite_values(&raw, &path.display().to_string());
    serde_json::from_value(raw).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

pub(crate) fn close(actual: f64, reference: f64, absolute: f64, relative: f64, context: &str) {
    let tolerance = absolute.max(relative * reference.abs());
    assert!(
        (actual - reference).abs() <= tolerance,
        "{context}: got {actual}, expected {reference} within {tolerance}"
    );
}

fn check_derivatives(values: &Derivatives, coordinates: usize, smooth: bool, context: &str) {
    assert_eq!(
        values.gradient_kj_mol_angstrom.len(),
        coordinates,
        "{context}"
    );
    for (step, difference) in values.central_difference_kj_mol_angstrom.iter().enumerate() {
        assert_eq!(difference.len(), coordinates, "{context}");
        if smooth {
            for (i, (&analytic, &numerical)) in values
                .gradient_kj_mol_angstrom
                .iter()
                .zip(difference)
                .enumerate()
            {
                close(
                    analytic,
                    numerical,
                    1e-4,
                    1e-4,
                    &format!("{context} step {step}, component {i}"),
                );
            }
        }
    }
}

fn check_gradient_units(raw: &[f64], normalized: &[f64], context: &str) {
    assert_eq!(raw.len(), normalized.len(), "{context}");
    for (&raw, &normalized) in raw.iter().zip(normalized) {
        close(normalized, raw * KCAL_TO_KJ, 1e-12, 1e-12, context);
    }
}

fn expected_exclusions(input: &InputGraph, context: &str) -> Vec<[usize; 2]> {
    let mut neighbors = vec![Vec::new(); input.atoms.len()];
    let mut pairs = BTreeSet::new();
    let ordered_pair = |a: usize, b: usize| [a.min(b), a.max(b)];
    for &InputBond { a, b, order } in &input.bonds {
        assert!(
            (1..=3).contains(&order),
            "{context}: invalid reference bond order"
        );
        assert!(
            a < neighbors.len() && b < neighbors.len() && a != b,
            "{context}: invalid bond"
        );
        assert!(
            pairs.insert(ordered_pair(a, b)),
            "{context}: duplicate bond"
        );
        neighbors[a].push(b);
        neighbors[b].push(a);
    }
    for adjacent in neighbors {
        for (index, &a) in adjacent.iter().enumerate() {
            for &b in &adjacent[index + 1..] {
                pairs.insert(ordered_pair(a, b));
            }
        }
    }
    pairs.into_iter().collect()
}

fn probe_label(case_id: &str, input: &InputGraph, context: &str) -> Option<(usize, &'static str)> {
    let (element, label) = match case_id {
        "iodomethane" => (53, "Xe4+4"),
        "antimony-trihydride" => (51, "Te3+2"),
        _ => return None,
    };
    let index = input
        .atoms
        .iter()
        .position(|atom| atom.atomic_number == element)
        .unwrap_or_else(|| panic!("{context}: missing element {element}"));
    // The pin skips all type assignment for single-atom graphs.
    (input.atoms.len() > 1).then_some((index, label))
}

fn check_snapshot(
    input: &InputSnapshot,
    output: &Snapshot,
    expected_exclusions: &[[usize; 2]],
    probe_label: Option<(usize, &str)>,
    context: &str,
) {
    let atoms = input.coordinates_angstrom.len();
    let coordinates = 3 * atoms;
    assert_eq!(input.id, output.id, "{context}");
    assert_eq!(input.gradient_check, output.gradient_check, "{context}");
    let smooth = match input.gradient_check.as_str() {
        "smooth" => true,
        "linear-boundary" => false,
        value => panic!("{context}: unknown gradient check {value}"),
    };
    let total = &output.total;
    check_derivatives(&total.derivatives, coordinates, smooth, context);
    close(
        total.evaluate_kj_mol,
        total.value_kj_mol,
        1e-6,
        1e-8,
        context,
    );

    let topology = &output.topology;
    assert_eq!(
        topology.atom_types.len(),
        if atoms == 1 { 0 } else { atoms },
        "{context}"
    );
    if let Some((index, label)) = probe_label {
        assert_eq!(
            topology.atom_types[index]["label"].as_str(),
            Some(label),
            "{context}: pinned type label for atom {index}"
        );
    }
    assert_eq!(output.terms.len(), TERMS.len(), "{context}");
    assert_eq!(topology.tuples.len(), TERMS.len(), "{context}");
    let mut sum = 0.0;
    let mut gradient_sum = vec![0.0; coordinates];
    for (name, arity) in TERMS {
        let context = format!("{context} {name}");
        let tuples = &topology.tuples[name];
        assert!(
            tuples
                .iter()
                .all(|tuple| tuple.len() == arity && tuple.iter().all(|&i| i < atoms)),
            "{context}: invalid term tuple"
        );
        let term = &output.terms[name];
        check_derivatives(&term.derivatives, coordinates, smooth, &context);
        close(
            term.energy_kj_mol,
            term.energy_kcal_mol * KCAL_TO_KJ,
            1e-12,
            1e-12,
            &context,
        );
        check_gradient_units(
            &term.gradient_kcal_mol_angstrom,
            &term.derivatives.gradient_kj_mol_angstrom,
            &context,
        );
        for (raw, normalized) in term
            .central_difference_kcal_mol_angstrom
            .iter()
            .zip(&term.derivatives.central_difference_kj_mol_angstrom)
        {
            check_gradient_units(raw, normalized, &context);
        }
        sum += term.energy_kj_mol;
        for (sum, &value) in gradient_sum
            .iter_mut()
            .zip(&term.derivatives.gradient_kj_mol_angstrom)
        {
            *sum += value;
        }
    }
    assert_eq!(
        topology.angle_coordinations.len(),
        topology.tuples["angle"].len(),
        "{context}"
    );
    assert_eq!(
        topology.excluded_pairs, expected_exclusions,
        "{context}: 1–2 and 1–3 exclusions"
    );
    close(sum, total.value_kj_mol, 1e-6, 1e-8, context);
    for (&sum, &actual) in gradient_sum
        .iter()
        .zip(&total.derivatives.gradient_kj_mol_angstrom)
    {
        close(sum, actual, 2e-5, 1e-7, context);
    }
    assert_eq!(
        input.optimization_runs.len(),
        output.optimization_runs.len(),
        "{context}"
    );
    for (input_run, result) in input
        .optimization_runs
        .iter()
        .zip(&output.optimization_runs)
    {
        assert_eq!(input_run, &result.run, "{context}");
        check_trajectory(input, total, result, context);
    }
}

fn check_rms(gradient: &[f64], frozen: &[usize], reported: f64, context: &str) {
    for &index in frozen {
        assert_eq!(gradient[index], 0.0, "{context}: masked gradient {index}");
    }
    let squares: f64 = gradient.iter().map(|component| component * component).sum();
    let rms = (squares / (gradient.len() - frozen.len()) as f64).sqrt();
    close(reported, rms, 1e-12, 1e-12, context);
}

fn check_trajectory(input: &InputSnapshot, total: &Total, result: &Trajectory, context: &str) {
    let context = format!(
        "{context} {} {:?}",
        result.run.algorithm, result.run.frozen_coordinates
    );
    let start: Vec<f64> = input
        .coordinates_angstrom
        .iter()
        .flatten()
        .copied()
        .collect();
    let frozen = &result.run.frozen_coordinates;
    close(
        result.initial_energy_kj_mol,
        total.value_kj_mol,
        1e-6,
        1e-8,
        &context,
    );
    assert_eq!(
        result.initial_gradient_kj_mol_angstrom.len(),
        start.len(),
        "{context}"
    );
    check_rms(
        &result.initial_gradient_kj_mol_angstrom,
        frozen,
        result.initial_mobile_gradient_rms_kj_mol_angstrom,
        &context,
    );
    assert_eq!(
        result.checkpoints.each_ref().map(|c| c.iteration),
        CHECKPOINTS,
        "{context}"
    );
    let endpoint = &result.endpoint.checkpoint;
    for checkpoint in result.checkpoints.iter().chain(std::iter::once(endpoint)) {
        assert!(
            checkpoint.energy_kj_mol <= result.initial_energy_kj_mol,
            "{context} iteration {}: energy rose from {} to {} kJ/mol",
            checkpoint.iteration,
            result.initial_energy_kj_mol,
            checkpoint.energy_kj_mol
        );
        assert_eq!(
            checkpoint.coordinates_angstrom.len(),
            start.len(),
            "{context}"
        );
        assert_eq!(
            checkpoint.gradient_kj_mol_angstrom.len(),
            start.len(),
            "{context}"
        );
        assert_eq!(checkpoint.velocity.len(), start.len(), "{context}");
        for &i in frozen {
            assert_eq!(
                checkpoint.coordinates_angstrom[i], start[i],
                "{context}: moved frozen coordinate {i}"
            );
            assert_eq!(
                checkpoint.velocity[i], 0.0,
                "{context}: frozen velocity {i}"
            );
        }
        check_rms(
            &checkpoint.gradient_kj_mol_angstrom,
            frozen,
            checkpoint.mobile_gradient_rms_kj_mol_angstrom,
            &context,
        );
    }
    assert!(
        (1..=ITERATION_CAP).contains(&endpoint.iteration),
        "{context}"
    );
    match result.endpoint.status.as_str() {
        "converged" => assert!(
            endpoint.mobile_gradient_rms_kj_mol_angstrom <= RMS_LIMIT,
            "{context}"
        ),
        "capped" => {
            assert_eq!(endpoint.iteration, ITERATION_CAP, "{context}");
            assert!(
                endpoint.mobile_gradient_rms_kj_mol_angstrom > RMS_LIMIT,
                "{context}"
            );
        }
        status => panic!("{context}: unknown endpoint status {status}"),
    }
}

fn check_cutoff_crossing(
    input: &Graph<InputSnapshot, CutoffCrossingInput>,
    result: &Graph<Snapshot, CutoffCrossing>,
    expected_steps: usize,
    context: &str,
) {
    let expected_len = (expected_steps > 0).then_some(expected_steps);
    assert_eq!(
        input
            .cutoff_crossing
            .as_ref()
            .map(|trace| trace.snapshot_ids.len()),
        expected_len,
        "{context}: inventoried cutoff steps in input"
    );
    assert_eq!(
        result
            .cutoff_crossing
            .as_ref()
            .map(|trace| trace.steps.len()),
        expected_len,
        "{context}: inventoried cutoff steps in fixture"
    );
    let (Some(sequence), Some(trace)) = (&input.cutoff_crossing, &result.cutoff_crossing) else {
        return;
    };
    assert_eq!(sequence.gradient_check, "cutoff-boundary", "{context}");
    assert_eq!(trace.gradient_check, sequence.gradient_check, "{context}");

    let expected_order = [
        "outside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "inside-cutoff",
        "outside-cutoff",
    ];
    assert_eq!(sequence.snapshot_ids, expected_order, "{context}");
    for (id, inside) in [("inside-cutoff", true), ("outside-cutoff", false)] {
        let snapshot = input
            .snapshots
            .iter()
            .find(|sample| sample.id == id)
            .unwrap();
        let [a, b] = snapshot.coordinates_angstrom.as_slice() else {
            panic!("{context}: expected two ions");
        };
        let distance_squared: f64 = a.iter().zip(b).map(|(a, b)| (a - b).powi(2)).sum();
        assert_eq!(distance_squared < 100.0, inside, "{context}: {id}");
    }
    let zero = Evaluation {
        energy_kj_mol: 0.0,
        gradient_kj_mol_angstrom: vec![0.0; 6],
    };
    for (index, (step, id)) in trace.steps.iter().zip(expected_order).enumerate() {
        let context = format!("{context} cutoff evaluation {}", index + 1);
        assert_eq!(step.snapshot_id, id, "{context}");
        let total = &result
            .snapshots
            .iter()
            .find(|sample| sample.id == id)
            .unwrap()
            .total;
        assert_eq!(step.fresh.energy_kj_mol, total.evaluate_kj_mol, "{context}");
        assert_eq!(
            step.fresh.gradient_kj_mol_angstrom, total.derivatives.gradient_kj_mol_angstrom,
            "{context}: fresh gradient"
        );
        if id == "inside-cutoff" {
            assert!(step.fresh.energy_kj_mol < 0.0, "{context}");
        } else {
            assert_eq!(step.fresh, zero, "{context}: fresh outside the cutoff");
        }
        // The pair first enters the persistent list on the tenth evaluation.
        // Returning outside the cutoff suppresses it immediately on step eleven.
        let expected = if index == 9 { &step.fresh } else { &zero };
        assert_eq!(
            &step.persistent, expected,
            "{context}: persistent evaluation"
        );
    }
}

pub(crate) fn for_each_fixture_graph(
    mut visit: impl FnMut(&str, &InputGraph, &Graph<Snapshot, CutoffCrossing>, usize, &str),
) {
    let crate_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
    let fixture_dir = crate_dir.join("tests/fixtures/uff_reference");
    let tool_dir = crate_dir.join("../../../tools/spin3d-ff-reference");
    let input_dir = tool_dir.join("inputs");
    let manifest: Manifest = load(&fixture_dir.join("manifest.json"), None);
    let inventory: BTreeMap<String, Vec<RequiredGraph>> = load(
        &tool_dir.join("inventory.json"),
        Some(&manifest.inventory_sha256),
    );
    assert_eq!(manifest.upstream_commit, UPSTREAM);
    assert_eq!(manifest.eigen_version, "3.4.0");
    assert_eq!(manifest.generator_version, 2);
    assert!(manifest.diagnostic_matches_unmodified);
    for key in ["compiler", "system", "arch"] {
        assert!(
            !manifest.build[key].is_empty(),
            "missing build provenance {key}"
        );
    }
    assert_eq!(manifest.build["EIGEN_MPL2_ONLY"], "ON");
    assert_eq!(manifest.settings["kcalToKj"], KCAL_TO_KJ);
    assert_eq!(
        manifest.settings["centralDifferenceStepsAngstrom"],
        serde_json::json!([1e-5, 5e-6])
    );
    assert_eq!(
        manifest.settings["optimizer"]["checkpointIterations"],
        serde_json::json!(CHECKPOINTS)
    );
    assert_eq!(
        manifest.settings["optimizer"]["iterationCap"],
        ITERATION_CAP
    );
    assert_eq!(
        manifest.settings["optimizer"]["convergenceMobileGradientRmsKjMolAngstrom"],
        RMS_LIMIT
    );
    assert_eq!(
        manifest.settings["optimizer"]["fire"]["maxMoveAngstrom"],
        0.18
    );
    assert_eq!(manifest.settings["generalRestraints"], false);
    assert_eq!(manifest.settings["vdwCutoffAngstrom"], 10);

    let names: BTreeSet<_> = inventory.keys().map(|id| format!("{id}.json")).collect();
    assert!(!names.is_empty());
    assert_eq!(
        names,
        manifest.files.keys().cloned().collect::<BTreeSet<_>>(),
        "manifest inventory"
    );
    assert_eq!(names, json_files(&fixture_dir), "fixture inventory");
    assert_eq!(names, json_files(&input_dir), "input inventory");
    for (id, required_graphs) in inventory {
        let name = format!("{id}.json");
        let hashes = &manifest.files[&name];
        let input: Case<InputGraph> = load(&input_dir.join(&name), Some(&hashes.input_sha256));
        let result: Case<Graph<Snapshot, CutoffCrossing>> =
            load(&fixture_dir.join(&name), Some(&hashes.output_sha256));
        assert_eq!(input.id, id, "{name}: input ID");
        assert_eq!(result.id, id, "{name}: fixture ID");
        assert_eq!(
            input.graphs.len(),
            required_graphs.len(),
            "{name}: input variants"
        );
        assert_eq!(
            result.graphs.len(),
            required_graphs.len(),
            "{name}: fixture variants"
        );
        for ((input, result), expected) in
            input.graphs.iter().zip(&result.graphs).zip(required_graphs)
        {
            let context = format!("{id} {} {:?}", expected.hydrogen_model, expected.kekule);
            let graph = &input.graph;
            assert_eq!(
                graph.hydrogen_model, expected.hydrogen_model,
                "{context}: input variant"
            );
            assert_eq!(
                result.hydrogen_model, expected.hydrogen_model,
                "{context}: fixture variant"
            );
            assert_eq!(
                graph.kekule, expected.kekule,
                "{context}: input Kekulé order"
            );
            assert_eq!(
                result.kekule, expected.kekule,
                "{context}: fixture Kekulé order"
            );
            let snapshot_ids: Vec<_> = graph.snapshots.iter().map(|sample| &sample.id).collect();
            assert_eq!(
                snapshot_ids,
                expected.snapshots.iter().collect::<Vec<_>>(),
                "{context}: input snapshots"
            );
            assert_eq!(
                result.snapshots.len(),
                expected.snapshots.len(),
                "{context}: fixture snapshots"
            );
            let expected_runs: Vec<_> = expected
                .runs
                .iter()
                .map(|run| (&run.snapshot_id, &run.run))
                .collect();
            let input_runs: Vec<_> = graph
                .snapshots
                .iter()
                .flat_map(|sample| {
                    sample
                        .optimization_runs
                        .iter()
                        .map(move |run| (&sample.id, run))
                })
                .collect();
            assert_eq!(input_runs, expected_runs, "{context}: input optimizer runs");
            visit(&id, input, result, expected.cutoff_crossing_steps, &context);
        }
    }
}

#[test]
fn pinned_uff_reference_fixtures() {
    for_each_fixture_graph(|id, input, result, cutoff_steps, context| {
        for atom in &input.atoms {
            assert!(
                i8::try_from(atom.formal_charge).is_ok(),
                "{context}: formal charge"
            );
        }
        let exclusions = expected_exclusions(input, context);
        let label = probe_label(id, input, context);
        for (input_snapshot, result_snapshot) in input.graph.snapshots.iter().zip(&result.snapshots)
        {
            let context = format!("{context} {}", input_snapshot.id);
            assert_eq!(
                input_snapshot.coordinates_angstrom.len(),
                input.atoms.len(),
                "{context}: coordinate count"
            );
            check_snapshot(
                input_snapshot,
                result_snapshot,
                &exclusions,
                label,
                &context,
            );
        }
        check_cutoff_crossing(&input.graph, result, cutoff_steps, context);
    });
}
