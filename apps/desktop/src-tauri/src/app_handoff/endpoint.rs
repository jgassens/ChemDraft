use super::{
    arming::{self, ApprovedBuild, ResultSession, Submission},
    catalog::{self, Plugin},
    command_line::{Pipeline, Platform},
    consent::{Row, Store},
    dialogs::{self, Action, Snapshot},
    identity::{App, Error as IdentityError},
    picker, runner,
    temp_files::{self, TempFiles},
    wire::{
        self, ChooseResult, ChosenApp, Request, RunCode, RunRequest, RunResult, SendCode,
        SendRequest, SendResult, StatusResult,
    },
};
use serde::Serialize;
use serde_json::Value;
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime},
};
use tauri::{
    ipc::{InvokeBody, Request as IpcRequest},
    AppHandle, Manager, WebviewWindow,
};
use tokio::sync::watch;

fn send_template_digest() -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(br#"{"operation":"openSelectedAppWithTemporaryFile"}"#)
    )
}
const REBUILD_EXPIRED: &str =
    "The handoff app, pipeline, or consent changed. Start the build again from the menu.";

#[derive(Default)]
pub(crate) struct State {
    arms: arming::State,
    results: Mutex<HashMap<String, PendingResult>>,
    stopped: AtomicBool,
}

struct PendingResult {
    session: Option<ResultSession<Row>>,
    replaced: Arc<watch::Sender<bool>>,
}

impl State {
    pub(crate) fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.arms.shutdown();
        for (_, result) in self.results.lock().unwrap().drain() {
            result.replaced.send_replace(true);
        }
    }

    fn clear_result(&self, plugin_id: &str) {
        if let Some(result) = self.results.lock().unwrap().remove(plugin_id) {
            result.replaced.send_replace(true);
        }
    }

    fn begin_result(&self, plugin_id: &str) -> Arc<watch::Sender<bool>> {
        let marker = Arc::new(watch::channel(false).0);
        let previous = self.results.lock().unwrap().insert(
            plugin_id.into(),
            PendingResult {
                session: None,
                replaced: marker.clone(),
            },
        );
        if let Some(previous) = previous {
            previous.replaced.send_replace(true);
        }
        marker
    }

    fn retain_result(
        &self,
        plugin_id: &str,
        marker: &Arc<watch::Sender<bool>>,
        session: ResultSession<Row>,
    ) -> bool {
        let mut results = self.results.lock().unwrap();
        let Some(pending) = results
            .get_mut(plugin_id)
            .filter(|pending| Arc::ptr_eq(&pending.replaced, marker))
        else {
            return false;
        };
        pending.session = Some(session);
        true
    }

    fn take_result(
        &self,
        plugin_id: &str,
        marker: &Arc<watch::Sender<bool>>,
    ) -> Option<ResultSession<Row>> {
        let mut results = self.results.lock().unwrap();
        if !results
            .get(plugin_id)
            .is_some_and(|result| Arc::ptr_eq(&result.replaced, marker))
        {
            return None;
        }
        results.remove(plugin_id).and_then(|result| result.session)
    }
}

pub(crate) fn cleanup(app: &AppHandle) {
    if let Ok(cache) = app.path().app_cache_dir() {
        drop(tauri::async_runtime::spawn_blocking(move || {
            temp_files::clean(&cache, SystemTime::now())
        }));
    }
}

fn current_command(app: &AppHandle, command: &str) -> bool {
    crate::current_plugin_menu_items(app)
        .iter()
        .any(|item| item.id == command && item.enabled)
}

pub(crate) fn arm_native_menu(app: &AppHandle, command: &str) -> bool {
    if !command.starts_with("plugin.")
        || !current_command(app, command)
        || crate::panel_window::palette_blocks_menu(true, command)
        || app.get_webview_window(crate::MAIN_WINDOW_LABEL).is_none()
    {
        return false;
    }
    let state = app.state::<State>();
    if state.stopped.load(Ordering::Acquire) {
        return false;
    }
    for (id, _) in catalog::OFFICIAL_COMPANION_PLUGINS {
        if Plugin::read(app, id).is_ok_and(|plugin| plugin.owns_menu_command(command)) {
            state.arms.arm(id, command, Instant::now());
            return true;
        }
    }
    false
}

