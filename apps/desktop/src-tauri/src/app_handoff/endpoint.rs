use super::{
    arming::{self, ApprovedBuild, MenuInvocation, ResultSession, Submission},
    catalog::{self, Plugin},
    command_line::{Pipeline, Platform},
    consent::{self, Entry, ListedConsent, Row, Store},
    dialogs::{self, Action},
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
    consent_id: String,
    session: Option<ResultSession<Row>>,
    replaced: Arc<watch::Sender<bool>>,
}

impl State {
    pub(crate) fn discard_menu_invocations(&self) {
        self.arms.shutdown();
    }

    pub(crate) fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.arms.shutdown();
        for (_, result) in self.results.lock().unwrap().drain() {
            result.replaced.send_replace(true);
        }
    }

    fn clear_result(&self, plugin_id: &str, consent_id: Option<&str>) {
        let mut results = self.results.lock().unwrap();
        if results
            .get(plugin_id)
            .is_some_and(|result| consent_id.is_none_or(|id| result.consent_id == id))
        {
            results
                .remove(plugin_id)
                .unwrap()
                .replaced
                .send_replace(true);
        }
    }

    fn begin_result(&self, row: &Row) -> Arc<watch::Sender<bool>> {
        let marker = Arc::new(watch::channel(false).0);
        let previous = self.results.lock().unwrap().insert(
            row.plugin_id.clone(),
            PendingResult {
                consent_id: row.consent_id(),
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

pub(crate) fn arm_native_menu(
    app: &AppHandle,
    command: &str,
) -> Result<Option<MenuInvocation>, String> {
    if !command.starts_with("plugin.")
        || !current_command(app, command)
        || crate::panel_window::palette_blocks_menu(true, command)
        || app.get_webview_window(crate::MAIN_WINDOW_LABEL).is_none()
    {
        return Ok(None);
    }
    let state = app.state::<State>();
    if state.stopped.load(Ordering::Acquire) {
        return Ok(None);
    }
    for (id, _) in catalog::OFFICIAL_COMPANION_PLUGINS {
        if Plugin::read(app, id).is_ok_and(|plugin| plugin.owns_menu_command(command)) {
            let arm = state.arms.arm(id, command, Instant::now())?;
            return Ok(Some(arm.invocation(id)));
        }
    }
    Ok(None)
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

fn io_error(error: std::io::Error) -> String {
    if consent::is_conflict(&error) {
        error.to_string()
    } else {
        "ChemDraft could not read or save the app handoff consent store.".into()
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum InvocationPhase {
    Begin,
    Finish,
}

#[tauri::command]
pub(crate) fn app_handoff_menu_invocation(
    window: WebviewWindow,
    invocation: MenuInvocation,
    phase: InvocationPhase,
) -> Result<(), String> {
    main_only(&window)?;
    let state = window.state::<State>();
    match phase {
        InvocationPhase::Begin => state.arms.begin(&invocation, Instant::now()),
        InvocationPhase::Finish => {
            state.arms.finish(&invocation);
            Ok(())
        }
    }
}

pub(super) struct AuthorizedCall {
    plugin_id: String,
    arm: Arc<arming::Arm>,
    pub(super) request: Request,
    pub(super) submission: Option<Submission>,
}

// This is the IPC gate for all four methods, including the non-consuming picker and status calls.
pub(super) fn authorize_call(
    arms: &arming::State,
    payload: Value,
    now: Instant,
) -> Result<AuthorizedCall, String> {
    let (invocation, request) = wire::Call::parse(payload)?;
    let writing = matches!(request, Request::Send(_) | Request::Run(_));
    let arm = arms.for_call(&invocation, now, writing)?;
    let submission = if writing {
        Some(arm.submit(now)?)
    } else {
        None
    };
    Ok(AuthorizedCall {
        plugin_id: invocation.plugin_id,
        arm,
        request,
        submission,
    })
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
    let platform = Platform::current()?;
    let app = window.app_handle();
    let state = app.state::<State>();
    let AuthorizedCall {
        plugin_id,
        arm: armed,
        request,
        submission,
    } = authorize_call(&state.arms, payload.clone(), Instant::now())?;
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
        let armed =
            state
                .arms
                .for_call(&self.arm.invocation(self.plugin_id), Instant::now(), false)?;
        if !Arc::ptr_eq(self.arm, &armed) {
            return Err("The app picker no longer belongs to the active menu click.".into());
        }
        let chosen = App::read(self.platform, &path, None).map_err(|error| error.message())?;
        let shown = chosen.name.clone();
        let id = self
            .store
            .pick(self.plugin_id, chosen, |row| {
                let pipeline = self.plugin.pipeline(row.pipeline.as_deref()?).ok()?;
                if pipeline.digest() != row.template_digest {
                    return None;
                }
                let current = App::read(self.platform, &row.app_path, Some(&pipeline)).ok()?;
                if current.path != row.app_path || !row.app_identity.main_matches(&current.identity)
                {
                    return None;
                }
                current.identity.companion
            })
            .map_err(io_error)?;
        Ok(ChooseResult::Chosen {
            app: ChosenApp {
                app_id: id,
                display_name: shown,
            },
        })
    }

    fn status(&self, id: &str) -> Result<StatusResult, String> {
        let rows = self.store.for_app(self.plugin_id, id).map_err(io_error)?;
        Ok(target_status(self.platform, &rows, |id| {
            self.plugin.pipeline(id).ok()
        }))
    }

    async fn consent(
        &self,
        proof: &Submission,
        entry: Entry,
        target: &App,
        pipeline: Option<&Pipeline>,
    ) -> Result<Option<Row>, String> {
        let digest = pipeline.map_or_else(send_template_digest, Pipeline::digest);
        let install_id = &self.plugin.handoff_install_id;
        let operation_id = pipeline.map(|pipeline| pipeline.id.as_str());
        if entry.row.pipeline.as_deref() != operation_id {
            return Err("The app handoff consent operation changed.".into());
        }
        proof.bind_consent(entry.row.consent_id())?;
        if entry.row.grants(target, operation_id, &digest, install_id) {
            return Ok(Some(entry.row));
        }
        let operation = match pipeline {
            Some(pipeline) => format!("Start the chosen app's companion tool and give it the handoff file each time you run the command.\n\nPipeline \"{}\"\n{}",
                pipeline.id, pipeline.describe(self.platform)?),
            None => "Give this app a temporary file and open it each time you run the command. A 3D handoff omits page layout, drawing labels, colors, and annotations. It can make implicit hydrogens explicit and place an isolated model in a vacuum box.".into(),
        };
        let developer_note = self.plugin.consent_note();
        let text = format!(
            "{} ({}) requests permission to hand off data to {}.\n\n{}\n\n{}{developer_note}",
            dialogs::plugin_display_name(&self.plugin.manifest.name),
            self.plugin_id,
            target.name,
            target.path.display(),
            operation,
        );
        if !dialogs::native_choice(self.window, proof, "Allow app handoff?", text, "Allow").await? {
            return Ok(None);
        }
        if Plugin::read(self.app(), self.plugin_id)?.handoff_install_id != *install_id {
            return Err("The app handoff plugin was reinstalled while consent was open.".into());
        }
        // A concurrent revoke or uninstall takes precedence over an in-flight confirmation.
        self.store
            .replace(&entry, target, digest, install_id)
            .map(Some)
            .map_err(io_error)
    }

    async fn send(&self, proof: Submission, request: SendRequest) -> Result<SendResult, String> {
        let Some(entry) = self
            .store
            .get(self.plugin_id, &request.app_id, None)
            .map_err(io_error)?
        else {
            return Ok(send_identity(IdentityError::Missing));
        };
        let target = match load_target(self.platform, &entry.row, None) {
            Ok(app) => app,
            Err(error) => {
                dialogs::explain_location(
                    self.window,
                    "App handoff failed",
                    error.message(),
                    &entry.row.app_path,
                );
                return Ok(send_identity(error));
            }
        };
        let app = self.app();
        let state = app.state::<State>();
        state.clear_result(self.plugin_id, None);
        let Some(grant) = self.consent(&proof, entry, &target, None).await? else {
            return Ok(SendResult::Declined);
        };
        if let Some(warnings) = request.warnings.filter(|warnings| !warnings.is_empty()) {
            let warning =
                dialogs::send_warning_message(&target.name, &self.plugin.manifest.name, &warnings);
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
        if !self.still_authorized(&grant, None, &target)? {
            return Err(
                "App handoff consent or the native menu command changed before launch.".into(),
            );
        }
        let launched = self
            .store
            .with_grant(&grant, |_| {
                target.with_verified_launch(self.platform, None, |current| {
                    proof.launch(|| current.open(self.platform, &file))
                })
            })
            .map_err(io_error)?
            .ok_or("App handoff consent changed before launch.")?;
        let launched = match launched {
            Ok(launched) => launched?,
            Err(error) => return Ok(send_identity(error)),
        };
        match launched {
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
            && grant.grants(
                target,
                pipeline.map(|p| p.id.as_str()),
                &digest,
                &plugin.handoff_install_id,
            )
            && self
                .store
                .with_grant(grant, |_| ())
                .map_err(io_error)?
                .is_some())
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
        let Some(entry) = self
            .store
            .get(self.plugin_id, &request.app_id, Some(&pipeline.id))
            .map_err(io_error)?
        else {
            return Ok(run_identity(IdentityError::Missing));
        };
        let target = match load_target(self.platform, &entry.row, Some(&pipeline)) {
            Ok(app) => app,
            Err(error) => {
                dialogs::explain_location(
                    self.window,
                    "Companion build failed",
                    error.message(),
                    &entry.row.app_path,
                );
                return Ok(run_identity(error));
            }
        };
        let state = self.app().state::<State>();
        state.clear_result(self.plugin_id, None);
        let warnings = dialogs::display_warnings(request.warnings.as_deref().unwrap_or_default());
        let plugin_name = dialogs::plugin_display_name(&self.plugin.manifest.name);
        let Ok(snapshot) = dialogs::confirmation_snapshot(
            &pipeline,
            &target.name,
            &plugin_name,
            &request.combination,
            composition.as_ref(),
            &warnings,
        ) else {
            return Ok(run_failed(
                RunCode::BadParam,
                "The companion build choices and warnings exceed the native dialog limit.",
            ));
        };
        let Some(grant) = self
            .consent(&proof, entry, &target, Some(&pipeline))
            .await?
        else {
            return Ok(RunResult::Declined);
        };
        let Action::Confirm { combination_id } = self
            .question(
                snapshot,
                proof.invalidated(),
                Duration::from_secs(600),
                Some(&proof),
            )
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
            warnings,
        };
        proof.bind_build(&build)?;
        let graph = composition.map(|composition| composition.graph_digest);
        self.run_and_offer_rebuild(proof, pipeline, target, grant, build, graph)
            .await
    }

    async fn question(
        &self,
        snapshot: Value,
        mut cancelled: watch::Receiver<bool>,
        limit: Duration,
        submission: Option<&Submission>,
    ) -> Result<Action, String> {
        if *cancelled.borrow() {
            return Ok(Action::Cancel {});
        }
        let open = async {
            crate::dialog_windows::open_app_handoff(self.window.clone(), snapshot)
                .await
                .map_err(|_| "ChemDraft could not open the native handoff dialog.".to_string())
        };
        let (host_id, mut choice) = match submission {
            Some(proof) => {
                proof
                    .open_box(open, |(host_id, _)| {
                        crate::dialog_windows::close_app_handoff(self.app(), &host_id);
                    })
                    .await?
            }
            None => open.await?,
        };
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
        let marker = state.begin_result(&grant);
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
        let plugin_name = dialogs::plugin_display_name(&self.plugin.manifest.name);
        let snapshot = dialogs::result_snapshot(
            &job.pipeline,
            &app_name,
            &plugin_name,
            &job.build.combination,
            rebuild,
            twist,
            &job.build.warnings,
        );
        let action = match wire::encode(snapshot) {
            Ok(snapshot) => self.question(snapshot, marker.subscribe(), ttl, None).await,
            Err(error) => Err(error),
        };
        let session = state.take_result(self.plugin_id, &marker);
        if !dialogs::rebuild_requested(action) {
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
            || !self.still_authorized(&job.grant, Some(&job.pipeline), &rechecked)?
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
            |args, cwd, first, deadline| {
                self.with_authorized_launch(window, |current| {
                    let tool = current.tool().ok_or_else(|| {
                        runner::Failure::new(
                            RunCode::ToolMissing,
                            "The declared companion executable is missing.",
                        )
                    })?;
                    let start = || {
                        runner::ChildProcess::spawn_before(
                            tool,
                            args,
                            cwd,
                            deadline,
                            &state.stopped,
                        )
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
                })?
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
                opened = self
                    .with_authorized_launch(window, |current| {
                        runner::verified_output(&files.root, &output)
                            && current.open(self.platform, &output).is_ok()
                    })
                    .map_err(JobError::Failed)?;
                if opened {
                    files.keep_for_open_app();
                }
            }
        }
        Ok(RunResult::Done {
            steps: completed.steps,
            opened,
        })
    }

    fn with_authorized_launch<T>(
        &self,
        window: &WebviewWindow,
        launch: impl FnOnce(&App) -> T,
    ) -> Result<T, runner::Failure> {
        let app = window.app_handle();
        let refused = || runner::Failure::new(RunCode::BadParam, REBUILD_EXPIRED);
        store(app)
            .map_err(|_| refused())?
            .with_grant(&self.grant, |row| {
                let plugin = Plugin::read(app, &self.grant.plugin_id).map_err(|_| refused())?;
                let pipeline = plugin
                    .pipeline(&self.build.pipeline)
                    .map_err(|_| refused())?;
                if !plugin.owns_menu_command(&self.command)
                    || !current_command(app, &self.command)
                    || app.state::<State>().stopped.load(Ordering::Acquire)
                    || !row.grants(
                        &self.target,
                        Some(&pipeline.id),
                        &pipeline.digest(),
                        &plugin.handoff_install_id,
                    )
                {
                    return Err(refused());
                }
                self.target
                    .with_verified_launch(self.platform, Some(&self.pipeline), launch)
                    .map_err(|error| {
                        runner::Failure::new(run_identity_code(error), error.message())
                    })
            })
            .map_err(|error| {
                if consent::is_conflict(&error) {
                    runner::Failure::new(RunCode::BadParam, error.to_string())
                } else {
                    refused()
                }
            })?
            .ok_or_else(refused)?
    }
}

pub(super) fn target_status(
    platform: Platform,
    rows: &[Row],
    mut resolve_pipeline: impl FnMut(&str) -> Option<Pipeline>,
) -> StatusResult {
    let unavailable = |error: IdentityError| StatusResult {
        available: false,
        display_name: None,
        reason: Some(error.message().into()),
    };
    let Some(first) = rows.first() else {
        return unavailable(IdentityError::Missing);
    };
    let app = match load_target(platform, first, None) {
        Ok(app) => app,
        Err(error) => return unavailable(error),
    };
    let mut pipeline_changed = false;
    let mut error = None;
    for row in rows.iter().filter(|row| !row.template_digest.is_empty()) {
        let Some(id) = row.pipeline.as_deref() else {
            continue;
        };
        let pipeline = resolve_pipeline(id);
        pipeline_changed |= row.granted
            && pipeline
                .as_ref()
                .is_none_or(|p| p.digest() != row.template_digest);
        if let Some(Err(problem)) = pipeline
            .as_ref()
            .map(|p| load_target(platform, row, Some(p)))
        {
            error = Some(problem);
        }
    }
    StatusResult {
        available: true,
        display_name: Some(app.name),
        reason: if pipeline_changed {
            Some("The companion pipeline changed and needs consent again.".into())
        } else {
            error.map(|error| error.message().into())
        },
    }
}

pub(super) fn load_target(
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
        || pipeline.is_some_and(|p| {
            row.pipeline.as_deref() == Some(&p.id) && !row.accepts_companion(&target, &p.digest())
        })
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
    consent_id: String,
    app_name: String,
    app_path: PathBuf,
    pipeline: Option<String>,
    status: ConsentStatus,
    at: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
enum ConsentStatus {
    Allowed,
    Inactive,
    Revoked,
    Conflict,
}

impl ConsentSummary {
    pub(super) fn new(row: Row, install_id: Option<&str>) -> Self {
        let status = if !row.granted {
            ConsentStatus::Revoked
        } else if install_id.is_some_and(|id| row.belongs_to_install(id)) {
            ConsentStatus::Allowed
        } else {
            ConsentStatus::Inactive
        };
        Self::from_row(row, status)
    }

    pub(super) fn conflict(row: Row) -> Self {
        Self::from_row(row, ConsentStatus::Conflict)
    }

    fn from_row(row: Row, status: ConsentStatus) -> Self {
        let (consent_id, pipeline) = if matches!(status, ConsentStatus::Conflict) {
            (row.conflict_id(), None)
        } else {
            (row.consent_id(), row.pipeline)
        };
        Self {
            consent_id,
            plugin_id: row.plugin_id,
            app_name: row
                .app_path
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned(),
            app_path: row.app_path,
            pipeline,
            status,
            at: row.at,
        }
    }
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
    let app = window.app_handle();
    let mut installs = HashMap::new();
    Ok(store(app)?
        .list()
        .map_err(io_error)?
        .into_iter()
        .map(|entry| match entry {
            ListedConsent::Operation(row) => {
                let install = installs.entry(row.plugin_id.clone()).or_insert_with(|| {
                    Plugin::read(app, &row.plugin_id)
                        .ok()
                        .map(|plugin| plugin.handoff_install_id)
                });
                ConsentSummary::new(row, install.as_deref())
            }
            ListedConsent::Conflict(row) => ConsentSummary::conflict(row),
        })
        .collect())
}

#[tauri::command]
pub(crate) fn app_handoff_consent_revoke(
    window: WebviewWindow,
    plugin_id: String,
    consent_id: String,
) -> Result<Vec<String>, String> {
    main_only(&window)?;
    let app = window.app_handle();
    let operation_ids = store(app)?
        .revoke(&plugin_id, &consent_id)
        .map_err(io_error)?;
    let state = app.state::<State>();
    for id in &operation_ids {
        state.arms.disarm_consent(&plugin_id, id);
        state.clear_result(&plugin_id, Some(id));
    }
    // The manager drops the listed rows these IDs name if its refresh fails.
    Ok(operation_ids)
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
    state.clear_result(&plugin_id, None);
    Ok(())
}
