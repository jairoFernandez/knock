mod commands;

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
            commands::read_file,
            commands::write_file,
            commands::run_request,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