fn store(app: &AppHandle) -> Result<Store, String> {
    app.path()
        .app_local_data_dir()
        .map(|path| Store::new(&path))
        .map_err(|_| "ChemDraft's app handoff consent folder is unavailable.".into())
}

fn cache(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_cache_dir()
        .map_err(|_| "ChemDraft's app handoff cache folder is unavailable.".into())
}

fn io_error(_: std::io::Error) -> String {
    "ChemDraft could not read or save the app handoff consent store.".into()
}

#[tauri::command]
pub(crate) async fn app_handoff_call(
    window: WebviewWindow,
    ipc: IpcRequest<'_>,
) -> Result<Value, String> {
    main_only(&window)?;
    let InvokeBody::Json(payload) = ipc.body() else {
        return Err("App handoff requires a JSON request.".into());
    };
    let (plugin_id, request) = wire::Call::parse(payload.clone())?;
    let platform = Platform::current()?;
    let app = window.app_handle();
    let state = app.state::<State>();
    let writing = matches!(request, Request::Send(_) | Request::Run(_));
    let armed = state.arms.for_call(&plugin_id, Instant::now(), writing)?;
    let submission = if writing {
        Some(armed.submit(Instant::now())?)
    } else {
        None
    };
    let plugin = Plugin::read(app, &plugin_id)?;
    if !plugin.owns_menu_command(&armed.command) || !current_command(app, &armed.command) {
        return Err("The armed app handoff menu command is no longer available.".into());
    }
    let context = Context {
        window: &window,
        platform,
        plugin_id: &plugin_id,
        command: &armed.command,
        arm: &armed,
        plugin,
        store: store(app)?,
    };
    match request {
        Request::Choose(request) => wire::encode(context.choose(request.purpose).await?),
        Request::Status(request) => wire::encode(context.status(&request.app_id)?),
        Request::Send(request) => wire::encode(
            context
                .send(submission.expect("side-effecting request"), request)
                .await?,
        ),
        Request::Run(request) => wire::encode(
            context
                .confirm_and_run(submission.expect("side-effecting request"), request)
                .await?,
        ),
    }
}

struct Context<'a> {
    window: &'a WebviewWindow,
    platform: Platform,
    plugin_id: &'a str,
    command: &'a str,
    arm: &'a Arc<arming::Arm>,
    plugin: Plugin,
    store: Store,
}

