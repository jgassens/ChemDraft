//! API 0.1.29 bounded companion retry. The host knows nothing about what the report means: the
//! plugin declares one step, one row label and one number, and supplies every input up front.
use super::{
    dialogs, runner,
    wire::{self, Input, Retry, RetryCondition, StepResult, INPUT_BYTES},
};
use serde_json::Value;
use std::time::Duration;

/// Alternative inputs after the first, so at most three attempts.
pub(super) const RETRY_INPUTS: usize = 2;
pub(super) const LABEL_CHARACTERS: usize = 80;
/// One bound for the whole sequence. Each attempt keeps its own 600-second pipeline bound.
pub(super) const SEQUENCE_LIMIT: Duration = Duration::from_secs(1200);

const BAD_RETRY: &str = "A companion retry needs an input, one or two alternative inputs of up to 1 MiB, a declared step, and a label of up to 80 visible characters.";
const PATH_LABEL: &str = "A companion retry label cannot look like a file path: no backslash, \"file:\", word starting with \"/\", or drive letter such as \"C:/\".";

/// Request-shape checks made before any box is shown or process started.
///
/// The condition is read from the report the plugin receives, after path redaction (see
/// `runner::path_like`). A label that redaction would rewrite, or its replacement text, could
/// never name a row the companion wrote, so it is refused here rather than silently never
/// retrying. Every other label passes redaction unchanged, and so does a row carrying it.
pub(super) fn check_request(retry: &Retry, input: Option<&Input>) -> Result<(), String> {
    let label = &retry.when.label;
    if input.is_none()
        || retry.inputs.is_empty()
        || retry.inputs.len() > RETRY_INPUTS
        || retry.inputs.iter().any(|text| text.len() > INPUT_BYTES)
        || !wire::id(&retry.when.step)
        || label.chars().take(LABEL_CHARACTERS + 1).count() > LABEL_CHARACTERS
        || dialogs::display_text(label, LABEL_CHARACTERS) != *label
        || label.is_empty()
        || !retry.when.not_equal.is_finite()
    {
        return Err(BAD_RETRY.into());
    }
    if runner::path_like(label) || label == runner::REDACTED_PATH {
        return Err(PATH_LABEL.into());
    }
    Ok(())
}

/// The farthest an alternative input may place any atom from the same atom of the first input:
/// 0.1, in the input's length unit (ångströms for XYZ). The confirmation box, the SDK and
/// AUTHORING.md state the same bound.
pub(super) const MAX_DISPLACEMENT: f64 = 0.1;
/// Decimal coordinates such as 1.1 - 1.0 do not subtract exactly in binary.
const DISPLACEMENT_ROUNDING: f64 = 1e-9;

const NOT_SAME_LAYOUT: &str = "Each companion retry input must match the first input line for line, with the same atom count line, comment line, elements in the same order, and bond records; only atom coordinates may change.";
const MOVED_TOO_FAR: &str =
    "Each companion retry input may move each atom at most 0.1 Å from its position in the first input.";
const NOT_MOVED: &str =
    "Each companion retry input must move at least one atom from its position in every earlier input.";

/// One atom record: its element, its coordinates, and whether its line ended in a carriage return.
struct Atom<'a> {
    element: &'a str,
    position: [f64; 3],
    carriage_return: bool,
}

/// An atom record with fields separated by spaces or tabs only, so that no reader sees another
/// line break in it.
fn atom(line: &str) -> Option<Atom<'_>> {
    let (body, carriage_return) = match line.strip_suffix('\r') {
        Some(body) => (body, true),
        None => (line, false),
    };
    if body
        .bytes()
        .any(|byte| byte.is_ascii_whitespace() && !matches!(byte, b' ' | b'\t'))
    {
        return None;
    }
    let mut fields = body.split([' ', '\t']).filter(|field| !field.is_empty());
    let element = fields.next()?;
    let mut position = [0.0; 3];
    for value in &mut position {
        *value = fields
            .next()?
            .parse::<f64>()
            .ok()
            .filter(|v| v.is_finite())?;
    }
    fields.next().is_none().then_some(Atom {
        element,
        position,
        carriage_return,
    })
}

/// The atom positions of `text` when it is `first` with only atom coordinates (and the spaces or
/// tabs between an atom's fields) changed; every other line, the line breaks included, must be
/// byte for byte the same.
fn positions(first: &str, text: &str, atom_count: usize) -> Option<Vec<[f64; 3]>> {
    let first: Vec<&str> = first.split('\n').collect();
    let lines: Vec<&str> = text.split('\n').collect();
    let atoms = 2..2 + atom_count;
    if lines.len() != first.len() || first.len() < atoms.end {
        return None;
    }
    let mut placed = Vec::with_capacity(atom_count);
    for (index, (line, expected)) in lines.iter().zip(&first).enumerate() {
        if !atoms.contains(&index) {
            if line != expected {
                return None;
            }
            continue;
        }
        let (atom, expected) = (atom(line)?, atom(expected)?);
        if atom.element != expected.element || atom.carriage_return != expected.carriage_return {
            return None;
        }
        placed.push(atom.position);
    }
    Some(placed)
}

