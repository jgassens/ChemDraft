// This standalone test fixture is compiled with the host's rustc by tests.rs.
use std::{
    env, fs,
    io::{self, Read, Write},
    process::{self, Command, Stdio},
    thread,
    time::Duration,
};

fn main() {
    let args: Vec<String> = env::args().skip(1).collect();
    match args[0].as_str() {
        "capabilities" => {
            #[cfg(windows)]
            {
                #[link(name = "kernel32")]
                extern "system" {
                    fn GetConsoleWindow() -> *mut std::ffi::c_void;
                }
                assert!(
                    unsafe { GetConsoleWindow() }.is_null(),
                    "companion must not have a console"
                );
            }
            let mut input = Vec::new();
            io::stdin().read_to_end(&mut input).unwrap();
            assert!(input.is_empty(), "stdin must be null");
            assert!(env::vars_os().all(|(name, _)| {
                let key = name.to_string_lossy().to_ascii_uppercase();
                !["XTAL_", "PYTHON", "DYLD_", "LD_"]
                    .iter()
                    .any(|prefix| key.starts_with(prefix))
            }));
            let version = if fs::exists("untested").unwrap() {
                "2.0.0"
            } else {
                "1.1.1"
            };
            println!("{{\"version\":\"{version}\"}}");
        }
        "run" => {
            let arg = |key: &str| args.iter().find_map(|arg| arg.strip_prefix(key)).unwrap();
            let input = std::path::Path::new(arg("bb_dir=")).join(format!("{}.xyz", arg("edges=")));
            let text = fs::read_to_string(input).unwrap();
            assert!(text.contains("C 0 0 0"));
            let output = &args[args.iter().position(|arg| arg == "-o").unwrap() + 1];
            match arg("repeat=") {
                "exit" => {
                    eprintln!("Invalid bonding at /tmp/private-app-folder");
                    println!("{{\"ok\":false,\"summary\":\"Build failed because a joint could not bond.\"}}");
                    process::exit(2);
                }
                "bad-json" => {
                    println!("broken");
                    return;
                }
                "no-file" => {}
                _ => fs::write(output, "stub cif").unwrap(),
            }
            // A retry test variant names its reported value on the XYZ comment line.
            let twist = text
                .lines()
                .nth(1)
                .and_then(|line| line.strip_prefix("twist="))
                .unwrap_or("6.000");
            println!("{{\"ok\":true,\"tables\":[{{\"rows\":[{{\"label\":\"Joint twist left\",\"value\":\"{twist}\"}}]}}]}}");
        }
        "inspect" => {
            assert_eq!(fs::read_to_string(&args[1]).unwrap(), "stub cif");
            println!("{{\"formula\":\"CX\",\"n_atoms\":2}}");
        }
        "pipes" => {
            let stderr = thread::spawn(move || {
                io::stderr()
                    .write_all(&vec![b'x'; args[1].parse().unwrap()])
                    .unwrap();
            });
            io::stdout().write_all(&vec![b'y'; 256 * 1024]).unwrap();
            stderr.join().unwrap();
        }
        "stdout" => io::stdout()
            .write_all(&vec![b'x'; 1024 * 1024 + 1])
            .unwrap(),
        "tree" => {
            let child = Command::new(env::current_exe().unwrap())
                .arg("descendant")
                .stdin(Stdio::null())
                .spawn()
                .unwrap();
            fs::write("child-pid", child.id().to_string()).unwrap();
            thread::sleep(Duration::from_secs(60));
        }
        "descendant" => {
            fs::write("child-ready", "").unwrap();
            thread::sleep(Duration::from_secs(4));
            fs::write("child-survived", "").unwrap();
        }
        #[cfg(unix)]
        "detached-tree" => {
            use std::os::unix::process::CommandExt;
            let mut command = Command::new(env::current_exe().unwrap());
            command.arg("detached-descendant");
            unsafe {
                command.pre_exec(|| {
                    extern "C" {
                        fn setsid() -> std::ffi::c_int;
                    }
                    if setsid() == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                });
            }
            let _child = command.spawn().unwrap();
            while !fs::exists("child-ready").unwrap() {
                thread::sleep(Duration::from_millis(10));
            }
        }
        #[cfg(unix)]
        "detached-descendant" => {
            fs::write("child-ready", "").unwrap();
            thread::sleep(Duration::from_secs(4));
        }
        _ => panic!("unexpected arguments {args:?}"),
    }
}