impl Context<'_> {
    fn app(&self) -> &AppHandle {
        self.window.app_handle()
    }

    async fn choose(&self, purpose: String) -> Result<ChooseResult, String> {
        let Some(path) = picker::pick(self.window, self.platform, purpose).await? else {
            return Ok(ChooseResult::Cancelled);
        };
        // The picker doesn't consume a gesture. A late picker response must not survive its gesture.
        let state = self.app().state::<State>();
        let armed = state.arms.for_call(self.plugin_id, Instant::now(), false)?;
        if !Arc::ptr_eq(self.arm, &armed) {
            return Err("The app picker no longer belongs to the active menu click.".into());
        }
        let chosen = App::read(self.platform, &path, None).map_err(|error| error.message())?;
        let shown = chosen.name.clone();
        let existing = self
            .store
            .list()
            .map_err(io_error)?
            .into_iter()
            .find(|row| {
                row.plugin_id == self.plugin_id
                    && row.app_path == chosen.path
                    && row.app_identity.main_matches(&chosen.identity)
                    && row.pipeline.as_deref().is_none_or(|id| {
                        self.plugin.pipeline(id).ok().is_some_and(|pipeline| {
                            App::read(self.platform, &chosen.path, Some(&pipeline))
                                .is_ok_and(|app| row.app_identity.matches(&app.identity))
                        })
                    })
            });
        let id = if let Some(row) = existing {
            row.app_id
        } else {
            let id = temp_files::nonce().map_err(|_| "Could not assign the chosen app an ID.")?;
            self.store
                .insert(Row::picked(self.plugin_id, id.clone(), chosen))
                .map_err(io_error)?;
            id
        };
        Ok(ChooseResult::Chosen {
            app: ChosenApp {
                app_id: id,
                display_name: shown,
            },
        })
    }

    fn status(&self, id: &str) -> Result<StatusResult, String> {
        let mut result = StatusResult {
            available: false,
            display_name: None,
            reason: None,
        };
        let Some(row) = self.store.get(self.plugin_id, id).map_err(io_error)? else {
            result.reason = Some(IdentityError::Missing.message().into());
            return Ok(result);
        };
        let pipeline = row
            .pipeline
            .as_deref()
            .and_then(|id| self.plugin.pipeline(id).ok());
        match load_target(self.platform, &row, pipeline.as_ref()) {
            Ok(app) => {
                result.available = true;
                result.display_name = Some(app.name);
                if row.granted
                    && row.pipeline.is_some()
                    && pipeline
                        .as_ref()
                        .is_none_or(|pipeline| row.template_digest != pipeline.digest())
                {
                    result.reason =
                        Some("The companion pipeline changed and needs consent again.".into());
                }
            }
            Err(error) => result.reason = Some(error.message().into()),
        }
        Ok(result)
    }

    async fn consent(
        &self,
        proof: &Submission,
        row: Row,
        target: &App,
        pipeline: Option<&Pipeline>,
    ) -> Result<Option<Row>, String> {
        let digest = pipeline.map_or_else(send_template_digest, Pipeline::digest);
        if row.grants(target, &digest) {
            return Ok(Some(row));
        }
        let operation = match pipeline {
            Some(pipeline) => format!("Start the chosen app's companion tool and give it the handoff file each time you run the command.\n\nPipeline \"{}\"\n{}",
                pipeline.id, pipeline.describe(self.platform)?),
            None => "Give this app a temporary file and open it each time you run the command. A 3D handoff omits page layout, drawing labels, colors, and annotations. It can make implicit hydrogens explicit and place an isolated model in a vacuum box.".into(),
        };
        let developer_note = self.plugin.consent_note();
        let text = format!(
            "{} ({}) requests permission to hand off data to {}.\n\n{}\n\n{}{developer_note}",
            self.plugin.manifest.name,
            self.plugin_id,
            target.name,
            target.path.display(),
            operation,
        );
        if !dialogs::native_choice(self.window, proof, "Allow app handoff?", text, "Allow").await? {
            return Ok(None);
        }
        let mut granted = row.clone();
        granted.approve(target, pipeline.map(|p| p.id.clone()), digest);
        // A concurrent revoke or uninstall takes precedence over an in-flight confirmation.
        self.store
            .replace(&row, granted.clone())
            .map_err(io_error)?;
        Ok(Some(granted))
    }

    async fn send(&self, proof: Submission, request: SendRequest) -> Result<SendResult, String> {
        let Some(row) = self
            .store
            .get(self.plugin_id, &request.app_id)
            .map_err(io_error)?
        else {
            return Ok(send_identity(IdentityError::Missing));
        };
        let target = match load_target(self.platform, &row, None) {
            Ok(app) => app,
            Err(error) => {
                dialogs::explain_location(
                    self.window,
                    "App handoff failed",
                    error.message(),
                    &row.app_path,
                );
                return Ok(send_identity(error));
            }
        };
        let app = self.app();
        let state = app.state::<State>();
        state.clear_result(self.plugin_id);
        let Some(grant) = self.consent(&proof, row, &target, None).await? else {
            return Ok(SendResult::Declined);
        };
        if let Some(warnings) = request.warnings.filter(|warnings| !warnings.is_empty()) {
            let warning = format!(
                "Send the file to {}?\n\n{}",
                target.name,
                warnings.join("\n")
            );
            if !dialogs::native_choice(
                self.window,
                &proof,
                "App handoff format warnings",
                warning,
                "Send",
            )
            .await?
            {
                return Ok(SendResult::Declined);
            }
        }
        let Ok(mut files) = TempFiles::new(&cache(app)?, self.plugin_id) else {
            return Ok(send_failed(
                SendCode::WriteFailed,
                "ChemDraft could not create the handoff folder.",
            ));
        };
        let Ok(file) = files.write(&request.file_name, request.extension, &request.text) else {
            return Ok(send_failed(
                SendCode::WriteFailed,
                "ChemDraft could not write the handoff file.",
            ));
        };
        let current = match target.verify(self.platform, None) {
            Ok(current) => current,
            Err(error) => return Ok(send_identity(error)),
        };
        if !self.still_authorized(&grant, None, &current)? {
            return Err(
                "App handoff consent or the native menu command changed before launch.".into(),
            );
        }
        match proof.launch(|| current.open(self.platform, &file))? {
            Ok(()) => {
                files.keep_for_open_app();
                Ok(SendResult::Sent)
            }
            Err(_) => Ok(send_failed(SendCode::LaunchFailed, "The chosen app could not open the handoff file. Check for an operating system security prompt.")),
        }
    }

    fn still_authorized(
        &self,
        grant: &Row,
        pipeline: Option<&Pipeline>,
        target: &App,
    ) -> Result<bool, String> {
        let plugin = Plugin::read(self.app(), self.plugin_id)?;
        let digest = pipeline.map_or_else(
            || Ok(send_template_digest()),
            |pipeline| plugin.pipeline(&pipeline.id).map(|p| p.digest()),
        )?;
        Ok(!self.app().state::<State>().stopped.load(Ordering::Acquire)
            && current_command(self.app(), self.command)
            && plugin.owns_menu_command(self.command)
            && grant.grants(target, &digest)
            && self
                .store
                .get(self.plugin_id, &grant.app_id)
                .map_err(io_error)?
                .is_some_and(|current| current.same_grant(grant)))
    }

    async fn confirm_and_run(
        &self,
        proof: Submission,
        request: RunRequest,
    ) -> Result<RunResult, String> {
        let pipeline = match self.plugin.pipeline(&request.pipeline) {
            Ok(pipeline) => pipeline,
            Err(message) => return Ok(run_failed(RunCode::BadParam, message)),
        };
        if !pipeline.combinations.contains_key(&request.combination)
            || pipeline.input_extension() != request.input.as_ref().map(|input| input.extension)
        {
            return Ok(run_failed(
                RunCode::BadParam,
                "The companion requires a declared combination and the declared input extension.",
            ));
        }
        let composition = match request.input.as_ref().map(dialogs::composition).transpose() {
            Ok(composition) => composition,
            Err(message) => return Ok(run_failed(RunCode::BadParam, message)),
        };
        let Some(row) = self
            .store
            .get(self.plugin_id, &request.app_id)
            .map_err(io_error)?
        else {
            return Ok(run_identity(IdentityError::Missing));
        };
        let target = match load_target(self.platform, &row, Some(&pipeline)) {
            Ok(app) => app,
            Err(error) => {
                dialogs::explain_location(
                    self.window,
                    "Companion build failed",
                    error.message(),
                    &row.app_path,
                );
                return Ok(run_identity(error));
            }
        };
        let state = self.app().state::<State>();
        state.clear_result(self.plugin_id);
        let Some(grant) = self.consent(&proof, row, &target, Some(&pipeline)).await? else {
            return Ok(RunResult::Declined);
        };
        proof.show_box()?;
        let snapshot = Snapshot::Confirm {
            title: "Confirm companion build",
            app_name: &target.name,
            pipeline: &pipeline.id,
            composition: composition.as_ref(),
            suggested_combination: &request.combination,
            combinations: &pipeline.combinations,
        };
        let Action::Confirm { combination_id } = self
            .question(snapshot, proof.invalidated(), Duration::from_secs(600))
            .await?
        else {
            proof.assert_pending()?;
            return Ok(RunResult::Declined);
        };
        proof.assert_pending()?;
        let build = ApprovedBuild {
            app_id: request.app_id,
            pipeline: request.pipeline,
            combination: combination_id,
            input: request.input,
            open_output: request.open_output.unwrap_or(false),
        };
        proof.bind_build(&build)?;
        let graph = composition.map(|composition| composition.graph_digest);
        self.run_and_offer_rebuild(proof, pipeline, target, grant, build, graph)
            .await
    }

    async fn question(
        &self,
        snapshot: Snapshot<'_>,
        mut cancelled: watch::Receiver<bool>,
        limit: Duration,
    ) -> Result<Action, String> {
        if *cancelled.borrow() {
            return Ok(Action::Cancel {});
        }
        let value = wire::encode(snapshot)?;
        let (host_id, mut choice) =
            crate::dialog_windows::open_app_handoff(self.window.clone(), value)
                .await
                .map_err(|_| "ChemDraft could not open the native handoff dialog.")?;
        let answer = tokio::select! {
            biased;
            _ = cancelled.changed() => Action::Cancel {},
            result = tokio::time::timeout(limit, &mut choice) => result.ok().and_then(Result::ok).unwrap_or(Action::Cancel {}),
        };
        crate::dialog_windows::close_app_handoff(self.app(), &host_id);
        Ok(answer)
    }

    async fn run_and_offer_rebuild(
        &self,
        proof: Submission,
        pipeline: Pipeline,
        target: App,
        grant: Row,
        build: ApprovedBuild,
        graph: Option<String>,
    ) -> Result<RunResult, String> {
        let state = self.app().state::<State>();
        let marker = state.begin_result(self.plugin_id);
        let command = self.command.to_owned();
        let app_name = target.name.clone();
        let mut job = BuildJob {
            pipeline,
            target,
            grant,
            build,
            platform: self.platform,
            command,
        };
        let window = self.window.clone();
        let (returned, result) = tauri::async_runtime::spawn_blocking(move || {
            let result = job.run(&window, &proof);
            (job, result)
        })
        .await
        .map_err(|_| "The native companion supervisor stopped unexpectedly.")?;
        job = returned;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                state.take_result(self.plugin_id, &marker);
                return match error {
                    JobError::Refused(message) => Err(message),
                    JobError::Failed(failure) => Ok(failure_result(failure)),
                };
            }
        };
        let RunResult::Done { steps, .. } = &result else {
            state.take_result(self.plugin_id, &marker);
            return Ok(result);
        };
        let twist = dialogs::twist(steps);
        let Some(rebuild) = job
            .pipeline
            .combinations
            .get(&job.build.combination)
            .and_then(|row| row.get("rebuildAs"))
            .filter(|_| twist != Some(0.0))
        else {
            state.take_result(self.plugin_id, &marker);
            return Ok(result);
        };
        let ttl = Duration::from_secs(600);
        let session = ResultSession {
            build: job.build.clone(),
            template_digest: job.pipeline.digest(),
            handoff_graph_digest: graph,
            consent: job.grant.clone(),
            rebuild_as: rebuild.clone(),
            expires: Instant::now() + ttl,
        };
        if !state.retain_result(self.plugin_id, &marker, session) {
            return Ok(result);
        }
        let snapshot = Snapshot::Result {
            title: "Companion build result",
            app_name: &app_name,
            combination: &job.build.combination,
            rebuild_combination: rebuild,
            rebuild_label: dialogs::rebuild_label(&job.pipeline, rebuild),
            twist,
        };
        let action = self.question(snapshot, marker.subscribe(), ttl).await;
        let session = state.take_result(self.plugin_id, &marker);
        if !matches!(action?, Action::Rebuild {}) {
            return Ok(result);
        }
        let session = session.ok_or(REBUILD_EXPIRED)?;
        let rechecked = job
            .target
            .verify(self.platform, Some(&job.pipeline))
            .map_err(|_| REBUILD_EXPIRED)?;
        let held_graph = session
            .build
            .input
            .as_ref()
            .map(dialogs::composition)
            .transpose()?
            .map(|composition| composition.graph_digest);
        if session.template_digest != job.pipeline.digest()
            || session.handoff_graph_digest != held_graph
            || !session.consent.same_grant(&job.grant)
            || !self
                .still_authorized(&job.grant, Some(&job.pipeline), &rechecked)
                .unwrap_or(false)
        {
            return Err(REBUILD_EXPIRED.into());
        }
        job.build = session.take_rebuild(Instant::now())?;
        job.target = rechecked;
        let new_proof = state
            .arms
            .arm_host_event(self.plugin_id, self.command, Instant::now())?;
        new_proof.bind_build(&job.build)?;
        // Continue entirely in Rust using the held input and the declared rebuild combination.
        self.run_rebuild(job, new_proof).await
    }

    async fn run_rebuild(&self, job: BuildJob, proof: Submission) -> Result<RunResult, String> {
        let window = self.window.clone();
        match tauri::async_runtime::spawn_blocking(move || job.run(&window, &proof))
            .await
            .map_err(|_| "The native companion supervisor stopped unexpectedly.")?
        {
            Ok(result) => Ok(result),
            Err(JobError::Refused(error)) => Err(error),
            Err(JobError::Failed(failure)) => Ok(failure_result(failure)),
        }
    }
}

