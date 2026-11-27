//! Deterministic races between a launch and the end of the menu click that allows it.
//!
//! Each race pauses a launch inside the launch boundary, after the click was found live and before
//! the process starts or the file opens, then ends the click on another thread. Ending it must
//! wait for the paused launch, and no launch may start after the end has returned. A test hook in
//! `arming` reports when the ending thread waits at a lock, so no race depends on sleeping.
//!
//! The other side of the boundary: ending a click while a launched process runs, or while a child
//! whose start failed is still being cleaned up, returns at once, and nothing launches after it.
//!
//! Quitting differs from every other end in one way, as in the app: `State::shutdown` first sets
//! the quit flag that the stand-in host reads (`StubHost::quit_flag`), and the process start and
//! the runner read it too, so a paused launch starts no process and a running one is ended.
//! Closing or reloading the document window leaves a running process to finish.

use super::super::{
    arming::{lock_wait, Arm},
    runner::ExitPoll,
};
use super::*;
use std::{
    io::{self, BufRead, BufReader},
    net::{TcpListener, TcpStream},
    process::Child,
    sync::{atomic::AtomicBool, mpsc, Arc, Mutex},
    thread,
};

/// Fails a race that never reaches the expected point instead of hanging. Nothing waits for it to
/// pass: every race step is driven by a channel.
const GUARD: Duration = Duration::from_secs(30);
const OTHER_COMMAND: &str = "plugin.crystalBuilder.other";
const CONSENT: &str = "build-consent";

#[derive(Clone, Copy, Debug, PartialEq)]
enum Event {
    /// The paused launch went on to start its process or open its file.
    Launched,
    /// The call that ended the click returned.
    Ended,
}

enum Seen {
    Waiting,
    Returned,
}

/// The launching thread's side of one race.
struct Pause {
    events: Arc<Mutex<Vec<Event>>>,
    reached: mpsc::Sender<()>,
    resume: mpsc::Receiver<()>,
    ended: mpsc::Receiver<()>,
    paused: Cell<bool>,
}

impl Pause {
    /// The paused point inside the launch boundary: the click was found live, and the process or
    /// open has not started.
    fn inside(&self) {
        assert!(!self.paused.replace(true), "a race pauses one launch");
        let _ = self.reached.send(());
        // An error here means the test thread failed. Go on, so every thread ends.
        let _ = self.resume.recv();
        self.events.lock().unwrap().push(Event::Launched);
    }

    /// Any point outside the launch boundary. Once the launch has paused, this waits for the end
    /// to return, so whatever the launch does next sees the click ended.
    fn outside(&self) {
        if self.paused.get() {
            let _ = self.ended.recv();
        }
    }
}

struct Race<R> {
    result: R,
    events: Vec<Event>,
    /// The end waited at a lock while the launch was paused inside the boundary.
    waited: bool,
}

/// Runs `launch` on one thread until it pauses inside the boundary, then `end` on another. If the
/// end waits at a lock, the launch is let go and must finish before the end returns. If the end
/// returns, the launch is let go after it.
fn race<R: Send>(launch: impl FnOnce(&Pause) -> R + Send, end: impl FnOnce() + Send) -> Race<R> {
    let events = Arc::new(Mutex::new(Vec::new()));
    let (reached_tx, reached) = mpsc::channel();
    let (resume_tx, resume) = mpsc::channel::<()>();
    let (ended_tx, ended) = mpsc::channel();
    let pause = Pause {
        events: events.clone(),
        reached: reached_tx,
        resume,
        ended,
        paused: Cell::new(false),
    };
    let ender_events = events.clone();
    let (result, waited) = thread::scope(move |scope| {
        let launcher = scope.spawn(move || launch(&pause));
        reached
            .recv_timeout(GUARD)
            .expect("the launch reached the launch boundary");
        let (seen_tx, seen) = mpsc::channel();
        let ender = scope.spawn(move || {
            let waiting = seen_tx.clone();
            lock_wait::on_wait(move || {
                let _ = waiting.send(Seen::Waiting);
            });
            end();
            ender_events.lock().unwrap().push(Event::Ended);
            let _ = ended_tx.send(());
            let _ = seen_tx.send(Seen::Returned);
        });
        let waited = match seen
            .recv_timeout(GUARD)
            .expect("ending the click neither returned nor waited at a lock")
        {
            Seen::Waiting => true,
            Seen::Returned => false,
        };
        // Dropping the sender lets the paused launch go on.
        drop(resume_tx);
        let result = launcher.join().unwrap();
        ender.join().unwrap();
        (result, waited)
    });
    let events = events.lock().unwrap().clone();
    Race {
        result,
        events,
        waited,
    }
}

