//! Shared verified streaming downloads. Legacy engines retain reqwest's default redirects;
//! external tools opt into an explicit, one-hop HTTPS redirect allowlist.
use super::{
    file_ops::FileOps, pins, platform::RunningChild, EngineSpec, InstallError, InstallErrorCode,
};
use crate::network_error::{self, download_tls_policy, DownloadPlatform};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::Path,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

pub struct DownloadClient {
    client: reqwest::blocking::Client,
    request_gate: Mutex<()>,
    redirect_url: Arc<Mutex<Option<reqwest::Url>>>,
    file_ops: FileOps<'static>,
    pub(crate) running: Option<Arc<RunningChild>>,
}

impl DownloadClient {
    pub(crate) fn for_engine<S: EngineSpec>(mut self, running: Arc<RunningChild>) -> Self {
        self.file_ops = FileOps::new::<S>(None);
        self.running = Some(running);
        self
    }
    /// `Some(&[])` forbids all redirects. `None` preserves the engine installer policy.
    pub fn new(user_agent: &str, redirect_hosts: Option<&[&str]>) -> Result<Self, InstallError> {
        Self::from_builder(
            reqwest::blocking::Client::builder(),
            user_agent,
            redirect_hosts,
        )
    }

    pub(crate) fn from_builder(
        builder: reqwest::blocking::ClientBuilder,
        user_agent: &str,
        redirect_hosts: Option<&[&str]>,
    ) -> Result<Self, InstallError> {
        let policy = download_tls_policy(DownloadPlatform::current());
        let redirect_url = Arc::new(Mutex::new(None));
        let observed_url = Arc::clone(&redirect_url);
        let hosts =
            redirect_hosts.map(|hosts| hosts.iter().map(|s| s.to_string()).collect::<Vec<_>>());
        let client = builder
            .redirect(reqwest::redirect::Policy::custom(move |attempt| {
                if matches!(attempt.url().scheme(), "http" | "https") {
                    *observed_url.lock().unwrap() = Some(attempt.url().clone());
                }
                if let Some(hosts) = &hosts {
                    if attempt.previous().len() > 1
                        || attempt.url().scheme() != "https"
                        || !attempt.url().username().is_empty()
                        || attempt.url().password().is_some()
                        || !attempt
                            .url()
                            .host_str()
                            .is_some_and(|host| hosts.iter().any(|h| h == host))
                    {
                        return attempt.error("Download redirect is not allowed");
                    }
                    attempt.follow()
                } else {
                    reqwest::redirect::Policy::default().redirect(attempt)
                }
            }))
            .tls_built_in_webpki_certs(policy.webpki_roots)
            .tls_built_in_native_certs(policy.native_roots)
            .connect_timeout(Duration::from_secs(30))
            // Blocking reqwest applies this to each wait, including each body read, rather
            // than to the entire transfer. Large model downloads keep their stall timeout.
            .timeout(Duration::from_secs(60))
            .user_agent(user_agent)
            .build()
            .map_err(|error| {
                InstallError::network(network_error::download_error_message(&error))
            })?;
        Ok(Self {
            client,
            request_gate: Mutex::new(()),
            redirect_url,
            file_ops: FileOps::with_prefix("[chemdraft download]", None),
            running: None,
        })
    }
}

pub(crate) fn cancelled() -> InstallError {
    InstallError {
        code: InstallErrorCode::Cancelled,
        message: "Installation cancelled.".into(),
    }
}

pub(crate) fn check_cancel(cancel: &AtomicBool) -> Result<(), InstallError> {
    if cancel.load(Ordering::SeqCst) {
        Err(cancelled())
    } else {
        Ok(())
    }
}

pub fn download_verified(
    client: &DownloadClient,
    url: &str,
    expected_size: Option<u64>,
    expected_sha256: &str,
    dest: &Path,
    cancel: &AtomicBool,
    mut progress: impl FnMut(u64, Option<u64>),
) -> Result<(), InstallError> {
    check_cancel(cancel)?;
    // Serialize sends so redirected transport diagnostics cannot observe another request's URL.
    let guard = client.request_gate.lock().unwrap();
    *client.redirect_url.lock().unwrap() = None;
    let response = client.client.get(url).send().map_err(|mut error| {
        if !error.is_redirect() && error.url().is_none_or(|u| u.as_str() == url) {
            if let Some(destination) = client.redirect_url.lock().unwrap().take() {
                error = error.with_url(destination);
            }
        }
        let fallback = reqwest::Url::parse(url).ok();
        InstallError::network(network_error::log_failure(network_error::classify_error(
            &error,
            error
                .url()
                .and_then(|u| u.host_str())
                .or_else(|| fallback.as_ref().and_then(|u| u.host_str()))
                .unwrap_or("download server"),
        )))
    })?;
    *client.redirect_url.lock().unwrap() = None;
    drop(guard);
    let mut response = response
        .error_for_status()
        .map_err(|error| InstallError::network(network_error::download_error_message(&error)))?;
    if let (Some(expected), Some(reported)) = (expected_size, response.content_length()) {
        if expected != reported {
            return Err(InstallError::checksum(format!(
                "{} reported {reported} bytes; expected {expected}.",
                network_error::redact_url(url)
            )));
        }
    }
    let total = expected_size.or_else(|| response.content_length());
    let host = response
        .url()
        .host_str()
        .unwrap_or("download server")
        .to_owned();
    let ops = client
        .file_ops
        .with_cancel(cancel)
        .with_running(client.running.as_deref());
    let mut file = ops.create(dest).map_err(|error| ops.failed(error))?;
    let mut digest = Sha256::new();
    let mut done = 0u64;
    let mut reported = 0u64;
    let mut buffer = [0u8; 128 * 1024];
    loop {
        check_cancel(cancel)?;
        // Read at most the remaining pin plus one sentinel byte. Never write excess bytes.
        let limit = expected_size.map_or(buffer.len(), |size| {
            size.saturating_sub(done)
                .saturating_add(1)
                .min(buffer.len() as u64) as usize
        });
        let read = response.read(&mut buffer[..limit]).map_err(|error| {
            InstallError::network(network_error::log_failure(network_error::classify_error(
                &error, &host,
            )))
        })?;
        check_cancel(cancel)?;
        if read == 0 {
            break;
        }
        if expected_size.is_some_and(|size| done + read as u64 > size) {
            return Err(InstallError::checksum(format!(
                "{} sent more than the pinned {} bytes.",
                network_error::redact_url(url),
                expected_size.unwrap_or_default()
            )));
        }
        ops.write_all(&mut file, dest, &buffer[..read])
            .map_err(|error| ops.failed(error))?;
        digest.update(&buffer[..read]);
        done += read as u64;
        if done - reported >= 1024 * 1024 {
            reported = done;
            progress(done, total);
        }
    }
    progress(done, total);
    check_cancel(cancel)?;
    ops.sync(&file, dest).map_err(|error| ops.failed(error))?;
    let actual = format!("{:x}", digest.finalize());
    pins::verify_digest(done, &actual, expected_size, expected_sha256)
        .map(|_| ())
        .map_err(|detail| {
            InstallError::checksum(format!(
                "Verification failed for {}: {detail}.",
                network_error::redact_url(url)
            ))
        })
}