struct BuildJob {
    pipeline: Pipeline,
    target: App,
    grant: Row,
    build: ApprovedBuild,
    platform: Platform,
    command: String,
}

enum JobError {
    Refused(String),
    Failed(runner::Failure),
}

impl BuildJob {
    fn run(&self, window: &WebviewWindow, proof: &Submission) -> Result<RunResult, JobError> {
        let app = window.app_handle();
        let failed = |code, message| JobError::Failed(runner::Failure::new(code, message));
        let cache = cache(app).map_err(JobError::Refused)?;
        let mut files = TempFiles::new(&cache, &self.grant.plugin_id).map_err(|_| {
            failed(
                RunCode::WriteFailed,
                "ChemDraft could not create the companion handoff folder.",
            )
        })?;
        if let Some(input) = &self.build.input {
            files
                .write(&files.stem, input.extension, &input.text)
                .map_err(|_| {
                    failed(
                        RunCode::WriteFailed,
                        "ChemDraft could not write the companion input file.",
                    )
                })?;
        }
        let state = app.state::<State>();
        let mut refused = None;
        let run = runner::run(
            &self.pipeline,
            &self.build,
            &files,
            |args, cwd, first| {
                let current = self.verify(window)?;
                let tool = current.tool().ok_or_else(|| {
                    runner::Failure::new(
                        RunCode::ToolMissing,
                        "The declared companion executable is missing.",
                    )
                })?;
                let start = || {
                    runner::ChildProcess::spawn(tool, args, cwd).map_err(|_| {
                        runner::Failure::new(
                            RunCode::ToolMissing,
                            "ChemDraft could not start the declared companion executable.",
                        )
                    })
                };
                if first {
                    match proof.launch_build(&self.build, start) {
                        Ok(result) => result,
                        Err(error) => {
                            refused = Some(error);
                            Err(runner::Failure::new(
                                RunCode::BadParam,
                                "The native companion launch was refused.",
                            ))
                        }
                    }
                } else {
                    start()
                }
            },
            &state.stopped,
        );
        if let Some(error) = refused {
            return Err(JobError::Refused(error));
        }
        let completed = run.map_err(JobError::Failed)?;
        let mut opened = false;
        if self.build.open_output {
            if let Some(output) = completed.output {
                let current = self.verify(window).map_err(JobError::Failed)?;
                if runner::verified_output(&files.root, &output) {
                    opened = current.open(self.platform, &output).is_ok();
                    if opened {
                        files.keep_for_open_app();
                    }
                }
            }
        }
        Ok(RunResult::Done {
            steps: completed.steps,
            opened,
        })
    }

