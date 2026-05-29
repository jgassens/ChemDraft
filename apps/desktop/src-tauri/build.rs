fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&[
                "open_tool_palette",
                "close_tool_palette",
                "focus_tool_palette",
                "toggle_tool_palette",
                "tool_palette_state",
                "route_palette_command",
            ]),
        ),
    )
    .expect("failed to run Tauri build script");
}
