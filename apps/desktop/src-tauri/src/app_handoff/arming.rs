//! Native menu clicks ("arms") and the launches each one allows.
//!
//! # Launch ordering
//!
//! Every launch a click allows (a file send's open, a build's first step, each later step and
//! attempt, a rebuild's steps, and opening the output) checks that the click is live and starts
//! its process or open inside the click's launch gate (`Arm::while_live`). Every invalidation
//! (`Arm::invalidate`: window close or reload, a new arming, finish, release, disarm, consent
//! revoke, shutdown, and a duplicate request) marks the click ended inside the same gate. So once
//! an invalidation has returned, no launch of that click starts, and a launch already inside the
//! gate has started its process or open before the invalidation returns. An arm can only be
//! dropped once no `Submission` holds it, so dropping one never races a launch.
//!
//! The gate holds only the liveness check and starting the process or open (`Command::spawn`, and
//! on Windows attaching the job and resuming the suspended child). No receipt, output or exit is
//! waited for inside it: a child whose job or resume fails is killed there without a wait and
//! reaped on a thread of its own (`runner::ChildProcess::start`). So an invalidating caller, the
//! main thread included, waits at most for one process to start.
//!
//! Locks, outermost first. Each is only taken while holding locks above it, never below:
//!
//! 1. the consent store's `LOCK` (`consent.rs`), held by a launch around the grant check, the app
//!    identity check and the launch; and by revoke and clear, released before they disarm;
//! 2. `State::arms`, held by every invalidation through `State`; never held by a launch. Arming
//!    a click checks `State::closed` and the caller's quit check (`arm_unless`) and inserts the
//!    click under it, and `close` sets `closed` and ends every click under it, so a click either
//!    arms before a committed quit or shutdown closes arming (and is ended by it) or sees it
//!    closed. The quit check only reads atomic flags, so it takes no lock under `arms`;
//! 3. an arm's `stage`, held by a first launch around the gate, by `disarm_consent` and a duplicate
//!    `submit` around their invalidation, and briefly elsewhere;
//! 4. an arm's `gate`, the innermost: while it is held, no other ChemDraft lock is taken and no
//!    other ChemDraft thread is waited for; only the new process's start is.
//!
//! The consent store lock and `arms` are never held together. Only leaf locks, which take no
//! further lock, are taken under the gate (the `invalidated` watch channel's own lock), so there
//! is no cycle, and nothing that holds the gate waits on the main thread.

use super::{
    temp_files,
    wire::{Input, RetryCondition},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LockResult, Mutex, MutexGuard, OnceLock, PoisonError, TryLockError,
    },
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(super) const RACE: &str = "App handoff refused because two requests claimed one menu click.";
const NO_ARMING: &str = "Start app handoff from the plugin's native menu.";

#[derive(Default)]
pub(crate) struct State {
    arms: Mutex<HashMap<String, Arc<Arm>>>,
    /// Set by `close` (a committed quit, or the exit's shutdown) and never cleared: no click arms
    /// again. Only read and written while `arms` is held, which orders it; the atomic only lets
    /// `State` stay shareable.
    closed: AtomicBool,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MenuInvocation {
    pub plugin_id: String,
    pub command_id: String,
    pub nonce: String,
}

pub(super) struct Arm {
    pub command: String,
    nonce: String,
    claimed: OnceLock<()>,
    expires: Instant,
    stage: Mutex<Stage>,
    build: OnceLock<BuildChoice>,
    invalidated: watch::Sender<bool>,
    /// The launch gate (see the module comment). It guards no data, so a poisoned gate is used as
    /// it is.
    gate: Mutex<()>,
}

#[derive(Default)]
enum Stage {
    #[default]
    Ready,
    Pending {
        shown: bool,
        consent_id: Option<String>,
    },
    Rejected,
    Used,
}

pub(super) struct Submission(Arc<Arm>);

impl State {
    /// Arms a menu click, unless arming is closed or `closing` (a committed quit, or the app
    /// shutting down) says it should be. Both are checked under the arms lock together with the
    /// insert, so `close`, which takes the same lock, either ends this click or makes it see the
    /// closure. `closing` runs under the arms lock: it must only read atomic flags.
    pub(super) fn arm_unless(
        &self,
        plugin: &str,
        command: &str,
        now: Instant,
        closing: impl FnOnce() -> bool,
    ) -> Result<Option<Arc<Arm>>, String> {
        let nonce =
            temp_files::nonce().map_err(|_| "Could not secure the app handoff menu click.")?;
        let arm = Arc::new(Arm::new(command, nonce, now));
        let mut arms = wait_lock(&self.arms).unwrap();
        if self.closed.load(Ordering::Relaxed) || closing() {
            return Ok(None);
        }
        if let Some(previous) = arms.insert(plugin.into(), arm.clone()) {
            previous.invalidate();
        }
        Ok(Some(arm))
    }

