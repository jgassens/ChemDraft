use super::*;
use crate::local_engine::platform::{InstallChild, RunningChild};
use std::io::{self, Read};
use std::process::{Child, ExitStatus, Stdio};

/// A real, long-lived child whose inspection fails independently of its process lifetime.
struct InspectionFailure {
    child: Child,
    fail_wait: bool,
    operations: Vec<&'static str>,
}

impl InspectionFailure {
    fn spawn() -> Self {
        let script = if cfg!(windows) {
            "powershell -NoProfile -Command Start-Sleep -Seconds 30"
        } else {
            "sleep 30 & wait"
        };
        let (program, args) = shell_command(script);
        let mut command = Command::new(program);
        command.args(args).stderr(Stdio::piped());
        if cfg!(windows) {
            platform::WindowsPlatform.configure_child(&mut command);
        } else {
            platform::MacPlatform::new(platform::MacArchitecture::Aarch64)
                .configure_child(&mut command);
        }
        Self {
            child: command.spawn().expect("long-lived child"),
            fail_wait: false,
            operations: Vec::new(),
        }
    }
}

impl InstallChild for InspectionFailure {
    fn id(&self) -> u32 {
        self.child.id()
    }

    fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.operations.push("try_wait failed");
        Err(io::Error::other("stub inspection failed"))
    }

    fn kill(&mut self) -> io::Result<()> {
        self.operations.push("kill");
        self.child.kill()
    }

    fn wait(&mut self) -> io::Result<ExitStatus> {
        self.operations.push("wait");
        if self.fail_wait {
            Err(io::Error::other("stub wait failed"))
        } else {
            self.child.wait()
        }
    }
}

impl Drop for InspectionFailure {
    fn drop(&mut self) {
        // Also clean up if an assertion fails before supervision has reaped the child.
        if matches!(self.child.try_wait(), Ok(None)) {
            platform::kill_process_tree(self.child.id());
            let _ = self.child.kill();
            let _ = platform::sweep_exited_process_group(self.child.id(), true);
            let _ = self.child.wait();
        }
    }
}

#[test]
fn inspection_error_kills_and_reaps_before_reading_stderr() {
    let io = install::SystemInstallIo::<Stub>::from_builder(reqwest::blocking::Client::builder())
        .expect("system io");
    let mut child = InspectionFailure::spawn();
    let mut stderr = child.child.stderr.take().expect("stderr pipe");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        stderr.read_to_end(&mut bytes)
    });
    let started = Instant::now();
    let error = io
        .supervise(
            &mut child,
            Path::new("stub-uv"),
            &AtomicBool::new(false),
            None,
            None,
        )
        .expect_err("inspection fails");

    assert!(error.message.contains("stub inspection failed"));
    assert_eq!(child.operations, ["try_wait failed", "kill", "wait"]);
    assert!(child.child.try_wait().expect("reaped child").is_some());
    assert_eq!(io.running.tracked_pid(), None);
    assert!(install::finish_reader(reader, Duration::from_secs(1))
        .expect("the killed tree closed stderr")
        .is_ok());
    assert!(started.elapsed() < Duration::from_secs(5));
}

#[test]
fn inspection_and_wait_errors_keep_the_pid_until_reaped() {
    let running = RunningChild::default();
    let mut child = InspectionFailure::spawn();
    running.track(&child);
    assert!(running.try_wait(&mut child).is_err());
    assert_eq!(running.tracked_pid(), Some(child.id()));

    running.kill_tree();
    assert_eq!(running.tracked_pid(), Some(child.id()));
    child.fail_wait = true;
    running.kill_and_wait(&mut child);
    assert_eq!(running.tracked_pid(), Some(child.id()));
    #[cfg(windows)]
    {
        let mut attempts = 0;
        let result = crate::local_engine::file_ops::FileOps::new::<Stub>(None)
            .with_running(Some(&running))
            .run("remove staged tree while wait failed", || {
                attempts += 1;
                Err::<(), _>(io::Error::from_raw_os_error(5))
            });
        assert!(result.is_err());
        assert_eq!(attempts, 1, "never retry while the child remains tracked");
    }
    child.fail_wait = false;
    running.kill_and_wait(&mut child);
    assert_eq!(running.tracked_pid(), None);
}

#[test]
fn reader_wait_is_bounded_when_a_pipe_stays_open() {
    let (release, held_pipe) = std::sync::mpsc::channel::<()>();
    let reader = std::thread::spawn(move || held_pipe.recv());
    let started = Instant::now();
    let result = install::finish_reader(reader, Duration::from_millis(50));
    let elapsed = started.elapsed();
    // Release the detached reader so this test leaves no blocked thread behind.
    release.send(()).expect("release reader");
    assert!(result.is_none());
    assert!(elapsed < Duration::from_secs(1));
}