fn distance(a: &[f64; 3], b: &[f64; 3]) -> f64 {
    a.iter()
        .zip(b)
        .map(|(a, b)| (a - b) * (a - b))
        .sum::<f64>()
        .sqrt()
}

/// Every alternative must be the first input with only atom coordinates changed (see `positions`),
/// must move no atom more than `MAX_DISPLACEMENT` from the first input, and must move at least one
/// atom from where every earlier input has it. Returns the inputs in attempt order.
pub(super) fn variants(first: &Input, retry: &Retry) -> Result<Vec<Input>, String> {
    let expected = dialogs::composition(first)?;
    let origin = positions(&first.text, &first.text, expected.atom_count).ok_or(NOT_SAME_LAYOUT)?;
    let mut inputs = vec![first.clone()];
    let mut placed = vec![origin.clone()];
    for text in &retry.inputs {
        let input = Input {
            extension: first.extension,
            text: text.clone(),
        };
        let atoms =
            positions(&first.text, &input.text, expected.atom_count).ok_or(NOT_SAME_LAYOUT)?;
        if atoms.iter().zip(&origin).any(|(atom, start)| {
            let moved = distance(atom, start);
            moved.is_nan() || moved > MAX_DISPLACEMENT + DISPLACEMENT_ROUNDING
        }) {
            return Err(MOVED_TOO_FAR.into());
        }
        if placed.contains(&atoms) {
            return Err(NOT_MOVED.into());
        }
        placed.push(atoms);
        inputs.push(input);
    }
    Ok(inputs)
}

/// The value of the one row labelled `condition.label` in the report of step `condition.step`.
///
/// The row is looked up only at `json.tables[i].rows[j]`: `json` must be an object whose `tables`
/// is an array; a table that is not an object with a `rows` array, and a row that is not an
/// object, contributes no rows. A row matches when its `label` is a string equal to the declared
/// label. Exactly one row across all tables must match. Its `value` must be a JSON number or a
/// string whose trimmed text parses as a decimal number, and the number must be finite.
/// A step that is absent, or appears more than once, yields no value.
pub(super) fn reading(steps: &[StepResult], condition: &RetryCondition) -> Option<f64> {
    let mut reports = steps.iter().filter(|step| step.id == condition.step);
    let report = reports.next()?;
    if reports.next().is_some() {
        return None;
    }
    let mut matches = report
        .json
        .get("tables")?
        .as_array()?
        .iter()
        .filter_map(|table| table.get("rows")?.as_array())
        .flatten()
        .filter(|row| row.get("label").and_then(Value::as_str) == Some(condition.label.as_str()));
    let row = matches.next()?;
    if matches.next().is_some() {
        return None;
    }
    let value = row.get("value")?;
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|value: &f64| value.is_finite())
}

/// The plugin's poor-result condition: a readable finite value other than the declared number.
pub(super) fn wants_retry(steps: &[StepResult], condition: &RetryCondition) -> bool {
    reading(steps, condition).is_some_and(|value| value != condition.not_equal)
}

/// Run attempt 0, then the next variant only while the previous attempt completed and `retry`
/// holds for it, up to `variants` (never more than three). Earlier completed attempts are dropped
/// here, so the caller can only open the final one. `attempt` returns whether the host started it
/// (its first companion step launched) along with its outcome. An error, including a refusal before
/// a later attempt starts, ends the sequence and is returned as is.
///
/// Returns the number of attempts started and the final outcome. The first attempt always counts:
/// it is the one the click approved, and the result names its input. A later attempt that ended
/// before its first step started is not counted, so the count still names the last input that ran.
pub(super) fn run_sequence<A, E>(
    variants: usize,
    mut attempt: impl FnMut(usize) -> (bool, Result<A, E>),
    mut retry: impl FnMut(&A) -> bool,
) -> (usize, Result<A, E>) {
    let variants = variants.clamp(1, RETRY_INPUTS + 1);
    let mut started = 0;
    loop {
        let index = started;
        let (launched, outcome) = attempt(index);
        // A completed attempt ran its steps, so it started.
        if index == 0 || launched || outcome.is_ok() {
            started += 1;
        }
        match outcome {
            Ok(completed) if started < variants && retry(&completed) => drop(completed),
            outcome => return (started, outcome),
        }
    }
}
