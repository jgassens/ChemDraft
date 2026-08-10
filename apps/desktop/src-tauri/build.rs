fn main() {
    // Bake the worktree label (exported by run-app) into the crate as a tracked compile input, so
    // main_window_title()'s option_env! reads it AND cargo recompiles lib.rs when it changes. A bare
    // env var isn't a tracked input — rerun-if-env-changed only re-runs THIS script, it doesn't force
    // the crate to recompile — so re-emitting it as rustc-env is what actually makes the title update.
    // See AGENTS.md.
    println!("cargo:rerun-if-env-changed=CHEMDRAFT_WORKTREE_LABEL");
    if let Ok(label) = std::env::var("CHEMDRAFT_WORKTREE_LABEL") {
        println!("cargo:rustc-env=CHEMDRAFT_WORKTREE_LABEL={label}");
    }
    #[cfg(target_os = "macos")]
    stage_sparkle_framework_for_cargo_executables();
    ensure_opsin_runtime_dir();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_toolset_window",
            "close_toolset_window",
            "focus_toolset_window",
            "toggle_toolset_window",
            "list_toolset_window_states",
            "set_menu_checked",
            "plugin_storage_read",
            "plugin_storage_write",
            "open_plugin_panel_window",
            "open_toolset_popover",
            "prewarm_toolset_popover",
            "show_toolset_tooltip_window",
            "close_toolset_popover",
            "set_toolset_window_focusable",
            "route_toolset_command",
            "sync_plugin_menu_items",
            "read_clipboard_payload",
            "write_clipboard_text_items",
            "open_tool_palette",
            "close_tool_palette",
            "focus_tool_palette",
            "toggle_tool_palette",
            "tool_palette_state",
            "route_palette_command",
            "toggle_spin3d_debugger_window",
            "opsin_status",
            "opsin_name_to_structure",
            "agent_bridge_status",
            "window_logical_position",
            "take_pending_open_document",
        ]),
    ))
    .expect("failed to run Tauri build script");
}

/// Cargo test binaries are launched from `target/<profile>/deps`, not from an app bundle. The
/// Sparkle bridge links with `@executable_path/../Frameworks`, so expose the prepared framework at
/// that build-only location as well. Tauri still copies the real framework into packaged apps.
#[cfg(target_os = "macos")]
fn stage_sparkle_framework_for_cargo_executables() {
    use std::os::unix::fs::symlink;

    let Ok(out_dir) = std::env::var("OUT_DIR") else {
        return;
    };
    let Some(profile_dir) = std::path::Path::new(&out_dir).ancestors().nth(3) else {
        return;
    };
    let source = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("Sparkle.framework");
    if !source.is_dir() {
        return;
    }

    let frameworks_dir = profile_dir.join("Frameworks");
    std::fs::create_dir_all(&frameworks_dir)
        .expect("failed to create the Cargo test Frameworks directory");
    let destination = frameworks_dir.join("Sparkle.framework");
    if !destination.exists() {
        symlink(&source, &destination).expect("failed to link Sparkle for Cargo test executables");
    }

    println!("cargo:rerun-if-changed={}", source.display());
}

/// Make the OPSIN Java runtime path exist so `tauri_build` can resolve it, even when the runtime has
/// not been built.
///
/// `tauri.conf.json` lists `resources/opsin/jre` as a bundle resource, and `tauri_build` PANICS on a
/// resource path that does not exist. The runtime is ~47 MB produced by
/// `scripts/build-opsin-runtime.sh` and is gitignored as rebuildable, so it is present on a developer
/// machine that has built it and absent on every fresh checkout — which is exactly how CI failed:
/// `failed to run Tauri build script: resource path resources/opsin/jre doesn't exist`.
///
/// Creating the directory is safe rather than a papering-over, because absence is already a supported
/// state at RUNTIME: `opsin::java_binary` looks for `jre/bin/java` and reports OPSIN unavailable when
/// it is missing, which is the behaviour the feature was built with ("say so honestly when it
/// cannot"). An empty directory therefore reads as "no runtime", not as a broken one.
///
/// The warning is the point of the function beyond the mkdir: a bundle built without the runtime ships
/// an app whose name-to-structure declines, and that should never be discovered by a user.
fn ensure_opsin_runtime_dir() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/opsin/jre");
    // Without this the script's output is cached, so building the runtime afterwards leaves the
    // "absent" warning firing on a tree that now has it — the warning would outlive the condition it
    // reports, which is worse than not warning at all.
    println!(
        "cargo:rerun-if-changed={}",
        path.join("bin").join("java").display()
    );
    if path.join("bin").join("java").exists() {
        return;
    }
    if let Err(error) = std::fs::create_dir_all(&path) {
        println!("cargo:warning=could not create {}: {error}", path.display());
        return;
    }
    println!(
        "cargo:warning=OPSIN Java runtime absent at resources/opsin/jre — building without it. \
Name-to-structure will report itself unavailable. Run scripts/build-opsin-runtime.sh to include it."
    );
}