    fn verify(&self, window: &WebviewWindow) -> Result<App, runner::Failure> {
        let current = self
            .target
            .verify(self.platform, Some(&self.pipeline))
            .map_err(|error| runner::Failure::new(run_identity_code(error), error.message()))?;
        let app = window.app_handle();
        let consent_current = || {
            let plugin = Plugin::read(app, &self.grant.plugin_id).ok()?;
            let pipeline = plugin.pipeline(&self.build.pipeline).ok()?;
            let row = store(app)
                .ok()?
                .get(&self.grant.plugin_id, &self.build.app_id)
                .ok()??;
            Some(
                plugin.owns_menu_command(&self.command)
                    && current_command(app, &self.command)
                    && !app.state::<State>().stopped.load(Ordering::Acquire)
                    && row.same_grant(&self.grant)
                    && row.grants(&current, &pipeline.digest()),
            )
        };
        if consent_current() == Some(true) {
            Ok(current)
        } else {
            Err(runner::Failure::new(RunCode::BadParam, REBUILD_EXPIRED))
        }
    }
}

fn load_target(
    platform: Platform,
    row: &Row,
    pipeline: Option<&Pipeline>,
) -> Result<App, IdentityError> {
    let target = App::read(platform, &row.app_path, pipeline).map_err(|error| {
        if error == IdentityError::ToolMissing
            && row.pipeline.as_deref() == pipeline.map(|p| p.id.as_str())
            && row.app_identity.companion.is_some()
        {
            IdentityError::Changed
        } else {
            error
        }
    })?;
    if row.app_path != target.path
        || !row.app_identity.main_matches(&target.identity)
        || (pipeline.is_some()
            && row.pipeline.as_deref() == pipeline.map(|p| p.id.as_str())
            && row.app_identity.companion.is_some()
            && !row.app_identity.matches(&target.identity)
            && pipeline.is_some_and(|p| p.digest() == row.template_digest))
    {
        return Err(IdentityError::Changed);
    }
    Ok(target)
}

