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
