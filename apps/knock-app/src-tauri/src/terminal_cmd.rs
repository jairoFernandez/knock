use crate::kubeconfig_cmd::{ensure_temp, TempCache};
use base64::Engine;
use knock_core::kubeconfigs;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use rand::RngCore;
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter, State};

fn map_err<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn project_or_default(s: Option<String>) -> String {
    s.filter(|p| !p.is_empty())
        .unwrap_or_else(|| kubeconfigs::DEFAULT_PROJECT.to_string())
}

fn pass_opt(p: Option<String>) -> Option<String> {
    p.filter(|s| !s.is_empty())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[cfg(target_os = "macos")]
const MACOS_TERMINALS: &[(&str, &str)] = &[
    ("terminal", "Terminal"),
    ("iterm", "iTerm"),
    ("warp", "Warp"),
    ("ghostty", "Ghostty"),
    ("kitty", "kitty"),
    ("alacritty", "Alacritty"),
];

#[cfg(target_os = "linux")]
const LINUX_TERMINALS: &[(&str, &str)] = &[
    ("gnome-terminal", "gnome-terminal"),
    ("konsole", "konsole"),
    ("xterm", "xterm"),
    ("alacritty", "alacritty"),
    ("kitty", "kitty"),
];

#[cfg(target_os = "windows")]
const WINDOWS_TERMINALS: &[(&str, &str)] =
    &[("wt", "wt.exe"), ("pwsh", "pwsh.exe"), ("cmd", "cmd.exe")];

#[cfg(target_os = "macos")]
fn mac_app_path(name: &str) -> Option<PathBuf> {
    let sys = PathBuf::from(format!("/Applications/{name}.app"));
    if sys.exists() {
        return Some(sys);
    }
    if let Some(home) = dirs::home_dir() {
        let user = home.join("Applications").join(format!("{name}.app"));
        if user.exists() {
            return Some(user);
        }
    }
    None
}

#[cfg(target_os = "linux")]
fn which(prog: &str) -> Option<PathBuf> {
    let out = Command::new("which").arg(prog).output().ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

#[cfg(target_os = "windows")]
fn which_win(prog: &str) -> Option<PathBuf> {
    // CREATE_NO_WINDOW: without it every probe flashes a console window in a
    // windows_subsystem = "windows" build.
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = Command::new("where")
        .arg(prog)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if s.is_empty() {
        None
    } else {
        Some(PathBuf::from(s))
    }
}

fn terminal_available(id: &str) -> bool {
    #[cfg(target_os = "macos")]
    {
        match id {
            "terminal" => mac_app_path("Terminal").is_some(),
            "iterm" => mac_app_path("iTerm").is_some(),
            "warp" => mac_app_path("Warp").is_some(),
            "ghostty" => mac_app_path("Ghostty").is_some(),
            "kitty" => mac_app_path("kitty").is_some(),
            "alacritty" => mac_app_path("Alacritty").is_some(),
            _ => false,
        }
    }
    #[cfg(target_os = "linux")]
    {
        which(id).is_some()
    }
    #[cfg(target_os = "windows")]
    {
        match id {
            "wt" => which_win("wt.exe").is_some(),
            "pwsh" => which_win("pwsh.exe").is_some(),
            "cmd" => true,
            _ => false,
        }
    }
}

fn detect_terminal() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED
        .get_or_init(|| {
            #[cfg(target_os = "macos")]
            {
                for (id, _) in MACOS_TERMINALS {
                    if terminal_available(id) && *id != "terminal" {
                        return (*id).to_string();
                    }
                }
                return "terminal".to_string();
            }
            #[cfg(target_os = "linux")]
            {
                for (id, _) in LINUX_TERMINALS {
                    if terminal_available(id) {
                        return (*id).to_string();
                    }
                }
                return "xterm".to_string();
            }
            #[cfg(target_os = "windows")]
            {
                for (id, _) in WINDOWS_TERMINALS {
                    if terminal_available(id) {
                        return (*id).to_string();
                    }
                }
                return "cmd".to_string();
            }
        })
        .as_str()
}

#[tauri::command]
pub fn kubeconfig_list_terminals() -> Vec<TerminalInfo> {
    let mut out = Vec::new();
    out.push(TerminalInfo {
        id: "auto".to_string(),
        label: format!("Auto-detect ({})", detect_terminal()),
        available: true,
    });
    #[cfg(target_os = "macos")]
    {
        for (id, label) in MACOS_TERMINALS {
            out.push(TerminalInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
                available: terminal_available(id),
            });
        }
    }
    #[cfg(target_os = "linux")]
    {
        for (id, label) in LINUX_TERMINALS {
            out.push(TerminalInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
                available: terminal_available(id),
            });
        }
    }
    #[cfg(target_os = "windows")]
    {
        for (id, label) in WINDOWS_TERMINALS {
            out.push(TerminalInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
                available: terminal_available(id),
            });
        }
    }
    out
}