    #[cfg(test)]
    pub(super) fn arm(
        &self,
        plugin: &str,
        command: &str,
        now: Instant,
    ) -> Result<Arc<Arm>, String> {
        self.arm_unless(plugin, command, now, || false)?
            .ok_or_else(|| NO_ARMING.into())
    }

    fn matches(arm: &Arm, invocation: &MenuInvocation) -> bool {
        arm.command == invocation.command_id && arm.nonce == invocation.nonce
    }

    pub(super) fn begin(&self, invocation: &MenuInvocation, now: Instant) -> Result<(), String> {
        let arms = self.arms.lock().unwrap();
        let arm = arms
            .get(&invocation.plugin_id)
            .filter(|arm| Self::matches(arm, invocation) && now < arm.expires)
            .ok_or(NO_ARMING)?;
        arm.claimed.set(()).map_err(|_| NO_ARMING.into())
    }

    pub(super) fn finish(&self, invocation: &MenuInvocation) {
        let mut arms = self.arms.lock().unwrap();
        if arms
            .get(&invocation.plugin_id)
            .is_some_and(|arm| Self::matches(arm, invocation))
        {
            arms.remove(&invocation.plugin_id).unwrap().invalidate();
        }
    }

    /// The rebuild a completed build's result box offers. Only the Rust result handler can start
    /// it, and only while `original`, the click that ran the build, is still the plugin's live,
    /// used click: checked under the arms lock, so a reload, close or new click either ends the
    /// original first (and the rebuild is refused) or ends the rebuild's own click after it.
    /// The rebuild's click takes the original's place, so the same events end it. Its nonce is
    /// never sent anywhere, so no IPC call can claim or finish it; `release` removes it.
    pub(super) fn arm_rebuild(
        &self,
        plugin: &str,
        command: &str,
        now: Instant,
        original: &Submission,
    ) -> Result<Submission, String> {
        let nonce =
            temp_files::nonce().map_err(|_| "Could not secure the app handoff menu click.")?;
        let mut arms = self.arms.lock().unwrap();
        // `close` drains the original under this lock too; `closed` is checked as well so the
        // rule does not rest on that alone.
        if self.closed.load(Ordering::Relaxed)
            || !arms
                .get(plugin)
                .is_some_and(|arm| Arc::ptr_eq(arm, &original.0))
        {
            return Err(NO_ARMING.into());
        }
        original.assert_used()?;
        let arm = Arc::new(Arm::new(command, nonce, now));
        let submission = arm.submit(now)?;
        if let Some(previous) = arms.insert(plugin.into(), arm) {
            previous.invalidate();
        }
        Ok(submission)
    }

    /// Ends a host-started click once its work is over, unless something already replaced it.
    pub(super) fn release(&self, plugin: &str, submission: &Submission) {
        let mut arms = self.arms.lock().unwrap();
        if arms
            .get(plugin)
            .is_some_and(|arm| Arc::ptr_eq(arm, &submission.0))
        {
            arms.remove(plugin).unwrap().invalidate();
        }
    }

    pub(super) fn for_call(
        &self,
        invocation: &MenuInvocation,
        now: Instant,
        writing: bool,
    ) -> Result<Arc<Arm>, String> {
        let arm = self
            .arms
            .lock()
            .unwrap()
            .get(&invocation.plugin_id)
            .filter(|arm| Self::matches(arm, invocation) && arm.claimed.get().is_some())
            .cloned()
            .ok_or(NO_ARMING)?;
        if !writing {
            let stage = arm.stage.lock().unwrap();
            if now >= arm.expires
                || *arm.invalidated.borrow()
                || !matches!(*stage, Stage::Ready | Stage::Pending { .. })
            {
                return Err(NO_ARMING.into());
            }
        }
        Ok(arm)
    }

