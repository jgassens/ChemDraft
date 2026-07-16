//! Serve staged plugin packages **from the app's own origin** (ADR-0029 §6 as amended; M36).
//!
//! # Why this module exists at all
//!
//! M35 established by measurement (report 0030) that a built plugin package loads **only** from a real,
//! co-located, **same-origin** URL. The NMR plugin is the concrete proof: from inside its own worker it
//! does `new Worker(new URL("assets/nmrWorker-*.js", import.meta.url))`, and its 7.5 MB reference
//! database rides in that sibling chunk. That rules out every obvious staging route:
//!
//! - a **blob URL** has no siblings (and fails *late* — the `ready` handshake succeeds and only the
//!   prediction fails);
//! - **`asset://`** is a *separate origin*, and worker scripts are same-origin-only;
//! - **registering a new custom scheme** for plugins is likewise a new origin.
//!
//! So exactly one thing can work: the handler that serves the **document** must also serve the
//! **package**. On macOS that document is served from `tauri://localhost` by Tauri's own built-in
//! `tauri` URI-scheme handler.
//!
//! # The hook (verified against tauri 2.11.2 source, not documentation)
//!
//! `tauri::Builder::register_uri_scheme_protocol("tauri", ..)` **pre-empts** the built-in handler:
//! `manager/webview.rs` drains the app-registered protocol map into `registered_scheme_protocols`
//! *first*, and only then does `if !registered_scheme_protocols.contains(&"tauri".into())` decide
//! whether to install the built-in one. Registering `"tauri"` ourselves means the built-in never
//! installs, and `Builder::register_uri_scheme_protocol` is an unguarded map insert — reserved scheme
//! names are not rejected.
//!
//! **The origin does not change.** We replace the *handler* for a scheme, not the scheme itself; the
//! window still loads `tauri://localhost`. That matters more than it looks: an origin change would
//! orphan every origin-keyed store the app already has (localStorage — including M32's disabled-plugin
//! preferences — and IndexedDB). This mechanism was chosen precisely because it costs none of that.
//!
//! Everything that is not a staged plugin asset is delegated to [`tauri::AssetResolver`], which is the
//! same `AppManager::get_asset` the built-in handler calls — so the index.html fallback chain, CSP
//! injection and dev-mode `frontendDist` fallback all keep working unchanged.
//!
//! (For the record, the hook that *looks* right and is not: `on_web_resource_request` runs only
//! **after** `manager.get_asset(path)?` succeeds, so it is never invoked for a path absent from the
//! embedded asset store. It can rewrite existing assets; it cannot introduce new ones.)

use std::borrow::Cow;
use std::path::{Component, Path, PathBuf};

use tauri::http::{header::CONTENT_TYPE, Request, Response, StatusCode};
use tauri::utils::mime_type::MimeType;
use tauri::{AppHandle, Manager, Runtime, UriSchemeContext};

/// Origin the macOS/iOS/Linux webview serves the app document from.
const APP_ORIGIN: &str = "tauri://localhost";

/// Reserved path prefix on the app's own origin under which staged packages are served. Must match
/// `INSTALLED_PLUGINS_URL_PREFIX` in `apps/desktop/src/plugins/installedPluginPaths.ts`.
pub const INSTALLED_PLUGINS_URL_PREFIX: &str = "/installed-plugins/";

/// Directory under the app-data dir holding staged packages, keyed by plugin id. Must match
/// `INSTALLED_PLUGINS_DIR` in `apps/desktop/src/plugins/installedPluginPaths.ts`.
pub const INSTALLED_PLUGINS_DIR: &str = "installed-plugins";

/// Root directory holding every staged package.
pub fn installed_plugins_root<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join(INSTALLED_PLUGINS_DIR))
}