#[cfg(unix)]
fn shell_quote(s: &str) -> String {
    if s.chars()
        .all(|c| c.is_ascii_alphanumeric() || "-_./:=".contains(c))
    {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', "'\\''"))
    }
}

#[cfg(unix)]
fn write_unix_launcher(
    store_dir: &Path,
    project: &str,
    name: &str,
    kubeconfig_path: &Path,
    ext: &str,
) -> Result<PathBuf, String> {
    let tmp = store_dir.join("tmp");
    std::fs::create_dir_all(&tmp).map_err(map_err)?;
    let mut nonce = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut nonce);
    let suffix = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, nonce);
    let path = tmp.join(format!("launch-{project}-{name}.{suffix}.{ext}"));
    let script = format!(
        "#!/usr/bin/env bash\nexport KUBECONFIG={path}\ncd \"$HOME\"\nclear\necho \"KUBECONFIG=$KUBECONFIG (knock)\"\nexec \"${{SHELL:-/bin/bash}}\" -l\n",
        path = shell_quote(&kubeconfig_path.to_string_lossy())
    );
    std::fs::write(&path, script).map_err(map_err)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700));
    }
    Ok(path)
}

#[cfg(target_os = "windows")]
fn write_windows_launcher(
    store_dir: &Path,
    project: &str,
    name: &str,
    kubeconfig_path: &Path,
) -> Result<PathBuf, String> {
    let tmp = store_dir.join("tmp");
    std::fs::create_dir_all(&tmp).map_err(map_err)?;
    let mut nonce = [0u8; 6];
    rand::thread_rng().fill_bytes(&mut nonce);
    let suffix = base64::Engine::encode(&base64::engine::general_purpose::URL_SAFE_NO_PAD, nonce);
    let path = tmp.join(format!("launch-{project}-{name}.{suffix}.cmd"));
    let kpath = kubeconfig_path.to_string_lossy().replace('\\', "\\\\");
    let script = format!(
        "@echo off\r\nset KUBECONFIG={kpath}\r\ncd /d %USERPROFILE%\r\ncls\r\necho KUBECONFIG=%KUBECONFIG% (knock)\r\ncmd /k\r\n"
    );
    std::fs::write(&path, script).map_err(map_err)?;
    Ok(path)
}

#[tauri::command]
pub fn kubeconfig_open_terminal(
    cache: State<'_, TempCache>,
    name: String,
    project: Option<String>,
    passphrase: Option<String>,
    terminal: Option<String>,
) -> Result<String, String> {
    let project = project_or_default(project);
    let pass = pass_opt(passphrase);
    let store_dir = kubeconfigs::default_store_dir().map_err(map_err)?;

    let kubeconfig_path = ensure_temp(&cache, &name, &project, pass.as_deref())?;

    // Resolve terminal id
    let requested = terminal
        .filter(|s| !s.is_empty() && s != "auto")
        .unwrap_or_else(|| {
            kubeconfigs::read_settings(&store_dir)
                .map(|s| s.preferred_terminal)
                .unwrap_or_else(|_| "auto".to_string())
        });
    let term_id: String = if requested == "auto" || requested.is_empty() {
        detect_terminal().to_string()
    } else {
        requested
    };

    spawn_terminal(
        &store_dir,
        &project,
        &name,
        &kubeconfig_path,
        &term_id,
        &cache,
    )?;
    Ok(term_id)
}

