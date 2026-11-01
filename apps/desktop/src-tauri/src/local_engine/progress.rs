//! Directory-growth estimates and progress throttling for local installs.
use super::{InstallPhase, InstallProgress};
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};
/// How often a running uv step is measured.
pub const SAMPLE_INTERVAL: Duration = Duration::from_millis(500);

/// The fastest the webview is sent progress: about four events per second.
pub const EMIT_INTERVAL: Duration = Duration::from_millis(250);

/// Estimates a uv step's progress from directory growth; see the module documentation.
pub struct GrowthEstimator {
    phase: InstallPhase,
    label: &'static str,
    watched: Vec<PathBuf>,
    baseline: u64,
    expected_bytes: u64,
    done: u64,
}

impl GrowthEstimator {
    /// Measures the watched directories now, so only growth from this point is counted.
    pub fn new(
        phase: InstallPhase,
        label: &'static str,
        watched: Vec<PathBuf>,
        expected_bytes: u64,
    ) -> Self {
        let baseline = approximate_size(&watched);
        Self {
            phase,
            label,
            watched,
            baseline,
            expected_bytes: expected_bytes.max(1),
            done: 0,
        }
    }

    /// The current estimate: never lower than the last one, and never above 99% of the expected
    /// total while the step runs (uv deletes temporary files, and the true total is unknown).
    pub fn sample(&mut self) -> InstallProgress {
        let grown = approximate_size(&self.watched).saturating_sub(self.baseline);
        let cap = self.expected_bytes / 100 * 99;
        self.done = self.done.max(grown.min(cap));
        self.progress()
    }

    /// The step exited successfully, which is the only thing that may report 100%.
    pub fn finished(&mut self) -> InstallProgress {
        self.done = self.expected_bytes;
        self.progress()
    }

    fn progress(&self) -> InstallProgress {
        let megabytes = |bytes: u64| bytes / 1_000_000;
        InstallProgress {
            phase: self.phase,
            message: format!(
                "{}: about {} of {} MB (estimated).",
                self.label,
                megabytes(self.done),
                megabytes(self.expected_bytes)
            ),
            bytes_done: Some(self.done),
            bytes_total: Some(self.expected_bytes),
            estimated: true,
        }
    }
}

/// Sum of regular-file sizes under `roots`, tolerating whatever uv is creating, renaming and
/// deleting at the same moment: an unreadable or vanished entry is skipped, not an error.
/// Symlinks are not followed, so the venv's interpreter link is not counted twice.
pub fn approximate_size(roots: &[PathBuf]) -> u64 {
    let mut total = 0_u64;
    let mut pending: Vec<PathBuf> = roots.iter().filter(|p| p.exists()).cloned().collect();
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_dir() {
                pending.push(entry.path());
            } else if file_type.is_file() {
                if let Ok(metadata) = entry.metadata() {
                    total = total.saturating_add(metadata.len());
                }
            }
        }
    }
    total
}

/// Decides which progress events reach the webview. A new phase and a completed byte count always
/// pass, so the dialog never misses a step or stalls one short of full; anything else passes at
/// most once per `interval`.
pub struct ProgressThrottle<P = InstallPhase> {
    interval: Duration,
    last: Option<(P, Instant)>,
}

impl<P: Copy + PartialEq> ProgressThrottle<P> {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    pub fn admit_phase(&mut self, phase: P, completed: bool, now: Instant) -> bool {
        let boundary = match self.last {
            None => true,
            Some((previous, _)) => previous != phase,
        } || completed;
        let due = self
            .last
            .is_none_or(|(_, at)| now.saturating_duration_since(at) >= self.interval);
        if boundary || due {
            self.last = Some((phase, now));
            true
        } else {
            false
        }
    }
}

impl ProgressThrottle<InstallPhase> {
    pub fn admit(&mut self, progress: &InstallProgress, now: Instant) -> bool {
        self.admit_phase(
            progress.phase,
            progress.phase == InstallPhase::Done
                || (progress.bytes_total.is_some() && progress.bytes_done == progress.bytes_total),
            now,
        )
    }
}
