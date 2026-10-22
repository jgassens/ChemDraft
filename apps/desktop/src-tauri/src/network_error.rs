//! Shared download trust policy and diagnostics. Never expose reqwest's signed request URLs.
use std::{error::Error, io};

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DownloadPlatform {
    MacOs,
    Windows,
    Other,
}

impl DownloadPlatform {
    pub fn current() -> Self {
        if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub struct DownloadTlsPolicy {
    pub webpki_roots: bool,
    pub native_roots: bool,
}

pub fn download_tls_policy(platform: DownloadPlatform) -> DownloadTlsPolicy {
    match platform {
        DownloadPlatform::MacOs | DownloadPlatform::Windows | DownloadPlatform::Other => {
            DownloadTlsPolicy {
                webpki_roots: true,
                native_roots: true,
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkCategory {
    Reachable,
    Dns,
    Refused,
    ResetClosed,
    Timeout,
    CertificateUntrusted,
    CertificateOther,
    Proxy,
    TlsOther,
    HttpStatus,
    Other,
}

#[derive(Debug)]
pub struct NetworkFailure {
    pub category: NetworkCategory,
    pub host: String,
    pub message: String,
    pub log_detail: String,
}

pub fn redact_url(url: &str) -> String {
    // Strip sensitive suffixes before parsing, including malformed queries/fragments.
    let url = url.split(['?', '#']).next().unwrap_or(url);
    match reqwest::Url::parse(url) {
        Ok(url) if matches!(url.scheme(), "http" | "https") => format!(
            "{}://{}{}",
            url.scheme(),
            url.host_str().unwrap_or("[host]"),
            url.path()
        ),
        _ => "[redacted URL]".into(),
    }
}

/// Redact URLs at every level of an error chain, including proxy credentials and signed redirects.
pub fn redact_urls(text: &str) -> String {
    let mut rest = text;
    let mut clean = String::new();
    while let Some(start) = rest
        .to_ascii_lowercase()
        .find("https://")
        .into_iter()
        .chain(rest.to_ascii_lowercase().find("http://"))
        .min()
    {
        clean.push_str(&rest[..start]);
        rest = &rest[start..];
        // Consume the whole non-whitespace token. Punctuation in a malformed URL or its query
        // must not separate a sensitive suffix from the URL we redact.
        let end = rest.find(char::is_whitespace).unwrap_or(rest.len());
        clean.push_str(&redact_url(&rest[..end]));
        rest = &rest[end..];
    }
    clean.push_str(rest);
    clean
}

pub fn classify_reqwest_error(error: &reqwest::Error) -> NetworkFailure {
    classify_error(
        error,
        error
            .url()
            .and_then(|url| url.host_str())
            .unwrap_or("download server"),
    )
}

/// Also handles blocking Response::read's io::Error wrapper, retaining its reqwest/TLS sources.
pub fn classify_error(error: &(dyn Error + 'static), host: &str) -> NetworkFailure {
    let mut chain = Vec::new();
    let mut next = Some(error);
    while let Some(cause) = next {
        chain.push(cause);
        if chain.len() == 64 {
            break;
        }
        next = if let Some(error) = cause.downcast_ref::<io::Error>() {
            error
                .get_ref()
                .map(|inner| inner as &(dyn Error + 'static))
                .or_else(|| cause.source())
        } else {
            cause.source()
        };
    }
    let detail = chain
        .iter()
        .map(|cause| cause.to_string())
        .collect::<Vec<_>>()
        .join(": ");
    let requests: Vec<_> = chain
        .iter()
        .filter_map(|cause| cause.downcast_ref::<reqwest::Error>())
        .collect();
    let tls = chain
        .iter()
        .find_map(|cause| cause.downcast_ref::<rustls::Error>());
    let kinds: Vec<_> = chain
        .iter()
        .filter_map(|cause| cause.downcast_ref::<io::Error>().map(io::Error::kind))
        .collect();
    let category = if requests.iter().any(|e| e.status() == Some(reqwest::StatusCode::PROXY_AUTHENTICATION_REQUIRED))
        // hyper-util's private tunnel/SOCKS errors and reqwest's SOCKS wrapper expose Display
        // prefixes. Recheck hyper-util's strings when updating the version guard in the tests.
        || chain.iter().any(|e| {
            let detail = e.to_string();
            detail.starts_with("tunnel error:")
                || detail.starts_with("SOCKS error:")
                || detail.starts_with("error connecting to socks proxy")
        }) {
        NetworkCategory::Proxy
    } else if let Some(tls) = tls {
        match tls {
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer) => {
                NetworkCategory::CertificateUntrusted
            }
            rustls::Error::InvalidCertificate(_) | rustls::Error::NoCertificatesPresented => {
                NetworkCategory::CertificateOther
            }
            _ => NetworkCategory::TlsOther,
        }
    } else if requests.iter().any(|e| e.is_timeout()) || kinds.contains(&io::ErrorKind::TimedOut) {
        NetworkCategory::Timeout
    } else if requests.iter().any(|e| e.is_connect())
        && chain.iter().any(|e| e.to_string().starts_with("dns error"))
    {
        // hyper-util::ConnectError is private; do not match OS-localized resolver messages.
        NetworkCategory::Dns
    } else if kinds.contains(&io::ErrorKind::ConnectionRefused) {
        NetworkCategory::Refused
    } else if chain.iter().any(|cause| {
        cause
            .downcast_ref::<hyper::Error>()
            .is_some_and(|error| error.is_closed() || error.is_incomplete_message())
    }) || kinds.iter().any(|kind| {
        matches!(
            kind,
            io::ErrorKind::ConnectionReset
                | io::ErrorKind::ConnectionAborted
                | io::ErrorKind::UnexpectedEof
        )
    }) {
        NetworkCategory::ResetClosed
    } else if requests.iter().any(|e| e.is_status()) {
        NetworkCategory::HttpStatus
    } else {
        NetworkCategory::Other
    };
    let reason = match category {
        NetworkCategory::Dns => "the name could not be found (check the internet connection, or a firewall may be blocking this site)",
        NetworkCategory::Refused => "the network refused the connection",
        NetworkCategory::ResetClosed => "the connection was closed or interrupted; try again",
        NetworkCategory::Timeout => "the connection timed out",
        NetworkCategory::CertificateUntrusted => "the server's security certificate isn't trusted (a company network may be inspecting secure traffic)",
        NetworkCategory::CertificateOther => "the server's security certificate is invalid (it may have expired or be for a different site)",
        NetworkCategory::Proxy => "the proxy refused the connection or needs sign-in",
        NetworkCategory::TlsOther => "a secure connection could not be established",
        NetworkCategory::HttpStatus => "the server returned an HTTP error",
        NetworkCategory::Other | NetworkCategory::Reachable => "the connection failed",
    };
    let status = requests.iter().find_map(|e| e.status());
    let message = if category == NetworkCategory::HttpStatus {
        format!(
            "Couldn't reach {host}: the server returned HTTP {}.",
            status.expect("HTTP status").as_u16()
        )
    } else {
        format!("Couldn't reach {host}: {reason}.")
    };
    NetworkFailure {
        category,
        host: host.into(),
        message,
        log_detail: redact_urls(&detail),
    }
}

pub fn download_error_message(error: &reqwest::Error) -> String {
    log_failure(classify_reqwest_error(error))
}

pub fn log_failure(failure: NetworkFailure) -> String {
    eprintln!(
        "Download failure for {} ({:?}): {}",
        failure.host, failure.category, failure.log_detail
    );
    failure.message
}

#[cfg(test)]
#[path = "network_error_tests.rs"]
mod tests;
