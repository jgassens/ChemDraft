use super::process::RecognitionProgress;
#[cfg(test)]
use super::{InstallPhase, InstallProgress};
pub use crate::local_engine::progress::*;
use std::time::{Duration, Instant};
#[cfg(test)]
use std::{fs, path::PathBuf};
/// Expected growth of the uv cache and managed-Python directories during `uv python install`.
/// Estimate: a real macOS arm64 install left about 70 MB in `python/`.
pub const PYTHON_EXPECTED_GROWTH_BYTES: u64 = if cfg!(target_os = "linux") {
    100_000_000
} else {
    75_000_000
};

/// Expected growth of the uv cache plus the venv during `uv pip install` of PyTorch, torchvision,
/// numpy, MolScribe and their dependencies. Estimates: about 3.6 GB for Linux CPU packages,
/// 1.2 GB for the existing macOS/Windows package set.
pub const PACKAGES_EXPECTED_GROWTH_BYTES: u64 = if cfg!(target_os = "linux") {
    3_600_000_000
} else {
    1_200_000_000
};

/// The same limit for a recognition's progress. A new stage, and a change in how many readings are
/// planned, always pass; readings within one plan pass at most once per `interval`. A skipped
/// reading only delays the count until the next one, and the answer ends the display anyway.
pub struct RecognitionThrottle {
    interval: Duration,
    last: Option<(RecognitionProgress, Instant)>,
}

impl RecognitionThrottle {
    pub fn new(interval: Duration) -> Self {
        Self {
            interval,
            last: None,
        }
    }

    pub fn admit(&mut self, progress: RecognitionProgress, now: Instant) -> bool {
        let boundary = match (self.last.map(|(last, _)| last), progress) {
            (None, _) => true,
            (
                Some(RecognitionProgress::Reading {
                    runs_planned: before,
                    ..
                }),
                RecognitionProgress::Reading { runs_planned, .. },
            ) => before != runs_planned,
            (Some(last), next) => std::mem::discriminant(&last) != std::mem::discriminant(&next),
        };
        let due = self
            .last
            .is_none_or(|(_, at)| now.saturating_duration_since(at) >= self.interval);
        if boundary || due {
            self.last = Some((progress, now));
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

    #[test]
    fn recognition_progress_is_limited_to_a_few_events_a_second() {
        let start = Instant::now();
        let reading = |run, runs_planned| RecognitionProgress::Reading { run, runs_planned };
        let mut throttle = RecognitionThrottle::new(EMIT_INTERVAL);
        assert!(throttle.admit(RecognitionProgress::Starting, start));
        // A new stage passes at once, however soon.
        assert!(throttle.admit(reading(1, 5), start + Duration::from_millis(1)));
        // Readings within one plan are rate-limited...
        assert!(!throttle.admit(reading(2, 5), start + Duration::from_millis(100)));
        assert!(throttle.admit(reading(3, 5), start + Duration::from_millis(300)));
        // ...but a widened vote is news and passes at once.
        assert!(throttle.admit(reading(6, 15), start + Duration::from_millis(301)));
        // A burst of 15 readings in one second produces at most five events.
        let mut burst = RecognitionThrottle::new(EMIT_INTERVAL);
        let admitted = (1..=15)
            .filter(|run| {
                burst.admit(
                    reading(*run, 15),
                    start + Duration::from_millis(u64::from(*run) * 66),
                )
            })
            .count();
        assert!(admitted <= 5, "{admitted} events in a second");
    }

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
