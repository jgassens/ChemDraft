//! Contextual installer IO. Retries are disabled while an owned child remains tracked.
//! Windows scanners can briefly lock freshly written files; Unix keeps a single attempt.
use super::platform::RunningChild;
use super::{EngineSpec, InstallError};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::Path;
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::{sync::atomic::Ordering, time::Duration};

#[derive(Clone, Copy)]
pub(crate) struct FileOps<'a> {
    prefix: &'static str,
    cancel: Option<&'a AtomicBool>,
    running: Option<&'a RunningChild>,
}

#[derive(Debug)]
struct Cancelled;
impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("installation cancelled between file operation attempts")
    }
}
impl std::error::Error for Cancelled {}

pub(crate) fn failed<S: EngineSpec>(error: io::Error) -> InstallError {
    if error.get_ref().is_some_and(|error| error.is::<Cancelled>()) {
        S::cancelled()
    } else {
        let error = S::failed_io(error);
        eprintln!("{} {}", S::LOG_PREFIX, error.message);
        error
    }
}

pub(crate) fn relocation_failed<S: EngineSpec>(error: io::Error) -> InstallError {
    if error.get_ref().is_some_and(|error| error.is::<Cancelled>()) {
        S::cancelled()
    } else {
        let error = S::relocation_error(error);
        eprintln!("{} {}", S::LOG_PREFIX, error.message);
        error
    }
}

impl<'a> FileOps<'a> {
    #[cfg(test)]
    pub(super) fn for_tests() -> Self {
        Self {
            prefix: "[chemdraft test]",
            cancel: None,
            running: None,
        }
    }

    pub(crate) fn new<S: EngineSpec>(cancel: Option<&'a AtomicBool>) -> Self {
        Self {
            prefix: S::LOG_PREFIX,
            cancel,
            running: None,
        }
    }

    pub(crate) fn with_running(mut self, running: Option<&'a RunningChild>) -> Self {
        self.running = running;
        self
    }

    /// Always allow the first attempt, including rollback after cancellation; never retry after
    /// cancel. All operations must be safe to repeat. Retry write(), not write_all() or a copy
    /// whose partially written prefix would otherwise be duplicated.
    pub(crate) fn run<T>(
        &self,
        context: impl AsRef<str>,
        operation: impl FnMut() -> io::Result<T>,
    ) -> io::Result<T> {
        self.context(context, self.retry(operation))
    }

    pub(crate) fn context<T>(
        &self,
        context: impl AsRef<str>,
        result: io::Result<T>,
    ) -> io::Result<T> {
        result.map_err(|error| {
            let detail = format!("could not {}: {error}", context.as_ref());
            eprintln!("{} {detail}", self.prefix);
            if error.get_ref().is_some_and(|error| error.is::<Cancelled>()) {
                error
            } else {
                io::Error::new(error.kind(), detail)
            }
        })
    }

    #[cfg(not(windows))]
    fn retry<T>(&self, mut operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
        let _ = (self.cancel, self.running);
        operation()
    }