/// Handle one request on the app's own `tauri://` origin.
///
/// Staged-plugin paths are served from app data; everything else is the app's own frontend and is
/// delegated to the asset resolver exactly as the built-in handler would.
pub fn handle_tauri_request<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let app = ctx.app_handle();

    // Ignore query string and fragment, then strip the origin — mirroring `protocol::tauri::get_response`.
    let uri = request.uri().to_string();
    let path = uri.split(['?', '#']).next().unwrap_or_default();
    let path = path.strip_prefix(APP_ORIGIN).unwrap_or(path);

    match percent_decode(path).strip_prefix(INSTALLED_PLUGINS_URL_PREFIX) {
        Some(relative) => {
            let response = serve_installed_plugin_asset(app, relative);
            // Log every staged-plugin fetch. This is not decoration: a plugin can silently fall back to
            // an in-thread path when a nested worker fails to load, so the *fetch log is the only thing*
            // that distinguishes a package genuinely running from its staged location from one whose
            // fallback is quietly covering for a broken one (report 0030 established this the hard way).
            // Frontend assets are deliberately not logged — that would be thousands of lines per launch.
            eprintln!(
                "[chemdraft] serve {} {}{}",
                response.status().as_u16(),
                INSTALLED_PLUGINS_URL_PREFIX,
                relative
            );
            response
        }
        None => serve_app_asset(app, path),
    }
}

/// The app's own frontend, resolved by the same machinery the built-in handler uses.
fn serve_app_asset<R: Runtime>(app: &AppHandle<R>, path: &str) -> Response<Cow<'static, [u8]>> {
    match app.asset_resolver().get(path.to_string()) {
        Some(asset) => {
            let mut builder = Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, &asset.mime_type)
                .header("Access-Control-Allow-Origin", APP_ORIGIN);
            if let Some(csp) = &asset.csp_header {
                builder = builder.header("Content-Security-Policy", csp);
            }
            builder
                .body(Cow::Owned(asset.bytes))
                .unwrap_or_else(|_| internal_error("could not build asset response"))
        }
        None => not_found(format!("Asset not found: {path}")),
    }
}

/// A file inside a staged package, addressed as `/installed-plugins/<plugin-id>/<file>`.
///
/// Fails closed on anything that is not a plain relative path inside the staging root. The installer
/// already refuses traversal entries when unpacking, but serving re-checks independently: these are two
/// different trust boundaries (a zip we unpacked vs. a URL the webview asked for), and the staging root
/// is user-writable between them.
fn serve_installed_plugin_asset<R: Runtime>(
    app: &AppHandle<R>,
    relative: &str,
) -> Response<Cow<'static, [u8]>> {
    let Some(root) = installed_plugins_root(app) else {
        return internal_error("no app data directory is available for staged plugins");
    };
    let Some(safe_relative) = safe_relative_path(relative) else {
        return forbidden(format!("Unsafe staged plugin path: {relative}"));
    };

    let candidate = root.join(&safe_relative);
    if !is_contained_in(&root, &candidate) {
        return forbidden(format!("Staged plugin path escapes its root: {relative}"));
    }

    match std::fs::read(&candidate) {
        Ok(bytes) => {
            let mime_type = MimeType::parse(&bytes, relative);
            Response::builder()
                .status(StatusCode::OK)
                .header(CONTENT_TYPE, mime_type)
                .header("Access-Control-Allow-Origin", APP_ORIGIN)
                // A staged package is immutable for the life of an install: its directory is replaced
                // wholesale on reinstall, never edited in place.
                .header("Cache-Control", "no-cache")
                .body(Cow::Owned(bytes))
                .unwrap_or_else(|_| internal_error("could not build staged plugin response"))
        }
        Err(error) => not_found(format!("Staged plugin asset not found: {relative} ({error})")),
    }
}

/// Reject anything that is not a plain, relative, non-empty path: absolute paths, `..`, drive
/// prefixes, and embedded NULs all fail closed rather than being normalized into something plausible.
fn safe_relative_path(relative: &str) -> Option<PathBuf> {
    if relative.is_empty() || relative.contains('\0') {
        return None;
    }

    let mut safe = PathBuf::new();
    let mut segments = 0usize;
    for component in Path::new(relative).components() {
        match component {
            Component::Normal(segment) => {
                safe.push(segment);
                segments += 1;
            }
            // `..`, `/`, `C:` and `.` are all refused outright rather than resolved.
            Component::ParentDir
            | Component::RootDir
            | Component::Prefix(_)
            | Component::CurDir => return None,
        }
    }

    // `<plugin-id>/<file>` at minimum: a bare plugin id addresses a directory, not an asset.
    if segments < 2 {
        return None;
    }
    Some(safe)
}