#[cfg(target_os = "macos")]
fn spawn_terminal(
    store_dir: &Path,
    project: &str,
    name: &str,
    kubeconfig_path: &Path,
    term_id: &str,
    cache: &TempCache,
) -> Result<(), String> {
    let app = match term_id {
        "iterm" => Some("iTerm"),
        "warp" => Some("Warp"),
        "ghostty" => Some("Ghostty"),
        "kitty" => Some("kitty"),
        "terminal" => Some("Terminal"),
        "alacritty" => None, // handled specially below
        _ => Some("Terminal"),
    };

    if term_id == "alacritty" {
        // Alacritty doesn't honor `.command`; spawn it directly to exec a shell with the env set.
        let kpath = kubeconfig_path.to_string_lossy().to_string();
        let bin = mac_app_path("Alacritty")
            .map(|p| p.join("Contents/MacOS/alacritty"))
            .filter(|p| p.exists());
        let mut cmd = match bin {
            Some(b) => Command::new(b),
            None => Command::new("alacritty"),
        };
        cmd.env("KUBECONFIG", &kpath)
            .arg("-e")
            .arg(std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string()))
            .arg("-l");
        cmd.spawn().map_err(map_err)?;
        return Ok(());
    }

    let script = write_unix_launcher(store_dir, project, name, kubeconfig_path, "command")?;
    cache.register_aux(script.clone());
    let mut cmd = Command::new("open");
    if let Some(app) = app {
        cmd.arg("-a").arg(app);
    }
    cmd.arg(&script);
    cmd.spawn().map_err(map_err)?;
    Ok(())
}

#[cfg(target_os = "linux")]
fn spawn_terminal(
    store_dir: &Path,
    project: &str,
    name: &str,
    kubeconfig_path: &Path,
    term_id: &str,
    cache: &TempCache,
) -> Result<(), String> {
    let script = write_unix_launcher(store_dir, project, name, kubeconfig_path, "sh")?;
    cache.register_aux(script.clone());
    let mut cmd = match term_id {
        "gnome-terminal" => {
            let mut c = Command::new("gnome-terminal");
            c.arg("--").arg("bash").arg(&script);
            c
        }
        "konsole" => {
            let mut c = Command::new("konsole");
            c.arg("-e").arg("bash").arg(&script);
            c
        }
        "xterm" => {
            let mut c = Command::new("xterm");
            c.arg("-e").arg("bash").arg(&script);
            c
        }
        "alacritty" => {
            let mut c = Command::new("alacritty");
            c.arg("-e").arg("bash").arg(&script);
            c
        }
        "kitty" => {
            let mut c = Command::new("kitty");
            c.arg("bash").arg(&script);
            c
        }
        _ => {
            let mut c = Command::new("xterm");
            c.arg("-e").arg("bash").arg(&script);
            c
        }
    };
    cmd.spawn().map_err(map_err)?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn spawn_terminal(
    store_dir: &Path,
    project: &str,
    name: &str,
    kubeconfig_path: &Path,
    term_id: &str,
    cache: &TempCache,
) -> Result<(), String> {
    let script = write_windows_launcher(store_dir, project, name, kubeconfig_path)?;
    cache.register_aux(script.clone());
    let script_str = script.to_string_lossy().to_string();
    let mut cmd = match term_id {
        "wt" => {
            let mut c = Command::new("wt.exe");
            c.arg("cmd").arg("/k").arg(&script_str);
            c
        }
        "pwsh" => {
            let mut c = Command::new("cmd");
            c.arg("/c")
                .arg("start")
                .arg("pwsh")
                .arg("-NoExit")
                .arg("-File")
                .arg(&script_str);
            c
        }
        _ => {
            let mut c = Command::new("cmd");
            c.arg("/c")
                .arg("start")
                .arg("cmd")
                .arg("/k")
                .arg(&script_str);
            c
        }
    };
    cmd.spawn().map_err(map_err)?;
    Ok(())
}

// ============================================================================
// Embedded PTY sessions
// ============================================================================

pub struct PtySession {
    pub child: Box<dyn Child + Send + Sync>,
    pub master: Box<dyn MasterPty + Send>,
    pub writer: Box<dyn Write + Send>,
}

#[derive(Default, Clone)]
pub struct TerminalSessions {
    pub map: Arc<Mutex<HashMap<String, PtySession>>>,
}

impl TerminalSessions {
    pub fn kill_all(&self) {
        if let Ok(mut m) = self.map.lock() {
            for (_, mut sess) in m.drain() {
                let _ = sess.child.kill();
            }
        }
    }
}

fn default_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        if !s.is_empty() {
            return s;
        }
    }
    #[cfg(target_os = "macos")]
    {
        "/bin/zsh".to_string()
    }
    #[cfg(target_os = "linux")]
    {
        "/bin/bash".to_string()
    }
    #[cfg(target_os = "windows")]
    {
        std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string())
    }
}

/// A shell the embedded PTY can launch. `id` is a stable key; the backend maps
/// it to a concrete program + args in `shell_command`.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub label: String,
    pub available: bool,
}

