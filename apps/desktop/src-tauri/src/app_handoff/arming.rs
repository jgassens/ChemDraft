use super::wire::Input;
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

pub(super) struct Arm {
    pub command: String,
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
    },
    Rejected,
    Used,
}

pub(super) struct Submission(Arc<Arm>);

impl State {
    pub(super) fn arm(&self, plugin: &str, command: &str, now: Instant) -> Arc<Arm> {
        let arm = Arc::new(Arm::new(command, now));
        let mut arms = self.arms.lock().unwrap();
        if let Some(previous) = arms.insert(plugin.into(), arm.clone()) {
            previous.invalidate();
        }
        arm
    }

    /// Only the Rust result handler can start this invocation. It is never visible to IPC.
    pub(super) fn arm_host_event(
        &self,
        plugin: &str,
        command: &str,
        now: Instant,
    ) -> Result<Submission, String> {
        self.disarm(plugin);
        Arc::new(Arm::new(command, now)).submit(now)
    }

    pub(super) fn for_call(
        &self,
        plugin: &str,
        now: Instant,
        writing: bool,
    ) -> Result<Arc<Arm>, String> {
        let arm = self
            .arms
            .lock()
            .unwrap()
            .get(plugin)
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
        self.for_call(plugin, now, false)
    }

    pub(super) fn disarm(&self, plugin: &str) {
        if let Some(arm) = self.arms.lock().unwrap().remove(plugin) {
            arm.invalidate();
        }
    }

    pub(crate) fn shutdown(&self) {
        for (_, arm) in self.arms.lock().unwrap().drain() {
            arm.invalidate();
        }
    }
}

impl Arm {
    fn new(command: &str, now: Instant) -> Self {
        Self {
            command: command.into(),
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
                *state = Stage::Pending { shown: false };
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
        match *stage {
            Stage::Pending { shown }
                if !*self.0.invalidated.borrow() && (shown || Instant::now() < self.0.expires) =>
            {
                *stage = Stage::Pending { shown: true };
                Ok(())
            }
            Stage::Rejected => Err(RACE.into()),
            _ => Err(NO_ARMING.into()),
        }
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

    // Recheck under the same lock as submit. A duplicate that arrives before this launch
    // boundary rejects both requests. A duplicate after this boundary has no remaining allowance.
    pub(super) fn launch<T>(&self, launch: impl FnOnce() -> T) -> Result<T, String> {
        let mut stage = self.0.stage.lock().unwrap();
        match *stage {
            Stage::Pending { shown }
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
        if let Stage::Pending { shown } = *stage {
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
