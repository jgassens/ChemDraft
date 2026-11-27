use super::{
    arming::{self, ApprovedBuild, ApprovedRetry, MenuInvocation, ResultSession, Submission},
    catalog::{self, Plugin},
    command_line::{Pipeline, Platform},
    consent::{self, Entry, ListedConsent, Row, Store},
    dialogs::{self, Action},
    identity::{App, Error as IdentityError, Opening},
    picker, retry, runner,
    temp_files::{self, TempFiles},
    wire::{
        self, ChooseResult, ChosenApp, Request, RunCode, RunRequest, RunResult, SendCode,
        SendRequest, SendResult, Sequence, StatusResult,
    },
};
use serde::Serialize;
use serde_json::Value;
use std::{
    cell::Cell,
    collections::HashMap,
    ffi::OsString,
    io,
    path::{Path, PathBuf},
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
pub(super) const REBUILD_EXPIRED: &str =
    "The handoff app, pipeline, or consent changed. Start the build again from the menu.";
/// A launch after the first, or the output's open, found the click no longer live.
const STOPPED: &str =
    "ChemDraft stopped the companion build because the menu command that started it ended or was replaced, or its document window closed or reloaded.";
const RETRY_TIMEOUT: &str = "The companion attempts reached their 1200-second total time limit.";

#[derive(Default)]
pub(crate) struct State {
    pub(super) arms: arming::State,
    results: Mutex<HashMap<String, PendingResult>>,
    pub(super) stopped: AtomicBool,
}

struct PendingResult {
    consent_id: String,
    session: Option<ResultSession<Row>>,
    replaced: Arc<watch::Sender<bool>>,
}

impl State {
    /// The document window reloaded, or the user closed it (on macOS closing only hides it). No
    /// menu click from it stays live, so running companion work launches no further step or
    /// attempt and opens nothing, and no rebuild offer survives. Unlike `shutdown`, a companion
    /// step already running is left to finish within its time limit, and later clicks arm again.
    pub(crate) fn discard_menu_invocations(&self) {
        self.arms.shutdown();
        for (_, result) in self.results.lock().unwrap().drain() {
            result.replaced.send_replace(true);
        }
    }

    pub(crate) fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        self.discard_menu_invocations();
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

    pub(super) fn begin_result(&self, row: &Row) -> Arc<watch::Sender<bool>> {
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
    // A committed quit ended every click already (`QuitHost::end_handoff_clicks`); none arms
    // again while the document flushes.
    if state.stopped.load(Ordering::Acquire) || crate::quit_committed() {
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
        // The open started inside the click's launch boundary; its receipt is read out here.
        match launched.and_then(Opening::accepted) {
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
        // API 0.1.29: every alternative input passes `retry::variants` before any box.
        let retry = match (&request.retry, &request.input) {
            (None, _) => None,
            (Some(retry), Some(input))
                if pipeline.steps.iter().any(|step| step.id == retry.when.step) =>
            {
                match retry::variants(input, retry) {
                    Ok(mut inputs) => {
                        inputs.remove(0);
                        Some(ApprovedRetry {
                            inputs,
                            when: retry.when.clone(),
                        })
                    }
                    Err(message) => return Ok(run_failed(RunCode::BadParam, message)),
                }
            }
            (Some(_), _) => {
                return Ok(run_failed(
                    RunCode::BadParam,
                    "A companion retry needs an input and a step declared by the pipeline.",
                ))
            }
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
            retry
                .as_ref()
                .map(|retry| dialogs::RetryNotice::new(1 + retry.inputs.len(), &retry.when)),
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
                None,
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
            retry,
        };
        proof.bind_build(&build)?;
        let graph = composition.map(|composition| composition.graph_digest);
        self.run_and_offer_rebuild(proof, pipeline, target, grant, build, graph)
            .await
    }

    async fn question(
        &self,
        snapshot: Value,
        cancelled: watch::Receiver<bool>,
        click_ended: Option<watch::Receiver<bool>>,
        limit: Duration,
        submission: Option<&Submission>,
    ) -> Result<Action, String> {
        if *cancelled.borrow() || click_ended.as_ref().is_some_and(|ended| *ended.borrow()) {
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
            () = either_changed(cancelled, click_ended) => Action::Cancel {},
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
        let (returned, proof, result) = tauri::async_runtime::spawn_blocking(move || {
            let result = job.run(&window, &proof);
            (job, proof, result)
        })
        .await
        .map_err(|_| "The native companion supervisor stopped unexpectedly.")?;
        job = returned;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                state.take_result(self.plugin_id, &marker);
                return error.into_result();
            }
        };
        let RunResult::Done {
            steps, sequence, ..
        } = &result
        else {
            state.take_result(self.plugin_id, &marker);
            return Ok(result);
        };
        // A rebuild repeats only the input that produced this result, once.
        if let Some(sequence) = sequence {
            job.build.settle(sequence.variant);
        }
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
        // The offer ends with the click that ran the build (reload, close, or a new click).
        let action = match wire::encode(snapshot) {
            Ok(snapshot) => {
                self.question(
                    snapshot,
                    marker.subscribe(),
                    Some(proof.invalidated()),
                    ttl,
                    None,
                )
                .await
            }
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
        // The click that ran this build must still be live, checked atomically with arming the
        // rebuild; the rebuild's own click then ends on the same events.
        let new_proof = state
            .arms
            .arm_rebuild(self.plugin_id, self.command, Instant::now(), &proof)
            .map_err(|_| REBUILD_EXPIRED)?;
        drop(proof);
        if let Err(error) = new_proof.bind_build(&job.build) {
            state.arms.release(self.plugin_id, &new_proof);
            return Err(error);
        }
        // Continue entirely in Rust using the held input and the declared rebuild combination.
        self.run_rebuild(job, new_proof).await
    }

    async fn run_rebuild(&self, job: BuildJob, proof: Submission) -> Result<RunResult, String> {
        let window = self.window.clone();
        let (proof, result) = tauri::async_runtime::spawn_blocking(move || {
            let result = job.run(&window, &proof);
            (proof, result)
        })
        .await
        .map_err(|_| "The native companion supervisor stopped unexpectedly.")?;
        self.app()
            .state::<State>()
            .arms
            .release(self.plugin_id, &proof);
        result.or_else(JobError::into_result)
    }
}

/// What an approved build needs from ChemDraft: its cache folder, the quit flag, the launch-time
/// checks, and the two kinds of process launch. The document window provides it in the app; the
/// tests provide a stand-in that runs the stub companion.
pub(super) trait BuildHost {
    fn cache(&self) -> Result<PathBuf, String>;
    fn stopped(&self) -> &AtomicBool;
    /// Calls `launch` with the freshly verified app only while consent, the plugin install, the
    /// menu command and the app and companion identity all still allow `job`.
    fn authorized<T>(
        &self,
        job: &BuildJob,
        launch: impl FnOnce(&App) -> T,
    ) -> Result<T, runner::Failure>;
    fn spawn(
        &self,
        current: &App,
        args: &[OsString],
        cwd: &Path,
        deadline: Instant,
    ) -> Result<runner::ChildProcess, runner::Failure>;
    /// Starts opening `file`; `BuildJob::run` reads the receipt after the launch boundary.
    fn open(&self, current: &App, platform: Platform, file: &Path) -> io::Result<Opening>;
}

impl BuildHost for WebviewWindow {
    fn cache(&self) -> Result<PathBuf, String> {
        cache(self.app_handle())
    }

    fn stopped(&self) -> &AtomicBool {
        &self.app_handle().state::<State>().inner().stopped
    }

    fn authorized<T>(
        &self,
        job: &BuildJob,
        launch: impl FnOnce(&App) -> T,
    ) -> Result<T, runner::Failure> {
        let app = self.app_handle();
        let refused = || runner::Failure::new(RunCode::BadParam, REBUILD_EXPIRED);
        store(app)
            .map_err(|_| refused())?
            .with_grant(&job.grant, |row| {
                let plugin = Plugin::read(app, &job.grant.plugin_id).map_err(|_| refused())?;
                let pipeline = plugin
                    .pipeline(&job.build.pipeline)
                    .map_err(|_| refused())?;
                if !plugin.owns_menu_command(&job.command)
                    || !current_command(app, &job.command)
                    || self.stopped().load(Ordering::Acquire)
                    || !row.grants(
                        &job.target,
                        Some(&pipeline.id),
                        &pipeline.digest(),
                        &plugin.handoff_install_id,
                    )
                {
                    return Err(refused());
                }
                job.target
                    .with_verified_launch(job.platform, Some(&job.pipeline), launch)
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

    fn spawn(
        &self,
        current: &App,
        args: &[OsString],
        cwd: &Path,
        deadline: Instant,
    ) -> Result<runner::ChildProcess, runner::Failure> {
        let tool = current.tool().ok_or_else(|| {
            runner::Failure::new(
                RunCode::ToolMissing,
                "The declared companion executable is missing.",
            )
        })?;
        runner::ChildProcess::spawn_before(tool, args, cwd, deadline, self.stopped())
    }

    fn open(&self, current: &App, platform: Platform, file: &Path) -> io::Result<Opening> {
        current.open(platform, file)
    }
}

pub(super) struct BuildJob {
    pub(super) pipeline: Pipeline,
    pub(super) target: App,
    pub(super) grant: Row,
    pub(super) build: ApprovedBuild,
    pub(super) platform: Platform,
    pub(super) command: String,
}

pub(super) enum JobError {
    Refused(String),
    Failed(runner::Failure, Option<Sequence>),
}

impl JobError {
    fn failed(failure: runner::Failure) -> Self {
        Self::Failed(failure, None)
    }

    fn within(self, sequence: Option<Sequence>) -> Self {
        match self {
            Self::Failed(failure, _) => Self::Failed(failure, sequence),
            refused => refused,
        }
    }

    pub(super) fn into_result(self) -> Result<RunResult, String> {
        match self {
            Self::Refused(message) => Err(message),
            Self::Failed(failure, sequence) => Ok(failure_result(failure, sequence)),
        }
    }
}

/// One complete pipeline run whose output has not been opened. Dropping it removes its files.
struct Attempt {
    files: TempFiles,
    completed: runner::Completed,
}

impl BuildJob {
    /// Run the approved build. With a declared retry, run the next input only after a completed
    /// attempt meets the plugin's condition, revalidating everything a single run checks before
    /// each attempt and at every launch. Only the final attempt can be opened or returned.
    pub(super) fn run(
        &self,
        host: &impl BuildHost,
        proof: &Submission,
    ) -> Result<RunResult, JobError> {
        let cache = host.cache().map_err(JobError::Refused)?;
        let retry = self.build.retry.as_ref();
        let deadline = Instant::now() + retry::SEQUENCE_LIMIT;
        let (attempts, outcome) = retry::run_sequence(
            self.build.variants(),
            |index| {
                let launched = Cell::new(false);
                let outcome = if index > 0 {
                    self.before_retry(host, proof, deadline)
                } else {
                    Ok(())
                }
                .and_then(|()| self.attempt(host, proof, &cache, index, deadline, &launched));
                (launched.get(), outcome)
            },
            |attempt: &Attempt| {
                retry.is_some_and(|retry| retry::wants_retry(&attempt.completed.steps, &retry.when))
            },
        );
        let sequence = retry.map(|_| Sequence::after(attempts));
        let Attempt {
            mut files,
            completed,
        } = outcome.map_err(|error| error.within(sequence))?;
        let mut opened = false;
        if self.build.open_output {
            if let Some(output) = completed.output {
                // Opening is a launch too: it needs the same live click, in the click's launch
                // boundary. Only starting the open is inside it; the receipt is read after.
                let opening = host
                    .authorized(self, |current| {
                        let verified = runner::verified_output(&files.root, &output);
                        proof.relaunch_build(&self.build, || {
                            verified.then(|| host.open(current, self.platform, &output))
                        })
                    })
                    .map_err(|failure| JobError::Failed(failure, sequence))?
                    .map_err(|_| JobError::Failed(stopped(), sequence))?;
                opened = opening.is_some_and(|opening| opening.and_then(Opening::accepted).is_ok());
                if opened {
                    files.keep_for_open_app();
                }
            }
        }
        Ok(RunResult::Done {
            steps: completed.steps,
            opened,
            sequence,
        })
    }

    fn before_retry(
        &self,
        host: &impl BuildHost,
        proof: &Submission,
        deadline: Instant,
    ) -> Result<(), JobError> {
        if Instant::now() >= deadline {
            return Err(JobError::failed(runner::Failure::new(
                RunCode::Timeout,
                RETRY_TIMEOUT,
            )));
        }
        // Consent, plugin, command, shutdown and identity first, for their specific reasons.
        host.authorized(self, |_| ()).map_err(JobError::failed)?;
        proof.assert_used().map_err(|_| JobError::failed(stopped()))
    }

    fn attempt(
        &self,
        host: &impl BuildHost,
        proof: &Submission,
        cache: &Path,
        index: usize,
        deadline: Instant,
        launched: &Cell<bool>,
    ) -> Result<Attempt, JobError> {
        let failed = |code, message| JobError::failed(runner::Failure::new(code, message));
        let files = TempFiles::new(cache, &self.grant.plugin_id).map_err(|_| {
            failed(
                RunCode::WriteFailed,
                "ChemDraft could not create the companion handoff folder.",
            )
        })?;
        if let Some(input) = self.build.variant(index) {
            files
                .write(&files.stem, input.extension, &input.text)
                .map_err(|_| {
                    failed(
                        RunCode::WriteFailed,
                        "ChemDraft could not write the companion input file.",
                    )
                })?;
        }
        let mut refused = None;
        let run = runner::run(
            &self.pipeline,
            &self.build,
            &files,
            |args, cwd, first, step_deadline| {
                host.authorized(self, |current| {
                    let start = || host.spawn(current, args, cwd, step_deadline);
                    // Only the first step of the first attempt uses the click's allowance. Every
                    // later step and attempt needs the same click to be still live.
                    let first_launch = index == 0 && first;
                    match proof.launch_step(&self.build, first_launch, start) {
                        Ok(result) => {
                            // The attempt has started once a process of it has.
                            launched.set(launched.get() || result.is_ok());
                            result
                        }
                        Err(_) if !first_launch => Err(stopped()),
                        Err(error) => {
                            refused = Some(error);
                            Err(runner::Failure::new(
                                RunCode::BadParam,
                                "The native companion launch was refused.",
                            ))
                        }
                    }
                })?
            },
            host.stopped(),
            deadline,
        );
        if let Some(error) = refused {
            return Err(JobError::Refused(error));
        }
        Ok(Attempt {
            files,
            completed: run.map_err(JobError::failed)?,
        })
    }
}

fn stopped() -> runner::Failure {
    runner::Failure::new(RunCode::BadParam, STOPPED)
}

/// Resolves when either receiver changes or loses its sender.
async fn either_changed(mut first: watch::Receiver<bool>, second: Option<watch::Receiver<bool>>) {
    match second {
        None => {
            let _ = first.changed().await;
        }
        Some(mut second) => tokio::select! {
            _ = first.changed() => {},
            _ = second.changed() => {},
        },
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
        sequence: None,
    }
}
fn failure_result(failure: runner::Failure, sequence: Option<Sequence>) -> RunResult {
    RunResult::Failed {
        code: failure.code,
        message: failure.message,
        diagnostic: failure.diagnostic.map(|diagnostic| *diagnostic),
        sequence,
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
