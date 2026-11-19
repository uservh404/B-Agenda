mod offline_identity;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      offline_identity::save_offline_identity,
      offline_identity::load_offline_identity,
      offline_identity::clear_offline_identity,
    ])
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