    #[cfg(test)]
    pub(super) fn live(&self, plugin: &str, now: Instant) -> Result<Arc<Arm>, String> {
        let arm = self
            .arms
            .lock()
            .unwrap()
            .get(plugin)
            .cloned()
            .ok_or(NO_ARMING)?;
        self.for_call(&arm.invocation(plugin), now, false)
    }

    pub(super) fn disarm(&self, plugin: &str) {
        if let Some(arm) = self.arms.lock().unwrap().remove(plugin) {
            arm.invalidate();
        }
    }

    /// Ends the click whose consent box for `id` is pending. A first launch holds the stage lock
    /// through the gate, so this waits for one already inside the gate; that launch spends the
    /// click, and from then on the consent store refuses every later launch.
    pub(super) fn disarm_consent(&self, plugin: &str, id: &str) {
        let mut arms = self.arms.lock().unwrap();
        let matches = arms.get(plugin).is_some_and(|arm| {
            let stage = wait_lock(&arm.stage).unwrap();
            if matches!(&*stage, Stage::Pending { consent_id: Some(current), .. } if current == id)
            {
                arm.invalidate();
                true
            } else {
                false
            }
        });
        if matches {
            arms.remove(plugin);
        }
    }

    /// Ends every click (the document window closed or reloaded). Later clicks arm again.
    pub(super) fn discard_all(&self) {
        for (_, arm) in wait_lock(&self.arms).unwrap().drain() {
            arm.invalidate();
        }
    }

    /// Ends every click and closes arming for good (a committed quit, or the exit's shutdown).
    /// Waits for a click being armed (`arm_unless`) to be inserted, then ends it with the rest.
    pub(super) fn close(&self) {
        let mut arms = wait_lock(&self.arms).unwrap();
        self.closed.store(true, Ordering::Relaxed);
        for (_, arm) in arms.drain() {
            arm.invalidate();
        }
    }
}

impl Arm {
    pub(super) fn invocation(&self, plugin: &str) -> MenuInvocation {
        MenuInvocation {
            plugin_id: plugin.into(),
            command_id: self.command.clone(),
            nonce: self.nonce.clone(),
        }
    }

    fn new(command: &str, nonce: String, now: Instant) -> Self {
        Self {
            command: command.into(),
            nonce,
            claimed: OnceLock::new(),
            expires: now + Duration::from_secs(60),
            stage: Mutex::default(),
            build: OnceLock::new(),
            invalidated: watch::channel(false).0,
            gate: Mutex::new(()),
        }
    }

    /// Ends the click. Waits for a launch already inside the gate to start its process or open;
    /// no launch of this click starts after this returns.
    fn invalidate(&self) {
        let _gate = wait_lock(&self.gate).unwrap_or_else(PoisonError::into_inner);
        self.invalidated.send_replace(true);
    }

    /// The launch boundary: runs `launch`, which only starts a process or an open, if and only if
    /// the click has not been invalidated, ordered against `invalidate` by the gate.
    fn while_live<T>(&self, launch: impl FnOnce() -> T) -> Option<T> {
        let _gate = wait_lock(&self.gate).unwrap_or_else(PoisonError::into_inner);
        (!*self.invalidated.borrow()).then(launch)
    }

    pub(super) fn submit(self: &Arc<Self>, now: Instant) -> Result<Submission, String> {
        let mut state = self.stage.lock().unwrap();
        match *state {
            Stage::Ready if now < self.expires && !*self.invalidated.borrow() => {
                *state = Stage::Pending {
                    shown: false,
                    consent_id: None,
                };
                Ok(Submission(self.clone()))
            }
            Stage::Ready => Err(NO_ARMING.into()),
            Stage::Pending { .. } if !*self.invalidated.borrow() => {
                *state = Stage::Rejected;
                self.invalidate();
                Err(RACE.into())
            }
            Stage::Pending { .. } => Err(NO_ARMING.into()),
            Stage::Used => Err("This menu click has already sent an app handoff.".into()),
            Stage::Rejected => Err(RACE.into()),
        }
    }
}

impl Submission {
    pub(super) fn bind_consent(&self, id: String) -> Result<(), String> {
        let mut stage = self.0.stage.lock().unwrap();
        match &mut *stage {
            Stage::Pending { consent_id, .. }
                if consent_id.is_none() && !*self.0.invalidated.borrow() =>
            {
                *consent_id = Some(id);
                Ok(())
            }
            Stage::Rejected => Err(RACE.into()),
            _ => Err(NO_ARMING.into()),
        }
    }