/// The ways a click ends that a launch can race. Revoking a consent is separate: it ends only a
/// click whose consent box is still pending.
#[derive(Clone, Copy, Debug, PartialEq)]
enum End {
    /// The document window closed or reloaded.
    WindowClosed,
    Quit,
    /// The same menu command, clicked again.
    Rearmed,
    OtherCommandArmed,
    /// The plugin's consents cleared, also how uninstalling the plugin ends its clicks.
    PluginCleared,
    /// The plugin's command finished.
    Finished,
    /// A host-started click (a rebuild) released.
    Released,
}

const ENDS: [End; 7] = [
    End::WindowClosed,
    End::Quit,
    End::Rearmed,
    End::OtherCommandArmed,
    End::PluginCleared,
    End::Finished,
    End::Released,
];

impl End {
    fn run(self, state: &Endpoint, arm: &Arm, proof: &Submission) {
        match self {
            Self::WindowClosed => state.discard_menu_invocations(),
            Self::Quit => state.shutdown(),
            Self::Rearmed => {
                state.arms.arm(PLUGIN, COMMAND, Instant::now()).unwrap();
            }
            Self::OtherCommandArmed => {
                state
                    .arms
                    .arm(PLUGIN, OTHER_COMMAND, Instant::now())
                    .unwrap();
            }
            Self::PluginCleared => state.arms.disarm(PLUGIN),
            Self::Finished => state.arms.finish(&arm.invocation(PLUGIN)),
            Self::Released => state.arms.release(PLUGIN, proof),
        }
    }
}

/// A click whose consent and confirmation boxes were shown: approved for `build`, or with `None`
/// a file send. The click's arm comes with it.
fn shown_click(state: &Endpoint, build: Option<&ApprovedBuild>) -> (Arc<Arm>, Submission) {
    let now = Instant::now();
    let arm = state.arms.arm(PLUGIN, COMMAND, now).unwrap();
    state.arms.begin(&arm.invocation(PLUGIN), now).unwrap();
    let proof = arm.submit(now).unwrap();
    proof.bind_consent(CONSENT.into()).unwrap();
    proof.show_box().unwrap();
    if let Some(build) = build {
        proof.bind_build(build).unwrap();
    }
    (arm, proof)
}

struct Run {
    ended: Ended,
    spawned: Vec<String>,
    opened: usize,
    events: Vec<Event>,
    waited: bool,
}

/// Runs `job` for `proof`, pausing it at `at` while `end` runs on another thread. The host reads
/// `stopped`, the quit flag of the endpoint the click belongs to.
fn run_paused(
    job: BuildJob,
    proof: &Submission,
    stopped: &AtomicBool,
    at: Moment,
    end: impl FnOnce() + Send,
) -> Run {
    let dir = TestDir::new();
    let race = race(
        |pause| {
            let host = StubHost::new(&dir.0, |now| match now {
                now if now == at => pause.inside(),
                Moment::Check(_) => pause.outside(),
                _ => {}
            })
            .quit_flag(stopped);
            let ended = ended(job.run(&host, proof));
            (ended, host.spawned.take(), host.opened.take().len())
        },
        end,
    );
    let (ended, spawned, opened) = race.result;
    Run {
        ended,
        spawned,
        opened,
        events: race.events,
        waited: race.waited,
    }
}

/// What the process start reports when the quit flag is already set.
const NOT_STARTED: &str = "The companion pipeline ended before its next step.";

