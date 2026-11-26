use super::{
    temp_files,
    wire::{Input, RetryCondition},
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tokio::sync::watch;

pub(super) const RACE: &str = "App handoff refused because two requests claimed one menu click.";
const NO_ARMING: &str = "Start app handoff from the plugin's native menu.";

#[derive(Default)]
pub(crate) struct State {
    arms: Mutex<HashMap<String, Arc<Arm>>>,
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
    pub(super) fn arm(
        &self,
        plugin: &str,
        command: &str,
        now: Instant,
    ) -> Result<Arc<Arm>, String> {
        let nonce =
            temp_files::nonce().map_err(|_| "Could not secure the app handoff menu click.")?;
        let arm = Arc::new(Arm::new(command, nonce, now));
        let mut arms = self.arms.lock().unwrap();
        if let Some(previous) = arms.insert(plugin.into(), arm.clone()) {
            previous.invalidate();
        }
        Ok(arm)
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

    /// Only the Rust result handler can start this invocation. It is never visible to IPC.
    pub(super) fn arm_host_event(
        &self,
        plugin: &str,
        command: &str,
        now: Instant,
    ) -> Result<Submission, String> {
        self.disarm(plugin);
        Arc::new(Arm::new(command, String::new(), now)).submit(now)
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

    pub(super) fn disarm_consent(&self, plugin: &str, id: &str) {
        let mut arms = self.arms.lock().unwrap();
        let matches = arms.get(plugin).is_some_and(|arm| {
            let stage = arm.stage.lock().unwrap();
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

    pub(crate) fn shutdown(&self) {
        for (_, arm) in self.arms.lock().unwrap().drain() {
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
        }
    }

    fn invalidate(&self) {
        self.invalidated.send_replace(true);
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

    /// A later attempt of the approved retry sequence. The first attempt used this click, so the
    /// click must still be the live, used one for the same native build choice.
    pub(super) fn relaunch_build<T>(
        &self,
        build: &ApprovedBuild,
        launch: impl FnOnce() -> T,
    ) -> Result<T, String> {
        if self.0.build.get() != Some(&BuildChoice::from(build)) {
            return Err("The companion launch differs from the native build choice.".into());
        }
        let stage = self.0.stage.lock().unwrap();
        self.assert_used_locked(&stage)?;
        Ok(launch())
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
    pub(super) fn launch<T>(&self, launch: impl FnOnce() -> T) -> Result<T, String> {
        let mut stage = self.0.stage.lock().unwrap();
        match *stage {
            Stage::Pending { shown, .. }
                if !*self.0.invalidated.borrow() && (shown || Instant::now() < self.0.expires) =>
            {
                let output = launch();
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