    pub(super) fn assert_pending(&self) -> Result<(), String> {
        let stage = self.0.stage.lock().unwrap();
        if matches!(*stage, Stage::Rejected) {
            return Err(RACE.into());
        }
        if *self.0.invalidated.borrow() || !matches!(*stage, Stage::Pending { .. }) {
            return Err(NO_ARMING.into());
        }
        Ok(())
    }

    pub(super) fn show_box(&self) -> Result<(), String> {
        let mut stage = self.0.stage.lock().unwrap();
        match &mut *stage {
            Stage::Pending { shown, .. }
                if !*self.0.invalidated.borrow() && (*shown || Instant::now() < self.0.expires) =>
            {
                *shown = true;
                Ok(())
            }
            Stage::Rejected => Err(RACE.into()),
            _ => Err(NO_ARMING.into()),
        }
    }

    pub(super) async fn open_box<T>(
        &self,
        open: impl std::future::Future<Output = Result<T, String>>,
        close: impl FnOnce(T),
    ) -> Result<T, String> {
        self.assert_pending()?;
        let opened = open.await?;
        if let Err(error) = self.show_box() {
            close(opened);
            return Err(error);
        }
        Ok(opened)
    }

    pub(super) fn bind_build(&self, build: &ApprovedBuild) -> Result<(), String> {
        self.assert_pending()?;
        self.0
            .build
            .set(BuildChoice::from(build))
            .map_err(|_| "The native app handoff build choice is already bound.".into())
    }

    pub(super) fn launch_build<T>(
        &self,
        build: &ApprovedBuild,
        launch: impl FnOnce() -> T,
    ) -> Result<T, String> {
        if self.0.build.get() != Some(&BuildChoice::from(build)) {
            return Err("The companion launch differs from the native build choice.".into());
        }
        self.launch(launch)
    }

    /// Every process launch of an approved build goes through its click, checked in the click's
    /// launch gate together with the launch. The first launch uses the click's one allowance
    /// (`launch_build`); every later one (each later step, each later attempt, and opening the
    /// output) needs the same click to be still live (`relaunch_build`).
    pub(super) fn launch_step<T>(
        &self,
        build: &ApprovedBuild,
        first: bool,
        launch: impl FnOnce() -> T,
    ) -> Result<T, String> {
        if first {
            self.launch_build(build, launch)
        } else {
            self.relaunch_build(build, launch)
        }
    }

    /// A launch after the first: a later step, a later attempt, or opening the output. The first
    /// launch used this click, so the click must still be the live, used one for the same native
    /// build choice. A reload or close of the document window, the plugin's menu command armed
    /// again, or the plugin's consent cleared invalidates it.
    pub(super) fn relaunch_build<T>(
        &self,
        build: &ApprovedBuild,
        launch: impl FnOnce() -> T,
    ) -> Result<T, String> {
        if self.0.build.get() != Some(&BuildChoice::from(build)) {
            return Err("The companion launch differs from the native build choice.".into());
        }
        // `Used` is final, so only liveness can change between this check and the launch, and
        // the gate orders that.
        self.assert_used()?;
        self.0.while_live(launch).ok_or_else(|| NO_ARMING.into())
    }

    /// Between attempts: the click has launched and nothing has invalidated it since.
    pub(super) fn assert_used(&self) -> Result<(), String> {
        self.assert_used_locked(&self.0.stage.lock().unwrap())
    }

    fn assert_used_locked(&self, stage: &Stage) -> Result<(), String> {
        match stage {
            Stage::Used if !*self.0.invalidated.borrow() => Ok(()),
            Stage::Rejected => Err(RACE.into()),
            _ => Err(NO_ARMING.into()),
        }
    }