#[cfg(windows)]
fn windows_git_bash() -> Option<PathBuf> {
    // git-bash ships bash.exe under <Git>\bin\bash.exe. Probe PATH then the
    // standard install locations.
    if let Some(p) = which_win("bash.exe") {
        return Some(p);
    }
    for base in [
        std::env::var("ProgramFiles").ok(),
        std::env::var("ProgramFiles(x86)").ok(),
        std::env::var("LocalAppData").ok(),
    ]
    .into_iter()
    .flatten()
    {
        let p = PathBuf::from(base).join("Git").join("bin").join("bash.exe");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

#[cfg(windows)]
const WINDOWS_SHELLS: &[(&str, &str)] = &[
    ("cmd", "Command Prompt"),
    ("powershell", "Windows PowerShell"),
    ("pwsh", "PowerShell 7"),
    ("git-bash", "Git Bash"),
    ("wsl", "WSL"),
];

#[cfg(unix)]
const UNIX_SHELLS: &[(&str, &str)] = &[("zsh", "zsh"), ("bash", "bash"), ("fish", "fish")];

fn shell_available(id: &str) -> bool {
    #[cfg(windows)]
    {
        match id {
            "cmd" => true,
            "powershell" => which_win("powershell.exe").is_some(),
            "pwsh" => which_win("pwsh.exe").is_some(),
            "git-bash" => windows_git_bash().is_some(),
            "wsl" => which_win("wsl.exe").is_some(),
            _ => false,
        }
    }
    #[cfg(unix)]
    {
        // Probe both common bin dirs without requiring `which`.
        let candidates = [
            format!("/bin/{id}"),
            format!("/usr/bin/{id}"),
            format!("/usr/local/bin/{id}"),
            format!("/opt/homebrew/bin/{id}"),
        ];
        candidates.iter().any(|p| Path::new(p).exists())
    }
}

#[tauri::command]
pub fn terminal_list_shells() -> Vec<ShellInfo> {
    let mut out = vec![ShellInfo {
        id: "auto".to_string(),
        label: "Default shell".to_string(),
        available: true,
    }];
    #[cfg(windows)]
    {
        for (id, label) in WINDOWS_SHELLS {
            out.push(ShellInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
                available: shell_available(id),
            });
        }
    }
    #[cfg(unix)]
    {
        for (id, label) in UNIX_SHELLS {
            out.push(ShellInfo {
                id: (*id).to_string(),
                label: (*label).to_string(),
                available: shell_available(id),
            });
        }
    }
    out
}

/// Build the `(program, args)` for a requested shell id. Falls back to the
/// platform default when `id` is "auto"/empty/unknown or the shell is missing.
fn shell_command(id: &str) -> (String, Vec<String>) {
    let id = id.trim();
    #[cfg(windows)]
    {
        match id {
            "powershell" if shell_available("powershell") => {
                ("powershell.exe".to_string(), vec!["-NoLogo".to_string()])
            }
            "pwsh" if shell_available("pwsh") => {
                ("pwsh.exe".to_string(), vec!["-NoLogo".to_string()])
            }
            "git-bash" => {
                if let Some(bash) = windows_git_bash() {
                    return (bash.to_string_lossy().to_string(), vec!["-l".to_string()]);
                }
                (default_shell(), vec![])
            }
            "wsl" if shell_available("wsl") => ("wsl.exe".to_string(), vec![]),
            "cmd" => (
                std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string()),
                vec![],
            ),
            _ => (default_shell(), vec![]),
        }
    }
    #[cfg(unix)]
    {
        let login = vec!["-l".to_string()];
        match id {
            "zsh" if shell_available("zsh") => ("zsh".to_string(), login),
            "bash" if shell_available("bash") => ("bash".to_string(), login),
            "fish" if shell_available("fish") => ("fish".to_string(), vec!["-l".to_string()]),
            _ => {
                let sh = default_shell();
                let args = if sh.ends_with("zsh") || sh.ends_with("bash") {
                    vec!["-l".to_string()]
                } else {
                    vec![]
                };
                (sh, args)
            }
        }
    }
}

