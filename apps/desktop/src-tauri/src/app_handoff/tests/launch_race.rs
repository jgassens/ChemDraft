//! Deterministic races between a launch and the end of the menu click that allows it.
//!
//! Each race pauses a launch inside the launch boundary, after the click was found live and before
//! the process starts or the file opens, then ends the click on another thread. Ending it must
//! wait for the paused launch, and no launch may start after the end has returned. A test hook in
//! `arming` reports when the ending thread waits at a lock, so no race depends on sleeping.

use super::super::arming::{lock_wait, Arm};
use super::*;
use std::{
    sync::{mpsc, Arc, Mutex},
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

/// Runs `job` for `proof`, pausing it at `at` while `end` runs on another thread.
fn run_paused(job: BuildJob, proof: &Submission, at: Moment, end: impl FnOnce() + Send) -> Run {
    let dir = TestDir::new();
    let race = race(
        |pause| {
            let host = StubHost::new(&dir.0, |now| match now {
                now if now == at => pause.inside(),
                Moment::Check(_) => pause.outside(),
                _ => {}
            });
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

/// The launch at `at` happened before the end returned, the end waited for it, and nothing
/// launched after: the build stopped with `launched` processes and no open.
fn assert_stopped_after_the_paused_launch(
    run: &Run,
    attempts: Option<usize>,
    launched: usize,
    case: &str,
) {
    assert_eq!(run.events, [Event::Launched, Event::Ended], "{case}");
    assert!(run.waited, "{case}: ending the click did not wait");
    assert_eq!(run.ended, stopped_after(attempts), "{case}");
    assert_eq!(run.spawned.len(), launched, "{case}");
    assert_eq!(run.opened, 0, "{case}");
}

#[test]
fn ending_a_click_waits_for_a_first_launch_already_inside_the_boundary() {
    rust_stub();
    for end in ENDS {
        let state = Endpoint::default();
        let approved = build("small");
        let (arm, proof) = shown_click(&state, Some(&approved));
        let run = run_paused(stub_job(approved), &proof, Moment::Launching(1), || {
            end.run(&state, &arm, &proof)
        });
        assert_stopped_after_the_paused_launch(&run, None, 1, &format!("{end:?}"));
        assert_eq!(run.spawned, STEPS[..1], "{end:?}");
    }
}

#[test]
fn ending_a_click_waits_for_a_later_step_already_inside_the_boundary() {
    rust_stub();
    for end in ENDS {
        let state = Endpoint::default();
        let approved = build("small");
        let (arm, proof) = shown_click(&state, Some(&approved));
        let run = run_paused(stub_job(approved), &proof, Moment::Launching(2), || {
            end.run(&state, &arm, &proof)
        });
        assert_stopped_after_the_paused_launch(&run, None, 2, &format!("{end:?}"));
        assert_eq!(run.spawned, STEPS[..2], "{end:?}");
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
        let run = run_paused(stub_job(approved), &proof, Moment::Launching(4), || {
            end.run(&state, &arm, &proof)
        });
        assert_stopped_after_the_paused_launch(&run, Some(2), 4, &format!("{end:?}"));
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
                Moment::Launching(launch),
                || end.run(&state, &arm, &rebuild),
            );
            let case = format!("{end:?} at launch {launch}");
            assert_stopped_after_the_paused_launch(&run, None, launch, &case);
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
            let run = run_paused(stub_job(approved), &proof, Moment::Opening, || {
                end.run(&state, &arm, &proof)
            });
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
    let run = run_paused(stub_job(approved), &proof, Moment::Launching(1), || {
        state.arms.disarm_consent(PLUGIN, CONSENT)
    });
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
