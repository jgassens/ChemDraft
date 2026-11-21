// Release builds on Windows are GUI-subsystem executables: no console window behind the app.
// Debug builds keep the console so `pnpm dev` shows Rust-side logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    chemdraft_lib::run();
}