/// The launch paused at process `launched` went on before the end returned, the end waited for it,
/// and nothing launched after: the build stopped with `launched` processes and no open. Quitting
/// set the quit flag before it waited, so there the paused process itself never started, and its
/// attempt counts only if it had started earlier (`quit_attempts`).
fn assert_stopped_after_the_paused_launch(
    run: &Run,
    end: End,
    attempts: Option<usize>,
    quit_attempts: Option<usize>,
    launched: usize,
    case: &str,
) {
    assert_eq!(run.events, [Event::Launched, Event::Ended], "{case}");
    assert!(run.waited, "{case}: ending the click did not wait");
    if end == End::Quit {
        assert_eq!(
            run.ended,
            Ended::Failed(RunCode::Timeout, NOT_STARTED.into(), quit_attempts),
            "{case}"
        );
        assert_eq!(run.spawned.len(), launched - 1, "{case}");
    } else {
        assert_eq!(run.ended, stopped_after(attempts), "{case}");
        assert_eq!(run.spawned.len(), launched, "{case}");
    }
    assert_eq!(run.opened, 0, "{case}");
}

#[test]
fn ending_a_click_waits_for_a_first_launch_already_inside_the_boundary() {
    rust_stub();
    for end in ENDS {
        let state = Endpoint::default();
        let approved = build("small");
        let (arm, proof) = shown_click(&state, Some(&approved));
        let run = run_paused(
            stub_job(approved),
            &proof,
            &state.stopped,
            Moment::Launching(1),
            || end.run(&state, &arm, &proof),
        );
        assert_stopped_after_the_paused_launch(&run, end, None, None, 1, &format!("{end:?}"));
        assert_eq!(run.spawned, STEPS[..run.spawned.len()], "{end:?}");
    }
}

#[test]
fn ending_a_click_waits_for_a_later_step_already_inside_the_boundary() {
    rust_stub();
    for end in ENDS {
        let state = Endpoint::default();
        let approved = build("small");
        let (arm, proof) = shown_click(&state, Some(&approved));
        let run = run_paused(
            stub_job(approved),
            &proof,
            &state.stopped,
            Moment::Launching(2),
            || end.run(&state, &arm, &proof),
        );
        assert_stopped_after_the_paused_launch(&run, end, None, None, 2, &format!("{end:?}"));
        assert_eq!(run.spawned, STEPS[..run.spawned.len()], "{end:?}");
    }
}

#[test]
fn ending_a_click_waits_for_a_later_attempt_already_inside_the_boundary() {
    rust_stub();
    for end in ENDS {
        let state = Endpoint::default();
        // Three poor attempts: process 4 is the first step of the second attempt.
        let approved = retry_build("small", &[2.0, 3.0]);
        let (arm, proof) = shown_click(&state, Some(&approved));
        let run = run_paused(
            stub_job(approved),
            &proof,
            &state.stopped,
            Moment::Launching(4),
            || end.run(&state, &arm, &proof),
        );
        // Quitting, the second attempt never starts, so only the first counts.
        let case = format!("{end:?}");
        assert_stopped_after_the_paused_launch(&run, end, Some(2), Some(1), 4, &case);
    }
}

#[test]
fn ending_a_rebuild_waits_for_its_launch_already_inside_the_boundary() {
    rust_stub();
    // The rebuild's own click never leaves Rust, so no finish message can end it.
    for end in ENDS.into_iter().filter(|end| *end != End::Finished) {
        for launch in [1, 2] {
            let state = Endpoint::default();
            // Every end below leaves this arm unused: only `Finished` reads it.
            let (arm, first) = shown_click(&state, Some(&build("small")));
            first.launch_build(&build("small"), || ()).unwrap();
            let rebuild = state
                .arms
                .arm_rebuild(PLUGIN, COMMAND, Instant::now(), &first)
                .unwrap();
            drop(first);
            let mut approved = build("small");
            approved.combination = "large".into();
            rebuild.bind_build(&approved).unwrap();
            let run = run_paused(
                stub_job(approved),
                &rebuild,
                &state.stopped,
                Moment::Launching(launch),
                || end.run(&state, &arm, &rebuild),
            );
            let case = format!("{end:?} at launch {launch}");
            assert_stopped_after_the_paused_launch(&run, end, None, None, launch, &case);
        }
    }
}

