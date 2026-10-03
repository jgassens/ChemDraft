//! Bug and crash reports go out as an email the user reviews and sends from their own mail client.
//!
//! Nothing is sent silently: the webview builds a `mailto:` draft (`problemReports.ts`) and this
//! module only hands it to the OS. A Rust panic cannot ask the user anything, so the panic hook
//! writes a short note to the app data directory and the next launch offers to email it.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use tauri::{AppHandle, Manager, Runtime};

/// The only address a report may be drafted to. The webview builds the URL, so the native side
/// re-checks it rather than opening whatever `mailto:` it is handed.
pub(crate) const PROBLEM_REPORT_ADDRESS: &str = "jgassens@gmail.com";

/// Long enough for a report body, short enough that every mail client accepts the URL.
const MAX_MAILTO_LEN: usize = 8000;

/// The crash note left by the panic hook for the next launch to offer.
const PENDING_CRASH_FILE: &str = "pending-crash-report.txt";

/// Keeps a runaway panic message from filling the disk or the email.
const MAX_CRASH_NOTE_BYTES: usize = 6000;

static CRASH_NOTE_PATH: OnceLock<PathBuf> = OnceLock::new();

fn is_problem_report_mailto(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("mailto:") else {
        return false;
    };
    let Some((address, _query)) = rest.split_once('?') else {
        return false;
    };
    address == PROBLEM_REPORT_ADDRESS
        && url.len() <= MAX_MAILTO_LEN
        && url.chars().all(|ch| ch.is_ascii_graphic())
}

/// Opens the user's mail client on a drafted report. The draft is only shown, never sent.
#[tauri::command]
pub(crate) fn open_problem_report_email(url: String) -> Result<(), String> {
    if !is_problem_report_mailto(&url) {
        return Err("Only a ChemDraft problem report can be opened this way.".into());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = std::process::Command::new("/usr/bin/open");
        command.arg(&url);
        command
    };
    // `start` and `explorer` both mangle `&` in a URL; the URL protocol handler takes it whole.
    #[cfg(target_os = "windows")]
    let mut command = {
        use crate::WithoutConsoleWindow;
        let mut command = std::process::Command::new("rundll32.exe");
        command
            .arg("url.dll,FileProtocolHandler")
            .arg(&url)
            .without_console_window();
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = {
        let mut command = std::process::Command::new("xdg-open");
        command.arg(&url);
        command
    };
    let mut child = command.spawn().map_err(|error| {
        format!("Could not open your email program to send the report: {error}")
    })?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

/// Returns (and removes) the crash note a previous run's panic left behind, if any.
#[tauri::command]
pub(crate) fn take_pending_crash_report<R: Runtime>(app: AppHandle<R>) -> Option<String> {
    let path = pending_crash_path(&app)?;
    take_crash_note(&path)
}

fn pending_crash_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|directory| directory.join(PENDING_CRASH_FILE))
}

fn take_crash_note(path: &Path) -> Option<String> {
    let note = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    let note = note.trim();
    (!note.is_empty()).then(|| note.to_string())
}

/// Chains a hook in front of the default panic hook that records the panic for the next launch.
pub(crate) fn install_panic_hook<R: Runtime>(app: &AppHandle<R>) {
    let Some(path) = pending_crash_path(app) else {
        return;
    };
    if CRASH_NOTE_PATH.set(path).is_err() {
        return;
    }
    let version = app.package_info().version.to_string();
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(path) = CRASH_NOTE_PATH.get() {
            let location = info
                .location()
                .map(|location| format!("{}:{}", location.file(), location.line()))
                .unwrap_or_else(|| "unknown location".into());
            let message = info
                .payload()
                .downcast_ref::<&str>()
                .map(|text| (*text).to_string())
                .or_else(|| info.payload().downcast_ref::<String>().cloned())
                .unwrap_or_else(|| "(no message)".into());
            let thread = std::thread::current();
            let note = crash_note(
                &version,
                thread.name().unwrap_or("unnamed"),
                &message,
                &location,
            );
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            let _ = std::fs::write(path, note);
        }
        previous(info);
    }));
}

fn crash_note(version: &str, thread: &str, message: &str, location: &str) -> String {
    let mut note = format!(
        "ChemDraft {version} ({} {}) stopped unexpectedly.\nThread: {thread}\nWhere: {location}\nMessage: {message}\n",
        std::env::consts::OS,
        std::env::consts::ARCH,
    );
    if note.len() > MAX_CRASH_NOTE_BYTES {
        let mut end = MAX_CRASH_NOTE_BYTES;
        while !note.is_char_boundary(end) {
            end -= 1;
        }
        note.truncate(end);
    }
    note
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_reports_to_the_report_address() {
        assert!(is_problem_report_mailto(
            "mailto:jgassens@gmail.com?subject=ChemBUG%3A%20x&body=y"
        ));
        assert!(!is_problem_report_mailto(
            "mailto:someone@example.com?subject=x"
        ));
        assert!(!is_problem_report_mailto(
            "mailto:jgassens@gmail.com,other@example.com?subject=x"
        ));
        assert!(!is_problem_report_mailto("https://jgassens@gmail.com?x"));
        assert!(!is_problem_report_mailto("mailto:jgassens@gmail.com"));
        assert!(!is_problem_report_mailto(
            "mailto:jgassens@gmail.com?subject=has space"
        ));
        let long = format!(
            "mailto:jgassens@gmail.com?body={}",
            "a".repeat(MAX_MAILTO_LEN)
        );
        assert!(!is_problem_report_mailto(&long));
    }

    #[test]
    fn crash_note_is_taken_once() {
        let directory =
            std::env::temp_dir().join(format!("chemdraft-crash-note-test-{}", std::process::id()));
        std::fs::create_dir_all(&directory).unwrap();
        let path = directory.join(PENDING_CRASH_FILE);
        std::fs::write(&path, crash_note("1.0.0", "main", "boom", "lib.rs:1")).unwrap();
        let note = take_crash_note(&path).expect("a note");
        assert!(note.contains("Message: boom"));
        assert!(note.contains("Where: lib.rs:1"));
        assert!(take_crash_note(&path).is_none());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn crash_note_is_capped() {
        let note = crash_note("1.0.0", "main", &"é".repeat(MAX_CRASH_NOTE_BYTES), "x");
        assert!(note.len() <= MAX_CRASH_NOTE_BYTES);
    }
}