fn send_identity(error: IdentityError) -> SendResult {
    send_failed(
        if error == IdentityError::Missing {
            SendCode::AppMissing
        } else {
            SendCode::AppChanged
        },
        error.message(),
    )
}
fn send_failed(code: SendCode, message: impl Into<String>) -> SendResult {
    SendResult::Failed {
        code,
        message: message.into(),
    }
}
fn run_identity_code(error: IdentityError) -> RunCode {
    match error {
        IdentityError::Missing => RunCode::AppMissing,
        IdentityError::Changed => RunCode::AppChanged,
        IdentityError::ToolMissing => RunCode::ToolMissing,
    }
}
fn run_identity(error: IdentityError) -> RunResult {
    run_failed(run_identity_code(error), error.message())
}
fn run_failed(code: RunCode, message: impl Into<String>) -> RunResult {
    RunResult::Failed {
        code,
        message: message.into(),
        diagnostic: None,
    }
}
fn failure_result(failure: runner::Failure) -> RunResult {
    RunResult::Failed {
        code: failure.code,
        message: failure.message,
        diagnostic: failure.diagnostic.map(|diagnostic| *diagnostic),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ConsentSummary {
    plugin_id: String,
    app_id: String,
    app_name: String,
    app_path: PathBuf,
    pipeline: Option<String>,
    granted: bool,
    at: String,
}

fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == crate::MAIN_WINDOW_LABEL {
        Ok(())
    } else {
        Err("App handoff is available only from the document window.".into())
    }
}

#[tauri::command]
pub(crate) fn app_handoff_consent_list(
    window: WebviewWindow,
) -> Result<Vec<ConsentSummary>, String> {
    main_only(&window)?;
    Ok(store(window.app_handle())?
        .list()
        .map_err(io_error)?
        .into_iter()
        .filter(|row| !row.template_digest.is_empty())
        .map(|row| ConsentSummary {
            plugin_id: row.plugin_id,
            app_id: row.app_id,
            app_name: row
                .app_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            app_path: row.app_path,
            pipeline: row.pipeline,
            granted: row.granted,
            at: row.at,
        })
        .collect())
}

#[tauri::command]
pub(crate) fn app_handoff_consent_revoke(
    window: WebviewWindow,
    plugin_id: String,
    app_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    let app = window.app_handle();
    store(app)?.revoke(&plugin_id, &app_id).map_err(io_error)?;
    let state = app.state::<State>();
    state.arms.disarm(&plugin_id);
    state.clear_result(&plugin_id);
    Ok(())
}

#[tauri::command]
pub(crate) fn app_handoff_consent_clear_plugin(
    window: WebviewWindow,
    plugin_id: String,
) -> Result<(), String> {
    main_only(&window)?;
    if !super::plugin_id_valid(&plugin_id) {
        return Err("Invalid app handoff plugin ID.".into());
    }
    let app = window.app_handle();
    store(app)?.clear(&plugin_id).map_err(io_error)?;
    let state = app.state::<State>();
    state.arms.disarm(&plugin_id);
    state.clear_result(&plugin_id);
    Ok(())
}
