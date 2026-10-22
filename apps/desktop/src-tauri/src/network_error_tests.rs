use super::*;
use std::{fmt, io::Read, net::TcpListener, sync::Arc, time::Duration};

#[derive(Debug)]
struct Wrapped(&'static str, Box<dyn Error + Send + Sync>);
impl fmt::Display for Wrapped {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.0)
    }
}
impl Error for Wrapped {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        Some(self.1.as_ref())
    }
}

fn client() -> reqwest::blocking::Client {
    reqwest::blocking::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()
        .unwrap()
}

#[test]
fn desktop_platforms_keep_both_verified_root_sets_and_cargo_features() {
    for platform in [
        DownloadPlatform::MacOs,
        DownloadPlatform::Windows,
        DownloadPlatform::Other,
    ] {
        assert_eq!(
            download_tls_policy(platform),
            DownloadTlsPolicy {
                webpki_roots: true,
                native_roots: true
            }
        );
    }
    let manifest = include_str!("../Cargo.toml");
    let reqwest = manifest
        .lines()
        .find(|line| line.starts_with("reqwest = "))
        .unwrap();
    for feature in ["\"rustls-tls\"", "\"rustls-tls-native-roots\""] {
        assert!(reqwest.contains(feature), "reqwest must retain {feature}");
    }
}

#[test]
fn hyper_util_display_strings_are_checked_against_the_locked_version() {
    let lock = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.lock"),
    )
    .unwrap();
    let versions: Vec<_> = lock
        .split("[[package]]")
        .filter(|package| package.lines().any(|line| line == "name = \"hyper-util\""))
        .filter_map(|package| package.lines().find(|line| line.starts_with("version = ")))
        .collect();
    assert_eq!(
        versions,
        ["version = \"0.1.20\""],
        "Before bumping this test's pin, recheck every matched string in network_error.rs \
         against the new hyper-util source."
    );
}

#[test]
fn typed_io_failures_survive_nested_wrappers() {
    for (kind, expected) in [
        (io::ErrorKind::ConnectionRefused, NetworkCategory::Refused),
        (io::ErrorKind::ConnectionReset, NetworkCategory::ResetClosed),
        (
            io::ErrorKind::ConnectionAborted,
            NetworkCategory::ResetClosed,
        ),
        (io::ErrorKind::UnexpectedEof, NetworkCategory::ResetClosed),
        (io::ErrorKind::TimedOut, NetworkCategory::Timeout),
        (io::ErrorKind::Other, NetworkCategory::Other),
    ] {
        let error = Wrapped("outer", Box::new(io::Error::new(kind, "injected")));
        let failure = classify_error(&error, "github.com");
        assert_eq!(failure.category, expected);
        assert!(failure.message.starts_with("Couldn't reach github.com:"));
    }
}

#[test]
fn typed_certificates_and_tls_survive_io_wrappers() {
    for (error, expected) in [
        (
            rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer),
            NetworkCategory::CertificateUntrusted,
        ),
        (
            rustls::Error::InvalidCertificate(rustls::CertificateError::Expired),
            NetworkCategory::CertificateOther,
        ),
        (
            rustls::Error::InvalidCertificate(rustls::CertificateError::NotValidForName),
            NetworkCategory::CertificateOther,
        ),
        (
            rustls::Error::NoCertificatesPresented,
            NetworkCategory::CertificateOther,
        ),
        (
            rustls::Error::General("handshake failed".into()),
            NetworkCategory::TlsOther,
        ),
    ] {
        let outer = Wrapped("response read", Box::new(io::Error::other(error)));
        assert_eq!(classify_error(&outer, "github.com").category, expected);
    }
}

#[test]
fn injected_proxy_source_has_precedence_over_socket_failure() {
    for detail in [
        "tunnel error: unsuccessful",
        "tunnel error: proxy authorization required",
        "tunnel error: failed to create underlying connection",
        "error connecting to socks proxy",
        "SOCKS error: failed to create underlying connection",
    ] {
        let error = Wrapped(
            detail,
            Box::new(io::Error::from(io::ErrorKind::ConnectionRefused)),
        );
        let failure = classify_error(&error, "github.com");
        assert_eq!(failure.category, NetworkCategory::Proxy);
        assert!(failure
            .message
            .contains("proxy refused the connection or needs sign-in"));
    }
}

