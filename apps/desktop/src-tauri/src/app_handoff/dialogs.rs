use super::{
    arming::Submission,
    command_line::Pipeline,
    wire::{Extension, Input, StepResult},
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, time::Duration};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_dialog::{
    DialogExt, MessageDialogButtons, MessageDialogKind, MessageDialogResult,
};

pub(crate) const KIND: &str = "appHandoff";

/// The shared dialog host delivers this snapshot exclusively to the document-owned dialog.
#[derive(Serialize)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub(super) enum Snapshot<'a> {
    Confirm {
        title: &'static str,
        app_name: &'a str,
        pipeline: &'a str,
        #[serde(skip_serializing_if = "Option::is_none")]
        composition: Option<&'a Composition>,
        suggested_combination: &'a str,
        combinations: &'a BTreeMap<String, BTreeMap<String, String>>,
    },
    Result {
        title: &'static str,
        app_name: &'a str,
        combination: &'a str,
        rebuild_combination: &'a str,
        rebuild_label: String,
        rebuild_changes: BTreeMap<&'a str, Option<&'a str>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        twist: Option<f64>,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Action {
    Confirm {
        #[serde(rename = "combinationId")]
        combination_id: String,
    },
    Rebuild {},
    Cancel {},
}

impl Action {
    pub(crate) fn valid_for(&self, snapshot: &Value) -> bool {
        match self {
            Self::Cancel {} => true,
            Self::Confirm { combination_id } => {
                snapshot["mode"] == "confirm"
                    && snapshot["combinations"].get(combination_id).is_some()
            }
            Self::Rebuild {} => snapshot["mode"] == "result",
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Composition {
    pub formula: String,
    pub atom_count: usize,
    #[serde(skip)]
    pub graph_digest: String,
}

pub(super) fn composition(input: &Input) -> Result<Composition, String> {
    if input.extension != Extension::Xyz {
        return Err("Build confirmation can display composition for XYZ input only.".into());
    }
    let malformed = "The companion XYZ has an invalid atom count, atom record, or bond record.";
    let mut lines = input.text.lines();
    let atom_count: usize = lines
        .next()
        .and_then(|line| line.trim().parse().ok())
        .ok_or(malformed)?;
    if atom_count == 0 || atom_count > input.text.len() / 7 || lines.next().is_none() {
        return Err(malformed.into());
    }
    let mut counts = BTreeMap::new();
    let mut hash = Sha256::new();
    for _ in 0..atom_count {
        let mut fields = lines.next().ok_or(malformed)?.split_ascii_whitespace();
        let element = fields.next().ok_or(malformed)?;
        if !(1..=2).contains(&element.len())
            || !element.as_bytes()[0].is_ascii_uppercase()
            || !element.as_bytes().get(1).is_none_or(u8::is_ascii_lowercase)
            || !(0..3).all(|_| {
                fields
                    .next()
                    .and_then(|field| field.parse::<f64>().ok())
                    .is_some_and(f64::is_finite)
            })
            || fields.next().is_some()
        {
            return Err(malformed.into());
        }
        *counts.entry(element).or_insert(0usize) += 1;
        hash.update(element.as_bytes());
        hash.update(b"\n");
    }
    for line in lines.filter(|line| !line.trim().is_empty()) {
        let mut fields = line.split_ascii_whitespace();
        let first = fields.next().and_then(|field| field.parse::<usize>().ok());
        let second = fields.next().and_then(|field| field.parse::<usize>().ok());
        let order = fields.next().ok_or(malformed)?;
        if !first.is_some_and(|index| index < atom_count)
            || !second.is_some_and(|index| index < atom_count)
            || first == second
            || !matches!(order, "S" | "D" | "T" | "A")
            || fields.next().is_some()
        {
            return Err(malformed.into());
        }
        hash.update(format!("{} {} {order}\n", first.unwrap(), second.unwrap()));
    }
    let mut formula = String::new();
    let mut append = |element: &str, count: usize| {
        formula.push_str(element);
        if count > 1 {
            formula.push_str(&count.to_string());
        }
    };
    if let Some(carbon) = counts.remove("C") {
        append("C", carbon);
        if let Some(hydrogen) = counts.remove("H") {
            append("H", hydrogen);
        }
    }
    for (element, count) in counts {
        append(element, count);
    }
    Ok(Composition {
        formula,
        atom_count,
        graph_digest: format!("{:x}", hash.finalize()),
    })
}

pub(super) fn twist(steps: &[StepResult]) -> Option<f64> {
    let build = &steps.iter().find(|step| step.id == "build")?.json;
    let mut matches = Vec::new();
    fn rows<'a>(value: &'a Value, matches: &mut Vec<&'a Value>) {
        match value {
            Value::Array(items) => items.iter().for_each(|item| rows(item, matches)),
            Value::Object(object)
                if object
                    .get("label")
                    .is_some_and(|label| label == "Joint twist left") =>
            {
                matches.push(&value["value"]);
            }
            Value::Object(object) => object.values().for_each(|item| rows(item, matches)),
            _ => {}
        }
    }
    rows(&build["tables"], &mut matches);
    let [value] = matches.as_slice() else {
        return None;
    };
    value
        .as_f64()
        .or_else(|| value.as_str()?.trim().parse().ok())
        .filter(|value| value.is_finite() && *value >= 0.0)
}

pub(super) fn rebuild_label(pipeline: &Pipeline, combination: &str) -> String {
    pipeline
        .combinations
        .get(combination)
        .and_then(|row| row.get("repeat"))
        .map_or_else(
            || "Rebuild".into(),
            |repeat| format!("Rebuild at {}", repeat.replace('x', "×")),
        )
}

pub(super) fn rebuild_changes<'a>(
    pipeline: &'a Pipeline,
    from: &str,
    to: &str,
) -> BTreeMap<&'a str, Option<&'a str>> {
    let from = &pipeline.combinations[from];
    let to = &pipeline.combinations[to];
    from.keys()
        .chain(to.keys())
        .filter(|key| {
            key.as_str() != "rebuildAs"
                && (key.as_str() != "repeat" || !to.contains_key(*key))
                && from.get(*key) != to.get(*key)
        })
        .map(|key| (key.as_str(), to.get(key).map(String::as_str)))
        .collect()
}

pub(super) fn rebuild_requested(action: Result<Action, String>) -> bool {
    match action {
        Ok(Action::Rebuild {}) => true,
        Ok(_) => false,
        Err(error) => {
            eprintln!("Could not offer rebuild after a completed companion build: {error}");
            false
        }
    }
}

pub(super) async fn native_choice(
    window: &WebviewWindow,
    submission: &Submission,
    title: &'static str,
    message: String,
    allow: &'static str,
) -> Result<bool, String> {
    submission.show_box()?;
    let mut invalidated = submission.invalidated();
    let (tx, mut rx) = tokio::sync::oneshot::channel();
    if *invalidated.borrow() {
        return submission.assert_pending().map(|()| false);
    }
    window
        .dialog()
        .message(message)
        .parent(window)
        .title(title)
        .kind(MessageDialogKind::Warning)
        .buttons(MessageDialogButtons::OkCancelCustom(
            allow.into(),
            "Cancel".into(),
        ))
        .show_with_result(move |result| {
            let _ = tx.send(result);
        });
    tokio::select! {
        biased;
        _ = invalidated.changed() => {
            for _ in 0..20 {
                dismiss(window, title);
                if tokio::time::timeout(Duration::from_millis(10), &mut rx).await.is_ok() { break; }
            }
            submission.assert_pending().map(|()| false)
        }
        result = &mut rx => {
            submission.assert_pending()?;
            Ok(matches!(result, Ok(MessageDialogResult::Custom(label)) if label == allow))
        }
    }
}

#[cfg(target_os = "macos")]
fn dismiss(window: &WebviewWindow, _title: &'static str) {
    let owner = window.clone();
    let _ = window.run_on_main_thread(move || {
        if let Ok(raw) = owner.ns_window() {
            // RFD presents the handoff alert as a sheet on this owner.
            let owner = unsafe { &*raw.cast::<objc2_app_kit::NSWindow>() };
            if let Some(sheet) = owner.attachedSheet() {
                owner.endSheet_returnCode(&sheet, objc2_app_kit::NSModalResponseCancel);
            }
        }
    });
}

#[cfg(windows)]
fn dismiss(window: &WebviewWindow, title: &'static str) {
    use windows_sys::core::BOOL;
    use windows_sys::Win32::{
        Foundation::{HWND, LPARAM},
        UI::WindowsAndMessaging::{
            EnumWindows, GetWindow, GetWindowTextW, PostMessageW, GW_OWNER, WM_CLOSE,
        },
    };
    struct Search<'a> {
        parent: HWND,
        title: &'a [u16],
    }
    unsafe extern "system" fn find(hwnd: HWND, data: LPARAM) -> BOOL {
        // EnumWindows calls synchronously while the search reference is still live.
        let search = unsafe { &*(data as *const Search<'_>) };
        let mut text = [0u16; 128];
        if unsafe { GetWindow(hwnd, GW_OWNER) } == search.parent {
            let len = unsafe { GetWindowTextW(hwnd, text.as_mut_ptr(), text.len() as i32) };
            if usize::try_from(len)
                .ok()
                .and_then(|length| text.get(..length))
                == Some(search.title)
            {
                unsafe {
                    PostMessageW(hwnd, WM_CLOSE, 0, 0);
                }
                return 0;
            }
        }
        1
    }
    if let Ok(parent) = window.hwnd() {
        let title: Vec<u16> = title.encode_utf16().collect();
        let search = Search {
            parent: parent.0.cast(),
            title: &title,
        };
        unsafe {
            EnumWindows(Some(find), (&search as *const Search<'_>) as LPARAM);
        }
    }
}

#[cfg(not(any(target_os = "macos", windows)))]
fn dismiss(_window: &WebviewWindow, _title: &'static str) {}

pub(super) fn explain_location(
    window: &WebviewWindow,
    title: &str,
    message: &str,
    path: &std::path::Path,
) {
    if window
        .app_handle()
        .get_webview_window(crate::MAIN_WINDOW_LABEL)
        .is_some()
    {
        window
            .dialog()
            .message(format!("{message}\n\n{}", path.display()))
            .parent(window)
            .title(title)
            .kind(MessageDialogKind::Error)
            .show(|_| {});
    }
}