#[test]
fn ending_a_click_waits_for_the_output_open_already_inside_the_boundary() {
    rust_stub();
    for end in ENDS {
        for approved in [build("small"), retry_build("small", &[2.0, 3.0])] {
            let attempts = approved.retry.as_ref().map(|_| 3);
            let state = Endpoint::default();
            let (arm, proof) = shown_click(&state, Some(&approved));
            // Opening is not gated by the quit flag: the open that went on is the one it waited for.
            let run = run_paused(
                stub_job(approved),
                &proof,
                &state.stopped,
                Moment::Opening,
                || end.run(&state, &arm, &proof),
            );
            assert_eq!(run.events, [Event::Launched, Event::Ended], "{end:?}");
            assert!(run.waited, "{end:?}: ending the click did not wait");
            assert_eq!(
                run.ended,
                Ended::Done {
                    opened: true,
                    attempts
                },
                "{end:?}"
            );
            assert_eq!(run.opened, 1, "{end:?}");
            assert!(proof.assert_used().is_err(), "{end:?}");
        }
    }
}

#[test]
fn ending_a_click_waits_for_a_file_send_already_inside_the_boundary() {
    for end in ENDS {
        let state = Endpoint::default();
        let (arm, proof) = shown_click(&state, None);
        let race = race(
            |pause| proof.launch(|| pause.inside()),
            || end.run(&state, &arm, &proof),
        );
        assert_eq!(race.result, Ok(()), "{end:?}");
        assert_eq!(race.events, [Event::Launched, Event::Ended], "{end:?}");
        assert!(race.waited, "{end:?}: ending the click did not wait");
        assert!(proof.assert_used().is_err(), "{end:?}");
    }
}

#[test]
fn a_click_ended_before_the_boundary_launches_nothing() {
    for end in ENDS {
        let state = Endpoint::default();
        let approved = build("small");
        let (arm, proof) = shown_click(&state, Some(&approved));
        end.run(&state, &arm, &proof);
        assert!(proof
            .launch_build(&approved, || panic!("{end:?}: first launch"))
            .is_err());
        let state = Endpoint::default();
        let (arm, proof) = shown_click(&state, Some(&approved));
        proof.launch_build(&approved, || ()).unwrap();
        end.run(&state, &arm, &proof);
        assert!(proof
            .relaunch_build(&approved, || panic!("{end:?}: later launch"))
            .is_err());
    }
}

/// Revoking the click's consent while its consent box is pending ends the click. It takes the
/// stage lock, which a first launch holds, so it waits for a first launch already inside the
/// boundary; that launch spends the click, and from then on the consent store refuses launches
/// (next test).
#[test]
fn revoking_consent_waits_for_a_first_launch_already_inside_the_boundary() {
    rust_stub();
    let state = Endpoint::default();
    let (_, proof) = shown_click(&state, None);
    let race = race(
        |pause| proof.launch(|| pause.inside()),
        || state.arms.disarm_consent(PLUGIN, CONSENT),
    );
    assert_eq!(race.result, Ok(()));
    assert_eq!(race.events, [Event::Launched, Event::Ended]);
    assert!(race.waited, "revoking did not wait");

    let approved = build("small");
    let (_, proof) = shown_click(&state, Some(&approved));
    let run = run_paused(
        stub_job(approved),
        &proof,
        &state.stopped,
        Moment::Launching(1),
        || state.arms.disarm_consent(PLUGIN, CONSENT),
    );
    assert_eq!(run.events, [Event::Launched, Event::Ended]);
    assert!(run.waited, "revoking did not wait");
    // The stand-in host has no consent store; in the app, `authorized` refuses the next step.
    assert_eq!(run.spawned, STEPS);
}