#[test]
fn injected_http_responses_keep_status_and_proxy_categories_and_redact_urls() {
    for (status, expected) in [
        (503, NetworkCategory::HttpStatus),
        (407, NetworkCategory::Proxy),
    ] {
        let response: reqwest::blocking::Response = hyper::Response::builder()
            .status(status)
            .body("")
            .unwrap()
            .into();
        let error = response.error_for_status().unwrap_err().with_url(
            reqwest::Url::parse("https://github.com/asset?sig=secret-signature&jwt=secret-token")
                .unwrap(),
        );
        let failure = classify_reqwest_error(&error);
        assert_eq!(failure.category, expected);
        assert!(failure.message.starts_with("Couldn't reach github.com:"));
        if status == 503 {
            assert!(failure.message.contains("HTTP 503"));
        }
        for text in [&failure.message, &failure.log_detail] {
            assert!(!text.contains('?'));
            assert!(!text.contains("secret-signature"));
            assert!(!text.contains("secret-token"));
        }
    }
}

#[test]
fn self_signed_certificate_is_rejected_in_memory_without_network_access() {
    let certificate = rustls::pki_types::CertificateDer::from(
        include_bytes!("test_fixtures/network-cert.der").to_vec(),
    );
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(
        include_bytes!("test_fixtures/network-key.der").to_vec(),
    );
    let server_config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key.into())
        .unwrap();
    let client_config = rustls::ClientConfig::builder()
        .with_root_certificates(rustls::RootCertStore::empty())
        .with_no_client_auth();
    let mut server = rustls::ServerConnection::new(Arc::new(server_config)).unwrap();
    let mut client =
        rustls::ClientConnection::new(Arc::new(client_config), "localhost".try_into().unwrap())
            .unwrap();
    let mut hello = Vec::new();
    client.write_tls(&mut hello).unwrap();
    server.read_tls(&mut hello.as_slice()).unwrap();
    server.process_new_packets().unwrap();
    let mut reply = Vec::new();
    while server.wants_write() {
        server.write_tls(&mut reply).unwrap();
    }
    client.read_tls(&mut reply.as_slice()).unwrap();
    let error = client.process_new_packets().unwrap_err();
    assert_eq!(
        error,
        rustls::Error::InvalidCertificate(rustls::CertificateError::UnknownIssuer)
    );
    assert_eq!(
        classify_error(&error, "localhost").category,
        NetworkCategory::CertificateUntrusted
    );
}

#[test]
fn redacts_every_url_including_nested_sources_and_credentials() {
    let signed = "https://user:password@release-assets.githubusercontent.com/path?sig=secret-signature&jwt=secret-token#fragment";
    assert_eq!(
        redact_url(signed),
        "https://release-assets.githubusercontent.com/path"
    );
    let inner = io::Error::other(format!(
        "read {signed} and http://user:password@github.com/other?token=secret-token"
    ));
    let error = Wrapped(
        "request https://github.com/start?sig=secret-signature",
        Box::new(inner),
    );
    let failure = classify_error(&error, "github.com");
    for text in [&failure.message, &failure.log_detail] {
        for forbidden in [
            "?",
            "sig=",
            "jwt=",
            "secret-token",
            "secret-signature",
            "password",
            "#fragment",
        ] {
            assert!(!text.contains(forbidden), "leaked {forbidden}: {text}");
        }
    }
    assert!(failure
        .log_detail
        .contains("https://release-assets.githubusercontent.com/path"));
    assert!(failure.log_detail.contains("http://github.com/other"));
    assert_eq!(redact_url("invalid?token=secret-token"), "[redacted URL]");
    assert_eq!(
        redact_urls("HTTP://user:password@github.com/path?jwt=secret-token#fragment"),
        "http://github.com/path"
    );
}

#[test]
fn redacts_malformed_urls_and_sensitive_suffixes_with_unusual_delimiters() {
    for url in [
        "https://user:password@github.com/path?sig=secret'jwt=secret",
        "https://github.com/path?sig=secret\"jwt=secret",
        "https://github.com/path?sig=secret`jwt=secret",
        "https://github.com/path?sig=secret,jwt=secret",
        "https://github.com/path?sig=secret)jwt=secret",
        "https://github.com/path?sig=%29%22%60secret%23jwt%3Dsecret",
        "HTTPS://github.com/path#secret)jwt=secret?sig=secret",
        "https://[invalid/path?sig=secret)jwt=secret",
        "https://[invalid/path#secret`jwt=secret",
        "https://[invalid]/path?sig=secret)jwt=secret",
    ] {
        let expected = if url.contains("[invalid") {
            "[redacted URL]"
        } else {
            "https://github.com/path"
        };
        assert_eq!(redact_url(url), expected, "direct: {url}");
        assert_eq!(
            redact_urls(&format!("outer {url} next")),
            format!("outer {expected} next"),
            "embedded: {url}"
        );
    }
}

#[test]
fn redacts_whole_url_tokens_and_restores_only_trailing_punctuation() {
    for suffix in [")", ".", ",", ")).,"] {
        assert_eq!(
            redact_urls(&format!(
                "request https://github.com/path?sig=secret{suffix} client"
            )),
            format!("request https://github.com/path{suffix} client")
        );
        assert_eq!(
            redact_urls(&format!("request https://github.com/path{suffix} client")),
            format!("request https://github.com/path{suffix} client")
        );
    }
    assert_eq!(
        redact_urls("request https://github.com/path?sig=ab)cd client"),
        "request https://github.com/path client"
    );
}

