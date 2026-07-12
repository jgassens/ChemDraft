fn main() {
    // run-app exports the label; re-emitting it as rustc-env makes it a tracked compile input for
    // option_env! in lib.rs. A bare environment variable alone does not force the crate to rebuild.
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
        ]),
    ))
    .expect("failed to run Tauri build script");
}