/// Every launch runs while the consent store's lock is held and the grant is found. Revoking the
/// consent or clearing the plugin (also done by uninstalling it) takes the same lock, so it waits
/// for a launch already holding the grant, and no launch finds the grant after it returns.
#[test]
fn revoking_or_clearing_consent_waits_for_a_launch_holding_the_grant() {
    for clear in [false, true] {
        let dir = TestDir::new();
        let store = Store::new(&dir.0);
        let (_, grant) = allow_send_and_build(&store);
        let race = race(
            |pause| store.with_grant(&grant, |_| pause.inside()).unwrap(),
            || {
                if clear {
                    store.clear(PLUGIN).unwrap();
                } else {
                    store.revoke(PLUGIN, &grant.consent_id()).unwrap();
                }
            },
        );
        assert_eq!(race.result, Some(()), "clear {clear}");
        assert_eq!(
            race.events,
            [Event::Launched, Event::Ended],
            "clear {clear}"
        );
        assert!(
            race.waited,
            "clear {clear}: the consent change did not wait"
        );
        assert!(store
            .with_grant(&grant, |_| panic!("the grant is gone"))
            .unwrap()
            .is_none());
    }
}

/// A way to end a click or its consent while a launch has happened: one of `ENDS`, or a consent
/// change.
#[derive(Clone, Copy, Debug, PartialEq)]
enum Invalidation {
    Click(End),
    /// Revoking the build consent in the consent store.
    Revoke,
    /// Clearing the plugin's consents in the store, also done by uninstalling it.
    ClearConsent,
    /// Revoking the consent whose box the click had pending.
    RevokePending,
}

const INVALIDATIONS: [Invalidation; 10] = [
    Invalidation::Click(End::WindowClosed),
    Invalidation::Click(End::Quit),
    Invalidation::Click(End::Rearmed),
    Invalidation::Click(End::OtherCommandArmed),
    Invalidation::Click(End::PluginCleared),
    Invalidation::Click(End::Finished),
    Invalidation::Click(End::Released),
    Invalidation::Revoke,
    Invalidation::ClearConsent,
    Invalidation::RevokePending,
];

impl Invalidation {
    fn run(self, state: &Endpoint, arm: &Arm, proof: &Submission, store: &Store, grant: &Row) {
        match self {
            Self::Click(end) => end.run(state, arm, proof),
            Self::Revoke => {
                store.revoke(PLUGIN, &grant.consent_id()).unwrap();
            }
            Self::ClearConsent => store.clear(PLUGIN).unwrap(),
            Self::RevokePending => state.arms.disarm_consent(PLUGIN, CONSENT),
        }
    }
}

/// On Windows a companion is created suspended, attached to a job and resumed, all in the launch
/// gate under the consent store lock and the stage lock. When attaching or resuming fails, the
/// child is killed there but reaped outside every lock: here its reaping stalls until the test
/// lets it go, and every way of ending the click or its consent returns meanwhile. The launch
/// reports the setup's own error, and the child ends killed.
#[test]
fn a_child_whose_start_failed_is_reaped_outside_the_launch_gate_and_every_lock() {
    rust_stub();
    for invalidation in INVALIDATIONS {
        let case = format!("{invalidation:?}");
        let dir = TestDir::new();
        let store = Store::new(&dir.0);
        let (_, grant) = allow_send_and_build(&store);
        let state = Endpoint::default();
        let approved = build("small");
        let (arm, proof) = shown_click(&state, Some(&approved));
        let (reaping_tx, reaping) = mpsc::channel();
        let (release_tx, release) = mpsc::channel::<()>();
        let (reaped_tx, reaped) = mpsc::channel();
        let mut stalled = false;
        // Stands in for a termination that does not finish until the test allows it.
        let poll: ExitPoll = Box::new(move |child: &mut Child| {
            if !std::mem::replace(&mut stalled, true) {
                let _ = reaping_tx.send(());
                let _ = release.recv();
            }
            let status = child.try_wait();
            if let Ok(Some(status)) = &status {
                let _ = reaped_tx.send(*status);
            }
            status
        });
        let (returned, pending, launched) = thread::scope(|scope| {
            let launcher = scope.spawn(|| {
                store
                    .with_grant(&grant, |_| {
                        proof.launch_build(&approved, || {
                            ChildProcess::start_isolated(
                                rust_stub(),
                                &["linger".into()],
                                &dir.0,
                                |_| Err::<(), _>(io::Error::other("job attach failed")),
                                poll,
                            )
                        })
                    })
                    .unwrap()
            });
            reaping
                .recv_timeout(GUARD)
                .unwrap_or_else(|_| panic!("{case}: the failed child's reaping did not begin"));
            let (ended_tx, ended) = mpsc::channel();
            let (state, arm, proof, store, grant) = (&state, &arm, &proof, &store, &grant);
            let ender = scope.spawn(move || {
                invalidation.run(state, arm, proof, store, grant);
                let _ = ended_tx.send(());
            });
            let returned = ended.recv_timeout(GUARD).is_ok();
            // The child is not reaped yet: its reaping waits for `release`.
            let pending = reaped.try_recv().is_err();
            drop(release_tx);
            let launched = launcher.join().unwrap();
            ender.join().unwrap();
            (returned, pending, launched)
        });
        assert!(
            returned,
            "{case}: ending the click waited for the failed child's cleanup"
        );
        assert!(pending, "{case}: the failed child was reaped too early");
        let error = launched
            .unwrap_or_else(|| panic!("{case}: no grant"))
            .unwrap_or_else(|error| panic!("{case}: refused: {error}"))
            .err()
            .unwrap_or_else(|| panic!("{case}: the launch succeeded"));
        assert_eq!(error.to_string(), "job attach failed", "{case}");
        let status = reaped
            .recv_timeout(GUARD)
            .unwrap_or_else(|_| panic!("{case}: the failed child was not reaped"));
        assert!(!status.success(), "{case}");
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            assert_eq!(status.signal(), Some(libc::SIGKILL), "{case}");
        }
    }
}

