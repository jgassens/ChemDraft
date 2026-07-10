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
            "read_clipboard_payload",
            "write_clipboard_text_items",
            "open_tool_palette",
            "close_tool_palette",
            "focus_tool_palette",
            "toggle_tool_palette",
            "tool_palette_state",
            "route_palette_command",
            "toggle_spin3d_debugger_window",
        ]),
    ))
    .expect("failed to run Tauri build script");
}