// Terminal commands are async so they run on Tauri's async runtime instead of
// the main thread: ConPTY spawn/write/resize can block, and blocking the main
// thread freezes the whole window on Windows.
#[tauri::command]
pub async fn terminal_spawn(
    app: AppHandle,
    cache: State<'_, TempCache>,
    sessions: State<'_, TerminalSessions>,
    name: Option<String>,
    project: Option<String>,
    passphrase: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    shell: Option<String>,
) -> Result<String, String> {
    let kubeconfig_path = if let Some(name) = name.filter(|s| !s.is_empty()) {
        let project = project_or_default(project);
        let pass = pass_opt(passphrase);
        Some(ensure_temp(&cache, &name, &project, pass.as_deref())?)
    } else {
        None
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: rows.unwrap_or(24),
            cols: cols.unwrap_or(80),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;

    // Explicit `shell` wins; otherwise fall back to the persisted preference.
    let shell_id = shell
        .filter(|s| !s.is_empty() && s != "auto")
        .or_else(|| {
            kubeconfigs::default_store_dir()
                .ok()
                .and_then(|dir| kubeconfigs::read_settings(&dir).ok())
                .map(|s| s.preferred_shell)
                .filter(|s| !s.is_empty() && s != "auto")
        })
        .unwrap_or_else(|| "auto".to_string());
    let (program, args) = shell_command(&shell_id);
    let mut cmd = CommandBuilder::new(&program);
    for a in &args {
        cmd.arg(a);
    }
    if let Some(kubeconfig_path) = kubeconfig_path {
        cmd.env("KUBECONFIG", &kubeconfig_path);
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    cmd.env(
        "LANG",
        std::env::var("LANG").unwrap_or_else(|_| "en_US.UTF-8".to_string()),
    );
    if let Some(cwd) = cwd.filter(|s| !s.is_empty()) {
        cmd.cwd(cwd);
    } else if let Some(home) = dirs::home_dir() {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;

    let session_id = uuid::Uuid::new_v4().to_string();
    let event_name = format!("terminal:data:{}", session_id);
    let exit_event = format!("terminal:exit:{}", session_id);

    {
        let mut map = sessions.map.lock().map_err(|e| e.to_string())?;
        map.insert(
            session_id.clone(),
            PtySession {
                child,
                master: pair.master,
                writer,
            },
        );
    }

    let app_for_reader = app.clone();
    let id_for_reader = session_id.clone();
    let sessions_for_reader = sessions.map.clone();
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: PTY closed, process tree exited
                Ok(n) => {
                    let chunk = base64::engine::general_purpose::STANDARD.encode(&buf[..n]);
                    let _ = app_for_reader.emit(&event_name, chunk);
                }
                // Transient errors must NOT kill the stream. On Windows ConPTY a
                // chatty process (e.g. `next start` flooding logs) can surface
                // Interrupted/WouldBlock/spurious errors mid-stream; breaking here
                // froze the terminal. Retry on those; only a true disconnect ends it.
                Err(e) => match e.kind() {
                    std::io::ErrorKind::Interrupted => continue,
                    std::io::ErrorKind::WouldBlock => {
                        // Reader is blocking by default; if the OS ever returns
                        // this, sleep to avoid a busy spin.
                        std::thread::sleep(std::time::Duration::from_millis(5));
                        continue;
                    }
                    std::io::ErrorKind::BrokenPipe | std::io::ErrorKind::UnexpectedEof => break,
                    _ => {
                        // Unknown error: yield briefly and retry rather than
                        // tearing down a live session.
                        std::thread::sleep(std::time::Duration::from_millis(10));
                        continue;
                    }
                },
            }
        }
        let _ = app_for_reader.emit(&exit_event, ());
        if let Ok(mut m) = sessions_for_reader.lock() {
            m.remove(&id_for_reader);
        }
    });

    Ok(session_id)
}

#[tauri::command]
pub async fn terminal_write(
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let mut map = sessions.map.lock().map_err(|e| e.to_string())?;
    let sess = map
        .get_mut(&session_id)
        .ok_or_else(|| "unknown session".to_string())?;
    sess.writer.write_all(data.as_bytes()).map_err(map_err)?;
    sess.writer.flush().map_err(map_err)?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_resize(
    sessions: State<'_, TerminalSessions>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let map = sessions.map.lock().map_err(|e| e.to_string())?;
    let sess = map
        .get(&session_id)
        .ok_or_else(|| "unknown session".to_string())?;
    sess.master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(
    sessions: State<'_, TerminalSessions>,
    session_id: String,
) -> Result<(), String> {
    let mut map = sessions.map.lock().map_err(|e| e.to_string())?;
    if let Some(mut sess) = map.remove(&session_id) {
        let _ = sess.child.kill();
    }
    Ok(())
}
