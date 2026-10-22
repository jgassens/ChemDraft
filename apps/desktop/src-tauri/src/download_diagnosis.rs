use std::time::Duration;

use serde::Serialize;

use crate::network_error::{
    classify_error, download_tls_policy, DownloadPlatform, NetworkCategory,
};

const DIAGNOSIS_HOSTS: &[&str] = &[
    "api.github.com",
    "github.com",
    "release-assets.githubusercontent.com",
];

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkDiagnosis {
    category: NetworkCategory,
    message: Option<String>,
    log_detail: String,
}

#[tauri::command]
pub async fn diagnose_download_host(host: String) -> Result<NetworkDiagnosis, String> {
    // Validate before constructing a client or doing any network I/O. No caller-supplied URL/path.
    if !DIAGNOSIS_HOSTS.contains(&host.as_str()) {
        return Err("Download diagnosis is not allowed for this host.".into());
    }
    let policy = download_tls_policy(DownloadPlatform::current());
    let client = reqwest::Client::builder()
        .tls_built_in_webpki_certs(policy.webpki_roots)
        .tls_built_in_native_certs(policy.native_roots)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build();
    let result = match client {
        Ok(client) => client
            .head(format!("https://{host}/"))
            .send()
            .await
            .map(|_| ()),
        Err(error) => Err(error),
    };
    Ok(match result {
        Ok(()) => NetworkDiagnosis {
            category: NetworkCategory::Reachable,
            message: None,
            log_detail: String::new(),
        },
        Err(error) => {
            let failure = classify_error(&error, &host);
            eprintln!("Download diagnosis for {host}: {}", failure.log_detail);
            NetworkDiagnosis {
                category: failure.category,
                message: Some(failure.message),
                log_detail: failure.log_detail,
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    #[test]
    fn refuses_unlisted_hosts_before_any_connection() {
        for host in [
            "127.0.0.1:9",
            "example.com",
            "github.com/path",
            "github.com@127.0.0.1",
            "github.com?sig=secret",
            "GITHUB.COM",
        ] {
            let error =
                tauri::async_runtime::block_on(diagnose_download_host(host.into())).unwrap_err();
            assert_eq!(error, "Download diagnosis is not allowed for this host.");
        }
    }

    #[test]
    fn exact_host_set_matches_capability_and_typescript_redirect_rules() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/plugin-updates.json")).unwrap();
        let mut expected = BTreeSet::new();
        for permission in capability["permissions"].as_array().unwrap() {
            for entry in permission["allow"].as_array().unwrap() {
                expected.insert(
                    reqwest::Url::parse(entry["url"].as_str().unwrap())
                        .unwrap()
                        .host_str()
                        .unwrap()
                        .to_string(),
                );
            }
        }
        let ts = include_str!("../../src/plugins/pluginUpdates.ts");
        let redirect_host = ts
            .lines()
            .find_map(|line| line.strip_prefix("export const GITHUB_RELEASE_ASSET_HOST = \""))
            .unwrap()
            .trim_end_matches("\";");
        assert!(ts.contains("target.hostname !== GITHUB_RELEASE_ASSET_HOST"));
        let redirect_check = ts
            .split("function trustedGitHubAssetRedirect(")
            .nth(1)
            .unwrap()
            .split("async function assertResponseStayedAt(")
            .next()
            .unwrap();
        assert_eq!(
            redirect_check.matches("target.hostname").count(),
            1,
            "redirect host rules changed; update the diagnosis host-set test"
        );
        expected.insert(redirect_host.to_string());
        assert_eq!(
            DIAGNOSIS_HOSTS
                .iter()
                .map(|host| host.to_string())
                .collect::<BTreeSet<_>>(),
            expected
        );
    }

    #[test]
    fn diagnosis_permission_is_document_windows_only() {
        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/download-diagnosis.json")).unwrap();
        assert_eq!(
            capability["windows"],
            serde_json::json!(["main", "document-*"])
        );
        assert_eq!(
            capability["permissions"],
            serde_json::json!(["allow-diagnose-download-host"])
        );
        for file in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/capabilities")).unwrap()
        {
            let path = file.unwrap().path();
            if path.file_name().unwrap() != "download-diagnosis.json"
                && path
                    .extension()
                    .is_some_and(|extension| extension == "json")
            {
                assert!(!std::fs::read_to_string(path)
                    .unwrap()
                    .contains("allow-diagnose-download-host"));
            }
        }
    }
}
