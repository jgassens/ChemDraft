//! API 0.1.29 bounded companion retry. The host knows nothing about what the report means: the
//! plugin declares one step, one row label and one number, and supplies every input up front.
use super::{
    dialogs,
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

/// Request-shape checks made before any box is shown or process started.
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
    Ok(())
}

/// Every alternative must parse like the first input, keep its atoms and bonds (only coordinates
/// may differ), and differ from every earlier text. Returns the inputs in attempt order.
pub(super) fn variants(first: &Input, retry: &Retry) -> Result<Vec<Input>, String> {
    let expected = dialogs::composition(first)?;
    let mut inputs = vec![first.clone()];
    for text in &retry.inputs {
        let input = Input {
            extension: first.extension,
            text: text.clone(),
        };
        let composition = dialogs::composition(&input)?;
        if composition.graph_digest != expected.graph_digest
            || composition.formula != expected.formula
            || composition.atom_count != expected.atom_count
        {
            return Err(
                "Each companion retry input must have the same atoms and bonds as the first input."
                    .into(),
            );
        }
        if inputs.iter().any(|earlier| earlier.text == input.text) {
            return Err("Each companion retry input must differ from the earlier inputs.".into());
        }
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
/// here, so the caller can only open the final one. Returns the number of attempts started and
/// the final attempt's outcome. An error, including a refusal before a later attempt, ends the
/// sequence and is returned as is.
pub(super) fn run_sequence<A, E>(
    variants: usize,
    mut attempt: impl FnMut(usize) -> Result<A, E>,
    mut retry: impl FnMut(&A) -> bool,
) -> (usize, Result<A, E>) {
    let variants = variants.clamp(1, RETRY_INPUTS + 1);
    let mut index = 0;
    loop {
        let outcome = attempt(index);
        index += 1;
        match outcome {
            Ok(completed) if index < variants && retry(&completed) => drop(completed),
            outcome => return (index, outcome),
        }
    }
}