    #[cfg(windows)]
    fn retry<T>(&self, mut operation: impl FnMut() -> io::Result<T>) -> io::Result<T> {
        let mut delays = [50, 100, 200, 400, 800, 1600].into_iter();
        loop {
            match operation() {
                Err(error) if matches!(error.raw_os_error(), Some(5 | 32 | 33)) => {
                    // A failed wait leaves the child tracked. Cleanup may try once, but must
                    // never back off and retry against a tree an unreaped child could still use.
                    if self.running.is_some_and(RunningChild::has_child) {
                        return Err(error);
                    }
                    let Some(delay) = delays.next() else {
                        return Err(error);
                    };
                    // Poll during longer delays so Cancel never waits the full 1.6 seconds.
                    for _ in 0..delay / 10 {
                        self.check_cancel()?;
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    self.check_cancel()?;
                    if self.running.is_some_and(RunningChild::has_child) {
                        return Err(error);
                    }
                }
                result => return result,
            }
        }
    }

    #[cfg(windows)]
    fn check_cancel(&self) -> io::Result<()> {
        if self
            .cancel
            .is_some_and(|cancel| cancel.load(Ordering::SeqCst))
        {
            Err(io::Error::new(io::ErrorKind::Interrupted, Cancelled))
        } else {
            Ok(())
        }
    }

    pub(crate) fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.run(
            format!("rename {} to {}", from.display(), to.display()),
            || fs::rename(from, to),
        )
    }
    pub(crate) fn create_dir(&self, path: &Path) -> io::Result<()> {
        self.run(format!("create directory {}", path.display()), || {
            fs::create_dir(path)
        })
    }
    pub(crate) fn create_dir_all(&self, path: &Path) -> io::Result<()> {
        self.run(format!("create directories {}", path.display()), || {
            fs::create_dir_all(path)
        })
    }
    pub(crate) fn remove_dir_all(&self, path: &Path) -> io::Result<()> {
        self.run(format!("remove directory tree {}", path.display()), || {
            fs::remove_dir_all(path)
        })
    }
    pub(crate) fn remove_file(&self, path: &Path) -> io::Result<()> {
        self.run(format!("remove file {}", path.display()), || {
            fs::remove_file(path)
        })
    }
    pub(crate) fn create(&self, path: &Path) -> io::Result<File> {
        self.run(format!("create file {}", path.display()), || {
            File::create(path)
        })
    }
    pub(crate) fn write_all(
        &self,
        file: &mut impl Write,
        path: &Path,
        bytes: &[u8],
    ) -> io::Result<()> {
        #[cfg(not(windows))]
        return self.context(
            format!("write file {}", path.display()),
            file.write_all(bytes),
        );

        #[cfg(windows)]
        let mut bytes = bytes;
        #[cfg(windows)]
        while !bytes.is_empty() {
            let count = self.run(format!("write file {}", path.display()), || {
                match file.write(bytes) {
                    Ok(0) => Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "failed to write file",
                    )),
                    result => result,
                }
            })?;
            bytes = &bytes[count..];
        }
        #[cfg(windows)]
        Ok(())
    }
    pub(crate) fn write(&self, path: &Path, bytes: &[u8]) -> io::Result<()> {
        let mut file = self.create(path)?;
        self.write_all(&mut file, path, bytes)
    }
    pub(crate) fn sync(&self, file: &File, path: &Path) -> io::Result<()> {
        self.run(format!("sync file {}", path.display()), || file.sync_all())
    }
    pub(crate) fn copy(
        &self,
        reader: &mut impl Read,
        source: &Path,
        output: &mut File,
        destination: &Path,
    ) -> io::Result<u64> {
        #[cfg(not(windows))]
        return self.context(
            format!(
                "copy archive {} to {}",
                source.display(),
                destination.display()
            ),
            io::copy(reader, output),
        );

        #[cfg(windows)]
        {
            let mut bytes = [0; 128 * 1024];
            let mut total = 0;
            loop {
                // Never replay a decoder read after partially consuming its input.
                let count = reader.read(&mut bytes).map_err(|error| {
                    let detail = format!("could not read archive {}: {error}", source.display());
                    eprintln!("{} {detail}", self.prefix);
                    io::Error::new(error.kind(), detail)
                })?;
                if count == 0 {
                    return Ok(total);
                }
                self.write_all(output, destination, &bytes[..count])?;
                total += count as u64;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn ops(cancel: Option<&AtomicBool>) -> FileOps<'_> {
        FileOps {
            prefix: "[test engine]",
            cancel,
            running: None,
        }
    }
    #[cfg(windows)]
    #[test]
    fn transient_errors_retry_then_succeed() {
        for code in [5, 32, 33] {
            let mut attempts = 0;
            ops(None)
                .run("write staged/file", || {
                    attempts += 1;
                    if attempts < 3 {
                        Err(io::Error::from_raw_os_error(code))
                    } else {
                        Ok(())
                    }
                })
                .unwrap();
            assert_eq!(attempts, 3);
        }
    }
    #[test]
    fn other_errors_are_not_retried() {
        let mut attempts = 0;
        let error = ops(None)
            .run("create staged/file", || {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(2))
            })
            .unwrap_err();
        assert_eq!(attempts, 1);
        assert!(error.to_string().contains("could not create staged/file"));
    }
    #[test]
    fn bounded_failure_has_context() {
        let mut attempts = 0;
        let error = ops(None)
            .run("remove directory tree staged/cache", || {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(5))
            })
            .unwrap_err();
        assert_eq!(attempts, if cfg!(windows) { 7 } else { 1 });
        assert!(error
            .to_string()
            .contains("could not remove directory tree staged/cache"));
        assert!(error.to_string().contains("os error 5"));
    }
    #[cfg(windows)]
    #[test]
    fn cancellation_stops_retries() {
        let cancel = AtomicBool::new(false);
        let mut attempts = 0;
        let error = ops(Some(&cancel))
            .run("write staged/file", || {
                attempts += 1;
                cancel.store(true, Ordering::SeqCst);
                Err::<(), _>(io::Error::from_raw_os_error(32))
            })
            .unwrap_err();
        assert_eq!(attempts, 1);
        assert!(error.get_ref().unwrap().is::<Cancelled>());
    }
    #[cfg(windows)]
    #[test]
    fn retrying_partial_writes_does_not_duplicate_bytes() {
        #[derive(Default)]
        struct Writer {
            calls: usize,
            bytes: Vec<u8>,
        }
        impl Write for Writer {
            fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
                self.calls += 1;
                if self.calls == 2 {
                    return Err(io::Error::from_raw_os_error(32));
                }
                let count = bytes.len().min(2);
                self.bytes.extend_from_slice(&bytes[..count]);
                Ok(count)
            }
            fn flush(&mut self) -> io::Result<()> {
                Ok(())
            }
        }
        let mut writer = Writer::default();
        ops(None)
            .write_all(&mut writer, Path::new("staged/file"), b"abcdef")
            .unwrap();
        assert_eq!(writer.bytes, b"abcdef");
        assert_eq!(writer.calls, 4);
    }
    #[test]
    fn failed_rename_names_both_paths() {
        let root = std::env::temp_dir().join(format!("chemdraft-missing-{}", std::process::id()));
        let from = root.join("staged");
        let to = root.join("final");
        let error = ops(None).rename(&from, &to).unwrap_err().to_string();
        assert!(error.contains(&format!("rename {} to {}", from.display(), to.display())));
    }
    #[cfg(not(windows))]
    #[test]
    fn non_windows_is_one_attempt_even_when_cancelled() {
        let cancel = AtomicBool::new(true);
        let mut attempts = 0;
        ops(Some(&cancel))
            .run("write staged/file", || {
                attempts += 1;
                Ok(())
            })
            .unwrap();
        assert_eq!(attempts, 1);
    }
}
