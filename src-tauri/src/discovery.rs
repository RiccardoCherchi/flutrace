use serde::Serialize;
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub searching: bool,
    pub message: String,
    pub sessions: Vec<Session>,
    pub dtd_uris: Vec<String>,
    /// (pid, startTime) of every VM already listed. One VM can be reachable
    /// through several URLs: its own port, a DDS proxy, or repeated log lines.
    #[serde(skip)]
    vms: Vec<(i64, i64)>,
}
#[derive(Clone, Serialize)]
pub struct Session {
    pub name: String,
    pub uri: String,
}
#[derive(Default)]
pub struct Discovery {
    snapshot: Arc<Mutex<Snapshot>>,
    worker: Mutex<Option<(Arc<AtomicBool>, thread::JoinHandle<()>)>>,
}
impl Discovery {
    pub fn stop(&self) {
        if let Some((cancel, worker)) = self.worker.lock().unwrap().take() {
            cancel.store(true, Ordering::SeqCst);
            let _ = worker.join();
        }
    }
}
fn finish(child: &mut Child) {
    if let Some(input) = child.stdin.as_mut() {
        let _ = writeln!(input, "{}", json!([{"id":9999,"method":"daemon.shutdown"}]));
    }
    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if child.try_wait().ok().flatten().is_some() {
            return;
        }
        thread::sleep(Duration::from_millis(25));
    }
    let _ = child.kill();
    let _ = child.wait();
}
fn output(mut command: Command, cancel: &AtomicBool) -> Option<Vec<u8>> {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .stdin(Stdio::null())
        .spawn()
        .ok()?;
    let stdout = child.stdout.take()?;
    let reader = thread::spawn(move || {
        use std::io::Read;
        let mut bytes = Vec::new();
        let _ = stdout.take(1024 * 1024).read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let success = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break status.success();
        }
        if cancel.load(Ordering::SeqCst) || Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break false;
        }
        thread::sleep(Duration::from_millis(25));
    };
    let bytes = reader.join().ok()?;
    success.then_some(bytes)
}
fn flutter_path(sdk: &str, cancel: &AtomicBool) -> Option<PathBuf> {
    if !sdk.trim().is_empty() {
        let path = PathBuf::from(sdk.trim()).join("bin/flutter");
        return path.is_file().then_some(path);
    }
    if let Some(root) = std::env::var_os("FLUTTER_ROOT") {
        let path = PathBuf::from(root).join("bin/flutter");
        if path.is_file() {
            return Some(path);
        }
    }
    if let Some(paths) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&paths) {
            let path = directory.join("flutter");
            if path.is_file() {
                return Some(path);
            }
        }
    }
    // Finder does not inherit the terminal's PATH. No user text is interpolated.
    let mut shell = Command::new("/bin/zsh");
    shell.args(["-lc", "command -v flutter"]);
    let bytes = output(shell, cancel)?;
    let path = PathBuf::from(String::from_utf8(bytes).ok()?.trim());
    path.is_file().then_some(path)
}
fn send(child: &mut Child, id: u64, method: &str, params: Value) {
    if let Some(input) = child.stdin.as_mut() {
        let _ = writeln!(
            input,
            "{}",
            json!([{"id":id,"method":method,"params":params}])
        );
    }
}
/// Asks the VM for its identity. Dead URLs from earlier runs fail here.
fn probe_vm(uri: &str) -> Option<(i64, i64)> {
    use std::io::Read;
    let url = tauri::Url::parse(uri).ok()?;
    let address = *url.socket_addrs(|| None).ok()?.first()?;
    let limit = Some(Duration::from_secs(2));
    let mut stream = std::net::TcpStream::connect_timeout(&address, Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(limit).ok()?;
    stream.set_write_timeout(limit).ok()?;
    write!(
        stream,
        "GET {}getVM HTTP/1.0\r\nHost: {address}\r\nConnection: close\r\n\r\n",
        url.path()
    )
    .ok()?;
    let mut response = Vec::new();
    stream.take(1024 * 1024).read_to_end(&mut response).ok()?;
    let start = response.windows(4).position(|w| w == b"\r\n\r\n")? + 4;
    let vm: Value = serde_json::from_slice(&response[start..]).ok()?;
    Some((
        vm["result"]["pid"].as_i64()?,
        vm["result"]["startTime"].as_i64()?,
    ))
}
fn add_session(state: &Mutex<Snapshot>, uri: &str, name: impl FnOnce(i64) -> String) {
    if !local_uri(uri) {
        return;
    }
    let Some(vm) = probe_vm(uri) else {
        return;
    };
    let name = name(vm.0);
    let mut s = state.lock().unwrap();
    if !s.vms.contains(&vm) {
        s.vms.push(vm);
        s.sessions.push(Session {
            name,
            uri: uri.into(),
        });
    }
}
/// Simulator apps run as Mac processes under CoreSimulator/Devices/<UDID>/.
fn simulator_name(pid: i64, cancel: &AtomicBool) -> Option<String> {
    let mut ps = Command::new("/bin/ps");
    ps.args(["-p", &pid.to_string(), "-o", "command="]);
    let command = String::from_utf8(output(ps, cancel)?).ok()?;
    let (root, rest) = command.split_once("/CoreSimulator/Devices/")?;
    let udid = rest.split('/').next()?;
    if !udid.chars().all(|c| c.is_ascii_hexdigit() || c == '-') {
        return None;
    }
    let plist = format!("{root}/CoreSimulator/Devices/{udid}/device.plist");
    let mut plutil = Command::new("/usr/bin/plutil");
    plutil.args(["-extract", "name", "raw", "-o", "-", &plist]);
    let name = String::from_utf8(output(plutil, cancel)?).ok()?;
    Some(name.trim().to_string()).filter(|name| !name.is_empty())
}
fn adb_path() -> Option<PathBuf> {
    ["ANDROID_HOME", "ANDROID_SDK_ROOT"]
        .iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .chain(std::env::var_os("HOME").map(|home| PathBuf::from(home).join("Library/Android/sdk")))
        .map(|sdk| sdk.join("platform-tools/adb"))
        .find(|path| path.is_file())
}
/// The VM reports its device-side pid, whose command line is the app's package.
fn android_package(device: &str, pid: i64, cancel: &AtomicBool) -> Option<String> {
    let mut command = Command::new(adb_path()?);
    command.args([
        "-s",
        device,
        "shell",
        "cat",
        &format!("/proc/{pid}/cmdline"),
    ]);
    let bytes = output(command, cancel)?;
    let package = String::from_utf8(bytes).ok()?;
    let package = package.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    (!package.is_empty()
        && package
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':')))
    .then(|| package.to_string())
}
fn local_uri(value: &str) -> bool {
    tauri::Url::parse(value).is_ok_and(|url| {
        matches!(url.scheme(), "http" | "https" | "ws" | "wss")
            && matches!(
                url.host_str(),
                Some("localhost" | "127.0.0.1" | "[::1]" | "::1")
            )
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none()
    })
}
/// Streams `dns-sd` output lines until `on_line` returns true, the deadline passes or the search is cancelled.
fn dns_sd(
    args: &[&str],
    cancel: &AtomicBool,
    limit: Duration,
    mut on_line: impl FnMut(&str) -> bool,
) {
    let Ok(mut child) = Command::new("/usr/bin/dns-sd")
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        return;
    };
    let (tx, rx) = mpsc::sync_channel(64);
    let stdout = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                return;
            }
        }
    });
    let deadline = Instant::now() + limit;
    while !cancel.load(Ordering::SeqCst) && Instant::now() < deadline {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(line) if on_line(&line) => break,
            Ok(_) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    drop(rx);
    let _ = reader.join();
}
/// Simulators and desktop debug apps advertise their VM Service over Bonjour on
/// the loopback interface. The Flutter daemon only reports apps it sees start,
/// so this finds sessions that were already running.
fn browse_loopback(state: &Mutex<Snapshot>, cancel: &AtomicBool) {
    const SERVICE: &str = "_dartVmService._tcp";
    let mut seen = std::collections::HashSet::new();
    dns_sd(
        &["-i", "lo0", "-B", SERVICE, "local."],
        cancel,
        Duration::from_secs(45),
        |line| {
            let Some((_, name)) = line.split_once(&format!("{SERVICE}. ")) else {
                return false;
            };
            let name = name.trim();
            if line.split_whitespace().nth(1) != Some("Add") || !seen.insert(name.to_string()) {
                return false;
            }
            let mut port = None;
            let mut code = None;
            dns_sd(
                &["-i", "lo0", "-L", name, SERVICE, "local."],
                cancel,
                Duration::from_secs(3),
                |line| {
                    if let Some((_, target)) = line.split_once("can be reached at ") {
                        port = target
                            .split(" (interface")
                            .next()
                            .and_then(|host| host.rsplit(':').next())
                            .and_then(|value| value.parse::<u16>().ok());
                    }
                    code = code.take().or_else(|| {
                        line.split_whitespace()
                            .find_map(|entry| entry.strip_prefix("authCode="))
                            .filter(|value| {
                                value.chars().all(|c| {
                                    c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '=')
                                })
                            })
                            .map(str::to_string)
                    });
                    port.is_some() && code.is_some()
                },
            );
            if let (Some(port), Some(code)) = (port, code) {
                // Bonjour renames repeat registrations "id (2)"; add_session drops duplicate VMs.
                add_session(state, &format!("http://127.0.0.1:{port}/{code}/"), |pid| {
                    let app = base_name(name);
                    simulator_name(pid, cancel)
                        .map_or_else(|| app.into(), |sim| format!("{app} · {sim}"))
                });
            }
            false
        },
    );
}
fn base_name(name: &str) -> &str {
    name.rsplit_once(" (")
        .filter(|(_, suffix)| {
            suffix
                .strip_suffix(')')
                .is_some_and(|n| !n.is_empty() && n.chars().all(|c| c.is_ascii_digit()))
        })
        .map_or(name, |(base, _)| base)
}
fn run(sdk: String, app_id: String, state: Arc<Mutex<Snapshot>>, cancel: Arc<AtomicBool>) {
    let loopback = {
        let (state, cancel) = (state.clone(), cancel.clone());
        thread::spawn(move || browse_loopback(&state, &cancel))
    };
    run_daemon(sdk, app_id, &state, &cancel);
    let _ = loopback.join();
}
fn run_daemon(sdk: String, app_id: String, state: &Mutex<Snapshot>, cancel: &AtomicBool) {
    let Some(flutter) = flutter_path(&sdk, cancel) else {
        let mut s = state.lock().unwrap();
        s.searching = false;
        s.message =
            "Flutter SDK not found. Set its folder under Options, then search again.".into();
        return;
    };
    let flutter = flutter.canonicalize().unwrap_or(flutter);
    if let Some(bin) = flutter.parent() {
        let mut command = Command::new(bin.join("cache/dart-sdk/bin/dart"));
        command.args(["tooling-daemon", "--list", "--machine"]);
        if let Some(bytes) = output(command, cancel) {
            if let Ok(Value::Array(instances)) = serde_json::from_slice::<Value>(&bytes) {
                state.lock().unwrap().dtd_uris = instances
                    .iter()
                    .filter_map(|v| v["wsUri"].as_str())
                    .filter(|uri| local_uri(uri))
                    .take(32)
                    .map(str::to_string)
                    .collect();
            }
        }
    }
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    let Ok(mut child) = Command::new(flutter)
        .args(["--no-version-check", "--suppress-analytics", "daemon"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
    else {
        let mut s = state.lock().unwrap();
        s.searching = false;
        s.message =
            "Could not start the Flutter daemon. Check the SDK folder under Options.".into();
        return;
    };
    let (tx, rx) = mpsc::sync_channel(128);
    let stdout = child.stdout.take().unwrap();
    let reader = thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if line.len() > 1024 * 1024 {
                continue;
            }
            if let Ok(Value::Array(messages)) = serde_json::from_str::<Value>(&line) {
                for message in messages {
                    if tx.send(message).is_err() {
                        return;
                    }
                }
            }
        }
    });
    send(&mut child, 1, "device.getDevices", json!({}));
    let deadline = Instant::now() + Duration::from_secs(45);
    // Device name, device id, and whether it runs Android.
    let mut pending = std::collections::HashMap::<u64, (String, String, bool)>::new();
    let mut subscriptions = std::collections::HashMap::<String, (String, String, bool)>::new();
    while !cancel.load(Ordering::SeqCst) {
        if Instant::now() >= deadline && state.lock().unwrap().searching {
            for id in subscriptions.keys() {
                send(
                    &mut child,
                    9000,
                    "device.stopVMServiceDiscoveryForAttach",
                    json!({"id":id}),
                );
            }
            let mut s = state.lock().unwrap();
            s.searching = false;
            s.message="No running apps found. Keep the app in the foreground, or set its bundle or package ID under Options.".into();
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(message) => {
                if message["id"] == 1 {
                    if let Some(devices) = message["result"].as_array() {
                        for (index, device) in devices
                            .iter()
                            .filter(|d| {
                                matches!(
                                    d["platform"].as_str(),
                                    Some(
                                        "ios"
                                            | "android-arm"
                                            | "android-arm64"
                                            | "android-x64"
                                            | "android-x86"
                                    )
                                )
                            })
                            .take(16)
                            .enumerate()
                        {
                            let Some(id) = device["id"].as_str() else {
                                continue;
                            };
                            let request_id = 100 + index as u64;
                            pending.insert(
                                request_id,
                                (
                                    device["name"].as_str().unwrap_or("Flutter device").into(),
                                    id.into(),
                                    device["platform"]
                                        .as_str()
                                        .is_some_and(|p| p.starts_with("android")),
                                ),
                            );
                            let mut params = json!({"deviceId":id});
                            if !app_id.trim().is_empty() {
                                params["appId"] = json!(app_id.trim());
                            }
                            send(
                                &mut child,
                                request_id,
                                "device.startVMServiceDiscoveryForAttach",
                                params,
                            );
                        }
                    }
                } else if let Some(id) = message["id"].as_u64() {
                    if let Some(device) = pending.remove(&id) {
                        if let Some(subscription) = message["result"].as_str() {
                            subscriptions.insert(subscription.into(), device);
                        }
                    }
                }
                if let Some(id) = message["event"]
                    .as_str()
                    .and_then(|event| event.strip_prefix("device.VMServiceDiscoveryForAttach."))
                {
                    if let (Some(uri), Some((device, device_id, android))) =
                        (message["params"].as_str(), subscriptions.get(id))
                    {
                        add_session(state, uri, |pid| {
                            android
                                .then(|| android_package(device_id, pid, cancel))
                                .flatten()
                                .map_or_else(
                                    || device.clone(),
                                    |package| format!("{package} · {device}"),
                                )
                        });
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    }
    // Keep the daemon alive after discovery: it owns any USB port forwarding.
    drop(rx);
    finish(&mut child);
    let _ = reader.join();
    let mut s = state.lock().unwrap();
    s.searching = false;
    if !cancel.load(Ordering::SeqCst) {
        s.message = "The Flutter daemon stopped. Search again, or paste the VM Service URL.".into();
    }
}
#[tauri::command]
pub fn discovery_snapshot(state: tauri::State<Discovery>) -> Snapshot {
    state.snapshot.lock().unwrap().clone()
}
#[tauri::command]
pub async fn start_discovery(
    app: tauri::AppHandle,
    sdk: String,
    app_id: String,
) -> Result<(), String> {
    use tauri::Manager;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Discovery>();
        state.stop();
        *state.snapshot.lock().unwrap() = Snapshot {
            searching: true,
            message: "Looking for running Flutter sessions…".into(),
            ..Snapshot::default()
        };
        let cancel = Arc::new(AtomicBool::new(false));
        let flag = cancel.clone();
        let snapshot = state.snapshot.clone();
        *state.worker.lock().unwrap() = Some((
            cancel,
            thread::spawn(move || run(sdk, app_id, snapshot, flag)),
        ));
    })
    .await
    .map_err(|_| "Could not start discovery.".into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn discovers_device_and_keeps_forwarder_until_cancelled() {
        use std::os::unix::fs::PermissionsExt;
        let root =
            std::env::temp_dir().join(format!("flutrace-daemon-test-{}", std::process::id()));
        std::fs::create_dir_all(root.join("bin")).unwrap();
        let executable = root.join("bin/flutter");
        // A fake VM that answers getVM; the stale URL on port 1 must be dropped.
        let vm = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = vm.local_addr().unwrap().port();
        thread::spawn(move || {
            use std::io::Read;
            for mut stream in vm.incoming().map_while(Result::ok) {
                let mut request = Vec::new();
                let mut chunk = [0; 1024];
                while !request.ends_with(b"\r\n\r\n") {
                    match stream.read(&mut chunk) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => request.extend_from_slice(&chunk[..n]),
                    }
                }
                let body = r#"{"result":{"pid":7,"startTime":1}}"#;
                let _ = write!(stream, "HTTP/1.0 200 OK\r\n\r\n{body}");
            }
        });
        std::fs::write(&executable, r##"#!/bin/sh
while IFS= read -r line; do
 case "$line" in
 *device.getDevices*) echo '[{"id":1,"result":[{"id":"test","name":"Test device","platform":"ios"}]}]' ;;
 *device.startVMServiceDiscoveryForAttach*)
 echo '[{"id":100,"result":"s1"}]'
 echo '[{"event":"device.VMServiceDiscoveryForAttach.s1","params":"http://127.0.0.1:1/old=/"}]'
 echo '[{"event":"device.VMServiceDiscoveryForAttach.s1","params":"http://127.0.0.1:PORT/a=/"}]'
 echo '[{"event":"device.VMServiceDiscoveryForAttach.s1","params":"http://127.0.0.1:PORT/b=/"}]' ;;
 *daemon.shutdown*) exit 0 ;;
 esac
done
"##.replace("PORT", &port.to_string())).unwrap();
        std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o700)).unwrap();
        let snapshot = Arc::new(Mutex::new(Snapshot {
            searching: true,
            ..Snapshot::default()
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        let state = snapshot.clone();
        let flag = cancel.clone();
        let sdk = root.to_string_lossy().to_string();
        let worker = thread::spawn(move || run_daemon(sdk, String::new(), &state, &flag));
        let deadline = Instant::now() + Duration::from_secs(3);
        while snapshot.lock().unwrap().sessions.is_empty() && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        // Give the duplicate URL time to be probed and rejected.
        thread::sleep(Duration::from_millis(300));
        let found = snapshot.lock().unwrap().sessions.len();
        let alive = !worker.is_finished();
        cancel.store(true, Ordering::SeqCst);
        worker.join().unwrap();
        std::fs::remove_dir_all(root).unwrap();
        assert_eq!(found, 1);
        assert!(alive);
        assert!(!snapshot.lock().unwrap().searching);
    }
    #[test]
    #[ignore = "requires an already running Flutter debug app and FLUTRACE_TEST_SDK"]
    fn real_daemon_probe() {
        let sdk = std::env::var("FLUTRACE_TEST_SDK").expect("SDK path required");
        let snapshot = Arc::new(Mutex::new(Snapshot {
            searching: true,
            ..Snapshot::default()
        }));
        let cancel = Arc::new(AtomicBool::new(false));
        let state = snapshot.clone();
        let flag = cancel.clone();
        let worker = thread::spawn(move || run(sdk, String::new(), state, flag));
        let deadline = Instant::now() + Duration::from_secs(57);
        while snapshot.lock().unwrap().searching && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(100));
        }
        let (counts, names) = {
            let s = snapshot.lock().unwrap();
            let names: Vec<_> = s.sessions.iter().map(|entry| entry.name.clone()).collect();
            ((s.sessions.len(), s.dtd_uris.len()), names)
        };
        println!("Sessions: {names:?}");
        cancel.store(true, Ordering::SeqCst);
        worker.join().unwrap();
        println!(
            "Discovered VM sessions: {}; DTD instances: {}",
            counts.0, counts.1
        );
        assert!(!snapshot.lock().unwrap().searching);
    }
    #[test]
    fn strips_bonjour_conflict_suffix_only() {
        assert_eq!(base_name("it.example.app (2)"), "it.example.app");
        assert_eq!(base_name("it.example.app2"), "it.example.app2");
        assert_eq!(base_name("My App (beta)"), "My App (beta)");
    }
    #[test]
    fn only_loopback_endpoints() {
        for uri in [
            "http://127.0.0.1:123/test=/",
            "ws://[::1]:123/test=/ws",
            "ws://localhost:123/a=",
        ] {
            assert!(local_uri(uri));
        }
        for uri in [
            "http://example.com/a",
            "file:///tmp/a",
            "http://user:pass@localhost/",
            "http://localhost/?uri=x",
        ] {
            assert!(!local_uri(uri));
        }
    }
}