    // Recheck under the same lock as submit. A duplicate that arrives before this launch
    // boundary rejects both requests. A duplicate after this boundary has no remaining allowance.
    // Liveness is checked in the gate, with the launch.
    pub(super) fn launch<T>(&self, launch: impl FnOnce() -> T) -> Result<T, String> {
        let mut stage = self.0.stage.lock().unwrap();
        match *stage {
            Stage::Pending { shown, .. } if shown || Instant::now() < self.0.expires => {
                let output = self.0.while_live(launch).ok_or(NO_ARMING)?;
                *stage = Stage::Used;
                Ok(output)
            }
            Stage::Rejected => Err(RACE.into()),
            _ => Err(NO_ARMING.into()),
        }
    }

    pub(super) fn invalidated(&self) -> watch::Receiver<bool> {
        self.0.invalidated.subscribe()
    }
}

impl Drop for Submission {
    fn drop(&mut self) {
        let mut stage = self.0.stage.lock().unwrap();
        if let Stage::Pending { shown, .. } = *stage {
            *stage = if shown { Stage::Used } else { Stage::Ready };
        }
    }
}

#[derive(Clone, Debug)]
pub(super) struct ApprovedBuild {
    pub app_id: String,
    pub pipeline: String,
    pub combination: String,
    pub input: Option<Input>,
    pub open_output: bool,
    pub warnings: Vec<String>,
    /// API 0.1.29: the inputs after `input`, in attempt order, and the declared retry condition.
    pub retry: Option<ApprovedRetry>,
}

#[derive(Clone, Debug)]
pub(super) struct ApprovedRetry {
    pub inputs: Vec<Input>,
    pub when: RetryCondition,
}

impl ApprovedBuild {
    pub(super) fn variants(&self) -> usize {
        1 + self.retry.as_ref().map_or(0, |retry| retry.inputs.len())
    }

    pub(super) fn variant(&self, index: usize) -> Option<&Input> {
        match index {
            0 => self.input.as_ref(),
            _ => self.retry.as_ref()?.inputs.get(index - 1),
        }
    }

    /// The single build a later rebuild repeats: the input finally used, with no further retry.
    pub(super) fn settle(&mut self, variant: usize) {
        if let Some(mut retry) = self.retry.take() {
            if variant > 0 && variant <= retry.inputs.len() {
                self.input = Some(retry.inputs.swap_remove(variant - 1));
            }
        }
    }
}

#[derive(PartialEq, Eq)]
struct BuildChoice {
    app_id: String,
    pipeline: String,
    combination: String,
}

impl From<&ApprovedBuild> for BuildChoice {
    fn from(build: &ApprovedBuild) -> Self {
        Self {
            app_id: build.app_id.clone(),
            pipeline: build.pipeline.clone(),
            combination: build.combination.clone(),
        }
    }
}

pub(super) struct ResultSession<T> {
    pub build: ApprovedBuild,
    pub template_digest: String,
    pub handoff_graph_digest: Option<String>,
    pub consent: T,
    pub rebuild_as: String,
    pub expires: Instant,
}

impl<T> ResultSession<T> {
    pub(super) fn take_rebuild(self, now: Instant) -> Result<ApprovedBuild, String> {
        if now >= self.expires {
            return Err(
                "The app handoff result expired. Start the build again from the menu.".into(),
            );
        }
        Ok(ApprovedBuild {
            combination: self.rebuild_as,
            ..self.build
        })
    }
}

/// Takes `lock`; a test learns (`lock_wait::on_wait`) when the calling thread has to wait for it.
pub(super) fn wait_lock<T>(lock: &Mutex<T>) -> LockResult<MutexGuard<'_, T>> {
    match lock.try_lock() {
        Ok(guard) => Ok(guard),
        Err(TryLockError::Poisoned(poisoned)) => Err(poisoned),
        Err(TryLockError::WouldBlock) => {
            #[cfg(test)]
            lock_wait::waiting();
            lock.lock()
        }
    }
}

/// Lets a race test see that a thread waits at a lock without sleeping to find out.
#[cfg(test)]
pub(super) mod lock_wait {
    use std::cell::RefCell;

    thread_local! {
        static HOOK: RefCell<Option<Box<dyn Fn()>>> = const { RefCell::new(None) };
    }

    /// Calls `hook` each time this thread has to wait in `wait_lock`.
    pub(in crate::app_handoff) fn on_wait(hook: impl Fn() + 'static) {
        HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    pub(super) fn waiting() {
        HOOK.with(|slot| {
            if let Some(hook) = &*slot.borrow() {
                hook();
            }
        });
    }
}