#[test]
fn real_closed_port_is_refused_and_signed_url_is_redacted() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    drop(listener);
    let error = client()
        .get(format!(
            "http://{address}/asset?sig=secret-signature&jwt=secret-token"
        ))
        .send()
        .unwrap_err();
    let failure = classify_reqwest_error(&error);
    assert_eq!(
        failure.category,
        NetworkCategory::Refused,
        "{}",
        failure.log_detail
    );
    assert_eq!(
        failure.message,
        "Couldn't reach 127.0.0.1: the network refused the connection."
    );
    for forbidden in ["?", "sig=", "jwt=", "secret-signature", "secret-token"] {
        assert!(!failure.log_detail.contains(forbidden));
        assert!(!failure.message.contains(forbidden));
    }
}

#[test]
fn real_invalid_tld_is_dns() {
    let error = client()
        .get("https://does-not-exist.invalid/")
        .send()
        .unwrap_err();
    let failure = classify_reqwest_error(&error);
    if failure.category != NetworkCategory::Dns
        && failure.log_detail.contains("Operation not permitted")
    {
        eprintln!(
            "Skipping DNS assertion: sandbox prohibits resolver/network access: {}",
            failure.log_detail
        );
        return;
    }
    assert_eq!(
        failure.category,
        NetworkCategory::Dns,
        "{}",
        failure.log_detail
    );
    assert!(failure
        .message
        .contains("does-not-exist.invalid: the name could not be found"));
}

#[test]
fn real_tls_stall_is_timeout() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        std::thread::sleep(Duration::from_millis(500));
        drop(stream);
    });
    let error = client()
        .get(format!("https://{address}/"))
        .timeout(Duration::from_millis(100))
        .send()
        .unwrap_err();
    let failure = classify_reqwest_error(&error);
    assert_eq!(
        failure.category,
        NetworkCategory::Timeout,
        "{}",
        failure.log_detail
    );
    assert!(failure.message.contains("connection timed out"));
    server.join().unwrap();
}

#[test]
fn real_self_signed_tls_is_untrusted() {
    // Generated offline with OpenSSL; test-only key, never installed in any trust store.
    let certificate = rustls::pki_types::CertificateDer::from(
        include_bytes!("test_fixtures/network-cert.der").to_vec(),
    );
    let key = rustls::pki_types::PrivatePkcs8KeyDer::from(
        include_bytes!("test_fixtures/network-key.der").to_vec(),
    );
    let config = rustls::ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(vec![certificate], key.into())
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let connection = rustls::ServerConnection::new(Arc::new(config)).unwrap();
        let mut stream = rustls::StreamOwned::new(connection, socket);
        let _ = stream.read(&mut [0u8; 1]);
    });
    let error = client()
        .get(format!("https://{address}/"))
        .send()
        .unwrap_err();
    let failure = classify_reqwest_error(&error);
    assert_eq!(
        failure.category,
        NetworkCategory::CertificateUntrusted,
        "{}",
        failure.log_detail
    );
    assert!(failure.message.contains("certificate isn't trusted"));
    server.join().unwrap();
}

#[test]
fn real_http_status_and_proxy_auth_are_distinguished() {
    for (status, expected) in [
        (503, NetworkCategory::HttpStatus),
        (407, NetworkCategory::Proxy),
    ] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            crate::network_test_http::reply(
                stream,
                format!(
                    "HTTP/1.1 {status} Failure\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                )
                .as_bytes(),
            );
        });
        let error = client()
            .get(format!("http://{address}/"))
            .send()
            .unwrap()
            .error_for_status()
            .unwrap_err();
        assert_eq!(classify_reqwest_error(&error).category, expected);
        server.join().unwrap();
    }
    let injected = io::Error::other(Wrapped(
        "tunnel error: unsuccessful",
        Box::new(io::Error::from(io::ErrorKind::ConnectionRefused)),
    ));
    assert_eq!(
        classify_error(&injected, "github.com").category,
        NetworkCategory::Proxy
    );
}

#[test]
fn real_proxy_tunnel_407_uses_proxy_message() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let server = std::thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        crate::network_test_http::reply(
            stream,
            b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
        );
    });
    let error = reqwest::blocking::Client::builder()
        .no_proxy()
        .proxy(reqwest::Proxy::https(format!("http://{address}")).unwrap())
        .build()
        .unwrap()
        .get("https://github.com/")
        .send()
        .unwrap_err();
    let failure = classify_reqwest_error(&error);
    assert_eq!(
        failure.category,
        NetworkCategory::Proxy,
        "{}",
        failure.log_detail
    );
    server.join().unwrap();
}