struct Held {
    ended: Ended,
    spawned: Vec<String>,
    opened: usize,
    /// The step of the process that was running while the click ended; empty if none was.
    held: String,
}

/// Runs `job` until its `process`th companion process is running, runs `end` while that process
/// still runs, and only after `end` has returned lets the process exit. The process connects to
/// the test once it runs and waits for the test to close the connection, so the order is fixed by
/// the connection alone. With `consent`, every launch also needs the grant in that store; the host
/// reads `stopped`, the quit flag of the endpoint the click belongs to.
///
/// Waiting for the connection and for the step name is bounded by `GUARD`. A runner that ends
/// without connecting (it connects once more as it returns, so only a panic does) fails the test
/// with its own panic or result rather than leaving it blocked.
fn run_holding(
    job: BuildJob,
    proof: &Submission,
    stopped: &AtomicBool,
    process: usize,
    consent: Option<(&Store, Row)>,
    end: impl FnOnce(),
) -> Held {
    let dir = TestDir::new();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let address = listener.local_addr().unwrap();
    thread::scope(|scope| {
        // Owned here, so a failure below closes it before the scope waits for the runner, and a
        // process still to connect then fails at once instead of waiting.
        let listener = listener;
        let runner = scope.spawn(|| {
            let mut host = StubHost::new(&dir.0, |_| {}).quit_flag(stopped);
            host.hold = Some((process, address));
            host.consent = consent;
            let ended = ended(job.run(&host, proof));
            // If no process held, end the wait below with a connection that names no step.
            let _ = TcpStream::connect(address);
            (ended, host.spawned.take(), host.opened.take().len())
        });
        let deadline = Instant::now() + GUARD;
        let stream = loop {
            // Read before the accept: a runner that had returned by then had queued its connection.
            let finished = runner.is_finished();
            match listener.accept() {
                Ok((stream, _)) => break stream,
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
                Err(error) => panic!("accepting the held process failed: {error}"),
            }
            if finished {
                match runner.join() {
                    Ok(outcome) => panic!("the build ended without connecting: {outcome:?}"),
                    Err(panic) => std::panic::resume_unwind(panic),
                }
            }
            assert!(
                Instant::now() < deadline,
                "no companion process connected within {GUARD:?}"
            );
            thread::sleep(Duration::from_millis(5));
        };
        stream.set_nonblocking(false).unwrap();
        stream
            .set_read_timeout(Some(
                deadline
                    .saturating_duration_since(Instant::now())
                    .max(Duration::from_millis(1)),
            ))
            .unwrap();
        let mut held = String::new();
        BufReader::new(&stream)
            .read_line(&mut held)
            .unwrap_or_else(|error| panic!("the held process did not name its step: {error}"));
        if !held.is_empty() {
            // The process runs, and keeps running until `stream` closes.
            end();
        }
        drop(stream);
        let (ended, spawned, opened) = match runner.join() {
            Ok(outcome) => outcome,
            Err(panic) => std::panic::resume_unwind(panic),
        };
        Held {
            ended,
            spawned,
            opened,
            held: held.trim().into(),
        }
    })
}

