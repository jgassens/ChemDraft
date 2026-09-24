//! Progress for the install steps that report none of their own, and a rate limit for all of it.
//!
//! uv prints no byte counts when its output is not a terminal, so `uv python install` and
//! `uv pip install` — the longest part of an install — used to send one message and then nothing
//! for minutes. [`GrowthEstimator`] fills that gap by measuring how much the directories uv writes
//! into have grown, against a fixed expected total. **It is an estimate**, not a byte count: the
//! expected totals below were measured on one macOS arm64 install, wheel sizes differ by platform
//! and release, and APFS clones from the uv cache into the venv are counted at their logical size.
//! The estimate therefore never claims completion on its own: it is monotonic, it stops at 99%
//! while the step is still running, and only the step's successful exit reports 100%.

use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use super::{InstallPhase, InstallProgress};

/// Expected growth of the uv cache and managed-Python directories during `uv python install`.
/// Estimate: a real macOS arm64 install left about 70 MB in `python/`.
pub const PYTHON_EXPECTED_GROWTH_BYTES: u64 = 75_000_000;

/// Expected growth of the uv cache plus the venv during `uv pip install` of PyTorch, torchvision,
/// numpy, MolScribe and their dependencies. Estimate: about 1.2 GB.
pub const PACKAGES_EXPECTED_GROWTH_BYTES: u64 = 1_200_000_000;

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
pub struct ProgressThrottle {
    interval: Duration,
    last: Option<(InstallPhase, Instant)>,
}

impl ProgressThrottle {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    pub fn admit(&mut self, progress: &InstallProgress, now: Instant) -> bool {
        let boundary = match self.last {
            None => true,
            Some((phase, _)) => phase != progress.phase,
        } || progress.phase == InstallPhase::Done
            || (progress.bytes_total.is_some() && progress.bytes_done == progress.bytes_total);
        let due = self
            .last
            .is_none_or(|(_, at)| now.saturating_duration_since(at) >= self.interval);
        if boundary || due {
            self.last = Some((progress.phase, now));
            true
        } else {
            false
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "chemdraft-ocsr-progress-{label}-{}-{}",
            std::process::id(),
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        fs::create_dir_all(&root).expect("test root");
        root
    }

    fn write(path: &Path, bytes: usize) {
        fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
        fs::write(path, vec![0_u8; bytes]).expect("fixture file");
    }

    #[test]
    fn estimator_counts_growth_since_start_and_is_monotonic() {
        let root = temp_root("monotonic");
        let cache = root.join("download-cache");
        let venv = root.join("venv");
        write(&cache.join("existing.bin"), 400);
        // `venv` does not exist yet; uv creates it part-way through the step.
        let mut estimator = GrowthEstimator::new(
            InstallPhase::InstallingPackages,
            "Installing packages",
            vec![cache.clone(), venv.clone()],
            10_000,
        );

        let first = estimator.sample();
        assert_eq!(first.bytes_done, Some(0), "pre-existing bytes are baseline");
        assert_eq!(first.bytes_total, Some(10_000));
        assert!(first.estimated);
        assert_eq!(first.phase, InstallPhase::InstallingPackages);

        write(&cache.join("archive/torch/a.bin"), 3_000);
        let second = estimator.sample();
        assert_eq!(second.bytes_done, Some(3_000));

        write(&venv.join("lib/site-packages/torch/a.bin"), 2_000);
        let third = estimator.sample();
        assert_eq!(third.bytes_done, Some(5_000));

        // uv removes its temporary files; the estimate must not go backwards.
        fs::remove_file(cache.join("archive/torch/a.bin")).expect("remove");
        let fourth = estimator.sample();
        assert_eq!(fourth.bytes_done, Some(5_000));
        assert!(fourth.message.contains("(estimated)"));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn estimator_stays_below_full_until_the_step_finishes() {
        let root = temp_root("capped");
        let watched = root.join("python");
        let mut estimator = GrowthEstimator::new(
            InstallPhase::InstallingPython,
            "Installing Python",
            vec![watched.clone()],
            1_000,
        );
        write(&watched.join("big.bin"), 5_000);
        let running = estimator.sample();
        assert_eq!(running.bytes_done, Some(990), "capped at 99% while running");
        assert!(running.bytes_done < running.bytes_total);
        let again = estimator.sample();
        assert_eq!(again.bytes_done, Some(990));

        let finished = estimator.finished();
        assert_eq!(finished.bytes_done, Some(1_000));
        assert_eq!(finished.bytes_total, Some(1_000));

        fs::remove_dir_all(root).expect("cleanup");
    }

    #[test]
    fn approximate_size_skips_missing_roots_and_does_not_follow_symlinks() {
        let root = temp_root("size");
        write(&root.join("a/one.bin"), 10);
        write(&root.join("a/b/two.bin"), 20);
        #[cfg(unix)]
        std::os::unix::fs::symlink(root.join("a/b/two.bin"), root.join("a/link")).expect("link");
        assert_eq!(
            approximate_size(&[root.join("a"), root.join("missing")]),
            30
        );
        fs::remove_dir_all(root).expect("cleanup");
    }

    fn event(phase: InstallPhase, done: Option<u64>, total: Option<u64>) -> InstallProgress {
        InstallProgress {
            phase,
            message: String::new(),
            bytes_done: done,
            bytes_total: total,
            estimated: false,
        }
    }

    #[test]
    fn throttle_limits_to_four_per_second_but_never_drops_a_phase_change_or_completion() {
        let mut throttle = ProgressThrottle::new(EMIT_INTERVAL);
        let start = Instant::now();
        let at = |ms: u64| start + Duration::from_millis(ms);
        let model = |done: u64| event(InstallPhase::DownloadingModel, Some(done), Some(100));

        assert!(throttle.admit(&model(1), at(0)), "first event passes");
        assert!(!throttle.admit(&model(2), at(10)));
        assert!(!throttle.admit(&model(3), at(249)));
        assert!(throttle.admit(&model(4), at(250)));

        let admitted = (0..1_000)
            .filter(|ms| throttle.admit(&model(5 + (*ms % 90)), at(251 + ms)))
            .count();
        assert!(admitted <= 5, "one second admitted {admitted} events");

        assert!(throttle.admit(&model(100), at(1_300)), "completion passes");
        assert!(
            throttle.admit(&event(InstallPhase::Verifying, None, None), at(1_301)),
            "a new phase passes"
        );
        assert!(throttle.admit(&event(InstallPhase::Done, None, None), at(1_302)));
    }
}
