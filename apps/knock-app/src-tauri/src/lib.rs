pub mod commands;
mod kubeconfig_cmd;
mod openapi_cmd;
mod recents;
mod terminal_cmd;

use std::time::{Duration, SystemTime};
use tauri::{Manager, RunEvent};

use kubeconfig_cmd::TempCache;
use terminal_cmd::TerminalSessions;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(TempCache::default())
        .manage(TerminalSessions::default())
        .setup(|app| {
            sweep_stale_tmp_files();
            #[cfg(target_os = "macos")]
            if let Some(win) = app.get_webview_window("main") {
                use tauri::TitleBarStyle;
                let _ = win.set_decorations(true);
                let _ = win.set_title_bar_style(TitleBarStyle::Overlay);
                let _ = win.set_title("");
                apply_macos_titlebar_color(&win);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::init_workspace,
            commands::init_example_workspace,
            commands::open_workspace,
            commands::list_tree,
            commands::list_envs,
            commands::set_env,
            commands::get_env_vars,
            commands::read_file,
            commands::write_file,
            commands::parse_request_form,
            commands::save_request_form,
            commands::run_request,
            commands::load_history,
            commands::clear_history,
            commands::list_recents,
            commands::forget_recent,
            commands::create_entry,
            commands::delete_entry,
            commands::rename_entry,
            commands::create_folder,
            commands::delete_folder,
            commands::list_directories,
            commands::get_colors,
            commands::set_color,
            commands::list_files,
            commands::git_log,
            commands::git_show_files,
            commands::git_diff,
            commands::git_status,
            commands::git_state,
            commands::git_stage,
            commands::git_unstage,
            commands::git_stage_all,
            commands::git_commit,
            commands::git_remotes,
            commands::git_add_remote,
            commands::open_in_file_manager,
            commands::open_terminal,
            commands::open_url,
            commands::set_workspace_appearance,
            commands::set_folder_order,
            commands::list_folder_orders,
            commands::update_request_method,
            commands::update_request_name,
            commands::get_system_stats,
            commands::version_info,
            openapi_cmd::openapi_fetch,
            openapi_cmd::openapi_preview_import,
            openapi_cmd::openapi_apply_import,
            openapi_cmd::openapi_get_meta,
            openapi_cmd::openapi_read_spec,
            openapi_cmd::openapi_save_spec,
            openapi_cmd::openapi_list_history,
            kubeconfig_cmd::kubeconfig_store_dir,
            kubeconfig_cmd::kubeconfig_list,
            kubeconfig_cmd::kubeconfig_list_projects,
            kubeconfig_cmd::kubeconfig_add,
            kubeconfig_cmd::kubeconfig_read_path,
            kubeconfig_cmd::kubeconfig_is_encrypted,
            kubeconfig_cmd::kubeconfig_get,
            kubeconfig_cmd::kubeconfig_remove,
            kubeconfig_cmd::kubeconfig_export_temp,
            kubeconfig_cmd::kubeconfig_settings_get,
            kubeconfig_cmd::kubeconfig_settings_set,
            terminal_cmd::kubeconfig_list_terminals,
            terminal_cmd::kubeconfig_open_terminal,
            terminal_cmd::terminal_spawn,
            terminal_cmd::terminal_write,
            terminal_cmd::terminal_resize,
            terminal_cmd::terminal_kill,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(sessions) = app_handle.try_state::<TerminalSessions>() {
                sessions.kill_all();
            }
            if let Some(cache) = app_handle.try_state::<TempCache>() {
                cleanup_temp_files(&cache);
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_macos_titlebar_color(win: &tauri::WebviewWindow) {
    use cocoa::appkit::{NSColor, NSWindow};
    use cocoa::base::{id, nil};
    use objc::{msg_send, sel, sel_impl};

    let Ok(ns_window_ptr) = win.ns_window() else {
        return;
    };
    let ns_window = ns_window_ptr as id;
    if ns_window.is_null() {
        return;
    }
    unsafe {
        // --panel #20212a
        let bg = NSColor::colorWithRed_green_blue_alpha_(
            nil,
            0x20 as f64 / 255.0,
            0x21 as f64 / 255.0,
            0x2a as f64 / 255.0,
            1.0,
        );
        ns_window.setBackgroundColor_(bg);
        let _: () = msg_send![ns_window, setTitlebarAppearsTransparent: true];
    }
}

fn cleanup_temp_files(cache: &TempCache) {
    let (temps, aux) = cache.drain_all();
    for p in temps.into_iter().chain(aux.into_iter()) {
        let _ = std::fs::remove_file(&p);
    }
}

/// Best-effort: at startup, remove leftover tmp files older than 24h from
/// `<store_dir>/tmp/`. Covers crashes / SIGKILL where RunEvent::Exit didn't fire.
fn sweep_stale_tmp_files() {
    let Ok(dir) = knock_core::kubeconfigs::default_store_dir() else {
        return;
    };
    let tmp_dir = dir.join("tmp");
    let Ok(read) = std::fs::read_dir(&tmp_dir) else {
        return;
    };
    let now = SystemTime::now();
    let cutoff = Duration::from_secs(24 * 60 * 60);
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let Ok(modified) = meta.modified() else {
            continue;
        };
        if now.duration_since(modified).unwrap_or(Duration::ZERO) > cutoff {
            let _ = std::fs::remove_file(entry.path());
        }
    }
}
