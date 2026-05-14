mod commands;
mod recents;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            commands::init_workspace,
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
            commands::list_recents,
            commands::forget_recent,
            commands::create_entry,
            commands::delete_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