/// Belt-and-braces containment check against symlinks inside the staging root. Falls back to the
/// lexical path when the file does not exist (so a plain 404 stays a 404 rather than becoming a 403).
fn is_contained_in(root: &Path, candidate: &Path) -> bool {
    let canonical_root = match root.canonicalize() {
        Ok(path) => path,
        // The staging root does not exist yet: nothing is installed, so nothing can be served.
        Err(_) => return false,
    };
    match candidate.canonicalize() {
        Ok(canonical_candidate) => canonical_candidate.starts_with(&canonical_root),
        Err(_) => candidate.starts_with(root),
    }
}

/// Minimal percent-decoder for request paths.
///
/// Hand-rolled rather than pulling in `percent-encoding` as a new direct dependency: the crate is only
/// in the tree transitively, and this is the whole of what we need. Invalid escapes are left verbatim
/// (they cannot denote a real staged file, and `safe_relative_path` refuses whatever they become), and
/// decoding happens *before* the traversal check so `%2e%2e%2f` is rejected as `../` rather than being
/// waved through as an opaque segment.
fn percent_decode(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let high = (bytes[index + 1] as char).to_digit(16);
            let low = (bytes[index + 2] as char).to_digit(16);
            if let (Some(high), Some(low)) = (high, low) {
                decoded.push((high * 16 + low) as u8);
                index += 3;
                continue;
            }
        }
        decoded.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&decoded).into_owned()
}

fn text_response(status: StatusCode, message: String) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain")
        .header("Access-Control-Allow-Origin", APP_ORIGIN)
        .body(Cow::Owned(message.into_bytes()))
        .expect("a text response is always well-formed")
}

fn not_found(message: String) -> Response<Cow<'static, [u8]>> {
    text_response(StatusCode::NOT_FOUND, message)
}

fn forbidden(message: String) -> Response<Cow<'static, [u8]>> {
    text_response(StatusCode::FORBIDDEN, message)
}

fn internal_error(message: &str) -> Response<Cow<'static, [u8]>> {
    text_response(StatusCode::INTERNAL_SERVER_ERROR, message.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_plain_plugin_relative_path() {
        assert_eq!(
            safe_relative_path("org.chemdraft.nmr.predictor/entry.js"),
            Some(PathBuf::from("org.chemdraft.nmr.predictor/entry.js"))
        );
        assert_eq!(
            safe_relative_path("org.chemdraft.nmr.predictor/assets/nmrWorker-BcY5tkZR.js"),
            Some(PathBuf::from(
                "org.chemdraft.nmr.predictor/assets/nmrWorker-BcY5tkZR.js"
            ))
        );
    }

    #[test]
    fn refuses_traversal_and_absolute_paths() {
        for hostile in [
            "../../../../etc/passwd",
            "plugin/../../etc/passwd",
            "/etc/passwd",
            "plugin/../../../Library/Preferences/com.apple.finder.plist",
            "./plugin/entry.js",
        ] {
            assert_eq!(safe_relative_path(hostile), None, "should refuse {hostile}");
        }
    }

    #[test]
    fn refuses_empty_bare_and_nul_paths() {
        assert_eq!(safe_relative_path(""), None);
        // A bare plugin id addresses a directory, not an asset.
        assert_eq!(safe_relative_path("org.chemdraft.nmr.predictor"), None);
        assert_eq!(safe_relative_path("plugin/entry\0.js"), None);
    }

    #[test]
    fn percent_decodes_before_the_traversal_check() {
        // The decisive case: an encoded traversal must be decoded *first*, then refused — otherwise
        // `%2e%2e%2f` would sail through `safe_relative_path` as an innocuous opaque segment.
        assert_eq!(percent_decode("plugin/%2e%2e%2fetc/passwd"), "plugin/../etc/passwd");
        assert_eq!(safe_relative_path(&percent_decode("%2e%2e%2f%2e%2e%2fetc/passwd")), None);

        assert_eq!(percent_decode("plugin/a%20file.js"), "plugin/a file.js");
        // Invalid or truncated escapes are left verbatim rather than guessed at.
        assert_eq!(percent_decode("plugin/100%.js"), "plugin/100%.js");
        assert_eq!(percent_decode("plugin/%zz.js"), "plugin/%zz.js");
        assert_eq!(percent_decode("plugin/entry.js"), "plugin/entry.js");
    }

    #[test]
    fn containment_rejects_a_missing_root() {
        let root = PathBuf::from("/definitely/not/a/real/chemdraft/staging/root");
        assert!(!is_contained_in(&root, &root.join("plugin/entry.js")));
    }
}