/// A companion process is running when the click ends or its consent is revoked. The end returns
/// while the process still runs; the process then exits normally, and no later step, attempt or
/// output open launches.
#[test]
fn ending_a_click_while_its_process_runs_returns_and_launches_nothing_after() {
    rust_stub();
    let retry = || retry_build("small", &[2.0, 3.0]);
    // (with retry, held process, its step, attempts when stopped). With retry, process 3 ends the
    // first of three poor attempts, process 4 starts the second, process 9 ends the last. The
    // attempt after process 3 never starts, so it does not count.
    for (retried, process, step, attempts) in [
        (false, 1, STEPS[0], None),
        (false, 2, STEPS[1], None),
        (false, 3, STEPS[2], None),
        (true, 3, STEPS[2], Some(1)),
        (true, 4, STEPS[0], Some(2)),
        (true, 9, STEPS[2], Some(3)),
    ] {
        for invalidation in [
            Invalidation::Click(End::WindowClosed),
            Invalidation::Click(End::Quit),
            Invalidation::Click(End::Rearmed),
            Invalidation::Click(End::OtherCommandArmed),
            Invalidation::Click(End::PluginCleared),
            Invalidation::Click(End::Finished),
            Invalidation::Click(End::Released),
            Invalidation::Revoke,
        ] {
            let case = format!("{invalidation:?} while process {process} runs");
            let dir = TestDir::new();
            let store = Store::new(&dir.0);
            let (_, grant) = allow_send_and_build(&store);
            let state = Endpoint::default();
            let approved = if retried { retry() } else { build("small") };
            let (arm, proof) = shown_click(&state, Some(&approved));
            let consent = (invalidation == Invalidation::Revoke).then(|| (&store, grant.clone()));
            let run = run_holding(
                stub_job(approved),
                &proof,
                &state.stopped,
                process,
                consent,
                || invalidation.run(&state, &arm, &proof, &store, &grant),
            );
            assert_eq!(run.held, step, "{case}");
            let expected = match invalidation {
                // Quitting sets the quit flag, and the runner ends the running process: the
                // build fails as that step's stop, and nothing launches after it.
                Invalidation::Click(End::Quit) => Ended::Failed(
                    RunCode::Timeout,
                    format!(
                        "Companion step \"{}\" exceeded its time limit or was stopped.",
                        pipeline().steps[(process - 1) % STEPS.len()].id
                    ),
                    attempts,
                ),
                Invalidation::Revoke => {
                    Ended::Failed(RunCode::BadParam, CONSENT_GONE.into(), attempts)
                }
                // Every other end, closing the document window among them, leaves the process to
                // exit normally (a stopped one would end the build as above); the next launch
                // is then refused.
                _ => stopped_after(attempts),
            };
            assert_eq!(run.ended, expected, "{case}");
            assert_eq!(run.spawned.len(), process, "{case}");
            assert_eq!(run.opened, 0, "{case}");
        }
    }
    // Held but never ended, the same runs launch everything and open the output.
    for (approved, process, attempts, launched) in
        [(build("small"), 2, None, 3), (retry(), 4, Some(3), 9)]
    {
        let state = Endpoint::default();
        let (_, proof) = shown_click(&state, Some(&approved));
        let run = run_holding(
            stub_job(approved),
            &proof,
            &state.stopped,
            process,
            None,
            || {},
        );
        assert_eq!(
            run.ended,
            Ended::Done {
                opened: true,
                attempts
            }
        );
        assert_eq!(run.spawned.len(), launched);
        assert_eq!(run.opened, 1);
    }
}
