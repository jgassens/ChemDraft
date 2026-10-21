//! Reviewed naming inputs. Tool pins and digest IO remain in local_engine.
pub const DIR_NAME: &str = "naming-engine";
pub const PYTHON_VERSION: &str = "3.12";
// 2026-10-21 macOS arm64 measurement: ~490 MB fresh-install peak + ~310 MB previous
// engine retained during update = ~800 MB worst case, plus a 25% margin. See naming-engine.md.
pub const REQUIRED_DISK_BYTES: u64 = 1_000_000_000;
pub const ORTHONYM_VERSION: &str = "1.0.8";
pub const ORTHONYM_COMMIT: &str = "461987b947f76e41ff0baa6c2aa19ecd79cacd0b";
pub const ORTHONYM_WHEEL_SHA256: &str =
    "ffd4f69d95349887c3fd762197464dadff81a1cf494fe42f6a2bcd7d6674393d";
pub const REQUIREMENTS_LOCK_SHA256: &str =
    "ec5021b4365d77936c99ae71f3057a41c946149e67d8342de24c867edd6d9a2a";
pub const CENTRES_URL: &str =
    "https://github.com/SiMolecule/centres/releases/download/1.2.1/centres.jar";
pub const CENTRES_BYTES: u64 = 2_291_742;
pub const CENTRES_SHA256: &str = "6c5d5cafa9393ed7b667a2340222348cd15a9bbdd0d1b92518229f26cc5e87fb";
pub const CENTRES_FILENAME: &str = "centres-cli-1.2.1.jar";
